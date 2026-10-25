import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LockBusyError, processIsAlive, withStaleAwareLock } from "./fs-lock.js";

const REGISTRY_FILE = ".omp-fest-reservations.json";
const LOCK_DIR = ".omp-fest-reservations.lock";
const LOCK_BUSY_MS = 2_000;
/** A reservation row older than this without a live owner pid is orphaned. */
const ORPHAN_ROW_MS = 60 * 60_000;

export interface ProjectReservationRequest {
  sessionId: string;
  assignmentId: string;
  /** Exact target file paths relative to the supplied working directory, or absolute. */
  files: string[];
  festival?: string;
  task?: string;
  worker?: string;
}

export interface ProjectReservation extends ProjectReservationRequest {
  projectDir: string;
  reservedAt: string;
  /** Process that holds the reservation; lets stale rows be reclaimed after a crash. */
  pid?: number;
  host?: string;
}

export interface ProjectReservationIdentity {
  sessionId: string;
  assignmentId: string;
}

export interface NativeWriteLock {
  projectDir: string;
  sessionId: string;
  assignmentId: string;
}

/** Correlates a reservation set with one host tool execution. */
export class NativeWriteLockInvocations {
  private readonly pending = new Map<string, NativeWriteLock[]>();

  reserve(toolCallId: string, locks: NativeWriteLock[]): void {
    if (!toolCallId) throw new Error("A native tool invocation ID is required for write locks.");
    if (this.pending.has(toolCallId)) throw new Error(`Write locks already belong to native invocation ${toolCallId}.`);
    this.pending.set(toolCallId, locks);
  }

  settle(toolCallId: string): NativeWriteLock[] | undefined {
    const locks = this.pending.get(toolCallId);
    if (locks) this.pending.delete(toolCallId);
    return locks;
  }
}

export type ProjectConflictResult =
  | { kind: "clear" }
  | { kind: "conflict"; conflicts: ProjectReservation[] }
  | { kind: "busy" };

export type ProjectReservationResult =
  | { kind: "reserved"; reservation: ProjectReservation }
  | { kind: "conflict"; conflicts: ProjectReservation[] }
  | { kind: "busy" };

export type ProjectReleaseResult =
  | { kind: "released"; released: boolean }
  | { kind: "busy" };

interface Registry {
  version: 1;
  projectDir: string;
  reservations: ProjectReservation[];
}

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun", "deno"]);
const INSTALL_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "dedupe", "up", "update"]);
/** Flags on env wrappers (mise/fnm/asdf exec, npx, bunx) that consume a following value word. */
const WRAPPER_VALUE_FLAGS = new Set(["-t", "--tool", "-j", "--jobs", "-w", "--cwd", "--env", "-e", "-u", "--using", "--cd"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function splitShellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index] ?? "";
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) { if (current) words.push(current); current = ""; continue; }
    if (/[<>`$()\\\n]/.test(ch)) return undefined;
    if (ch === "&" || ch === "|" || ch === ";") {
      if (current) { words.push(current); current = ""; }
      const next = command[index + 1];
      if ((ch === "&" || ch === "|") && next === ch) { words.push(ch + ch); index += 1; }
      else words.push(ch);
      continue;
    }
    current += ch;
  }
  if (quote) return undefined;
  if (current) words.push(current);
  return words;
}

function pmBinary(word: string | undefined): string | undefined {
  return word?.replace(/^.*\//, "").replace(/\.(?:cmd|exe|bat|ps1|cjs|mjs|js)$/, "");
}
function isPackageManager(word: string | undefined): boolean {
  return word !== undefined && PACKAGE_MANAGERS.has(pmBinary(word) ?? "");
}

/**
 * Parse a package-manager install invocation of any supported form:
 * optional `cd <dir> &&`, optional env assignments and wrappers
 * (env, corepack, `mise|fnm|asdf|direnv exec`, npx, bunx), then
 * `pnpm|npm|yarn|bun|deno` with an install-family subcommand plus any
 * flags/args. Bare `yarn` also counts (it means `yarn install`).
 * Anything else returns undefined so the shell-mutation guard stays on.
 */
export function parseSupportedPackageInstall(command: string): { workingDirectory?: string } | undefined {
  const words = splitShellWords(command.trim());
  if (!words || words.length === 0) return undefined;
  let index = 0;
  let workingDirectory: string | undefined;
  if (words[0] === "cd" && words.length >= 4 && words[2] === "&&") {
    workingDirectory = words[1];
    index = 3;
  }
  const skipToPm = (): boolean => {
    for (;;) {
      const word = words[index];
      if (word === undefined) return false;
      if (word === "--") { index += 1; return true; }
      if (isPackageManager(word)) return true;
      if (ENV_ASSIGNMENT.test(word) || word === "env" || word === "corepack") { index += 1; continue; }
      if (WRAPPER_VALUE_FLAGS.has(word)) { index += 2; continue; }
      if (word.startsWith("-")) { index += 1; continue; }
      return false;
    }
  };
  for (let hops = 0; hops < 8; hops += 1) {
    const word = words[index];
    if (word === undefined) return undefined;
    if (word === "--" || word === "env" || word === "corepack" || ENV_ASSIGNMENT.test(word)) { index += 1; continue; }
    if (word === "npx" || word === "bunx") { index += 1; if (!skipToPm()) return undefined; continue; }
    if ((word === "mise" || word === "fnm" || word === "asdf" || word === "direnv") &&
        (words[index + 1] === "exec" || words[index + 1] === "x")) {
      index += 2;
      // direnv exec takes a directory argument before the command.
      if (word === "direnv" && !isPackageManager(words[index]) && words[index] !== "--") {
        const dirArg = words[index];
        if (!dirArg || dirArg.startsWith("-")) return undefined;
        index += 1;
      }
      if (!skipToPm()) return undefined;
      continue;
    }
    break;
  }
  const pm = pmBinary(words[index]);
  if (!pm || !PACKAGE_MANAGERS.has(pm)) return undefined;
  const sub = words[index + 1];
  if (sub === undefined) return pm === "yarn" ? (workingDirectory ? { workingDirectory } : {}) : undefined;
  if (sub.startsWith("-") || !INSTALL_SUBCOMMANDS.has(sub)) return undefined;
  // No shell separator may hide after the install arguments.
  if (words.slice(index + 2).some((word) => word === "&&" || word === "||" || word === ";" || word === "|" || word === "&")) {
    return undefined;
  }
  return workingDirectory ? { workingDirectory } : {};
}

/** Extract file targets of `>`/`>>` redirects so the guard can tell checkout writes from /tmp noise. */
export function shellRedirectTargets(command: string): string[] {
  const targets: string[] = [];
  const pattern = /(?:^|[^<>&0-9])\d?>{1,2}\s*([^\s;|&><]+)/g;
  for (const match of command.matchAll(pattern)) {
    const target = match[1]?.replace(/^['"]|['"]$/g, "");
    if (target && !/^&\d+$/.test(target) && target !== "/dev/null") targets.push(target);
  }
  return targets;
}

function contains(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

/** Resolve existing symlink ancestors even for files that a worker has not created yet. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    try {
      if ((await lstat(path)).isSymbolicLink()) return await canonicalPath(resolve(dirname(path), await readlink(path)));
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
    }
    return join(await canonicalPath(parent), relative(parent, path));
  }
}

/** Nested working directories share their checkout root; linked worktrees stop at their own .git file. */
export async function canonicalProjectDirectory(projectDir: string): Promise<string> {
  const project = await realpath(projectDir);
  if (!(await stat(project)).isDirectory()) throw new Error("Project checkout must be a directory.");
  let candidate = project;
  for (;;) {
    try {
      const marker = await stat(join(candidate, ".git"));
      if (!marker.isDirectory() && !marker.isFile()) throw new Error("Project Git marker must be a directory or worktree file.");
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return project;
    candidate = parent;
  }
}
/** Find the Git checkout owning a write target; files outside a checkout have no shared lock registry. */
export async function projectRootForFile(filePath: string): Promise<string | undefined> {
  let candidate = dirname(resolve(filePath));
  for (;;) {
    try {
      await lstat(join(candidate, ".git"));
      return await canonicalProjectDirectory(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

/** Resolve an install working directory only when it belongs to a real Git checkout. */
export async function packageInstallCheckout(workingDir: string): Promise<string | undefined> {
  const actualWorkingDir = await realpath(workingDir);
  return projectRootForFile(resolve(actualWorkingDir, "package.json"));
}


async function canonicalFiles(project: string, workingDir: string, files: string[]): Promise<string[]> {
  const canonical = new Set<string>();
  for (const file of files) {
    if (!file.trim()) throw new Error("Reservation paths must not be empty; use an empty list for an unknown boundary.");
    const absolute = resolve(workingDir, file);
    if (!isAbsolute(file) && !contains(project, absolute)) throw new Error(`Reservation path is outside the project checkout: ${file}`);
    const path = await canonicalPath(absolute);
    if (!contains(project, path)) throw new Error(`Reservation symlink escapes the project checkout: ${file}`);
    canonical.add(relative(project, path).split(sep).join("/") || ".");
  }
  return [...canonical].sort();
}

function overlaps(left: string[], right: string[]): boolean {
  return left.length === 0 || right.length === 0 || left.some((a) => right.some((b) =>
    a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}

function sameIdentity(left: ProjectReservationIdentity, right: ProjectReservationIdentity): boolean {
  return left.sessionId === right.sessionId && left.assignmentId === right.assignmentId;
}

function validateIdentity(identity: ProjectReservationIdentity): void {
  if (!identity.sessionId.trim() || !identity.assignmentId.trim()) throw new Error("Session and assignment IDs are required for a project reservation.");
}

/** Git checkout runtime state stays in its private git directory, never in commits. */
async function registryDirectory(project: string): Promise<string> {
  const marker = join(project, ".git");
  const info = await lstat(marker).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return project;
  if (info.isSymbolicLink()) throw new Error("Git metadata must not be a symlink");
  let gitDir = marker;
  if (info.isFile()) {
    const text = await readFile(marker, "utf8");
    const path = /^gitdir:\s*(.+)\s*$/m.exec(text)?.[1]?.trim();
    if (!path) throw new Error("Invalid worktree git directory marker");
    gitDir = await realpath(resolve(project, path));
  } else if (!info.isDirectory()) throw new Error("Invalid Git metadata directory");
  const directory = join(gitDir, "omp-fest");
  await mkdir(directory).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  const entry = await lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe project reservation directory");
  return directory;
}

async function readRegistry(project: string): Promise<Registry> {
  let text: string;
  try {
    text = await readFile(join(await registryDirectory(project), REGISTRY_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, projectDir: project, reservations: [] };
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object") throw new Error("Project reservation registry is invalid.");
  const registry = parsed as Partial<Registry>;
  if (registry.version !== 1 || registry.projectDir !== project || !Array.isArray(registry.reservations)) {
    throw new Error("Project reservation registry is invalid or belongs to another checkout.");
  }
  const identities = new Set<string>();
  for (const value of registry.reservations as unknown[]) {
    if (!value || typeof value !== "object") throw new Error("Project reservation record is invalid.");
    const row = value as Partial<ProjectReservation>;
    if (row.projectDir !== project || typeof row.sessionId !== "string" || !row.sessionId.trim() ||
        typeof row.assignmentId !== "string" || !row.assignmentId.trim() || typeof row.reservedAt !== "string" || !row.reservedAt ||
        !Array.isArray(row.files) || !row.files.every((file: unknown) => typeof file === "string" && file.length > 0 &&
          !isAbsolute(file) && contains(project, resolve(project, file)) && file === (relative(project, resolve(project, file)).split(sep).join("/") || ".")) ||
        [row.festival, row.task, row.worker].some((field) => field !== undefined && typeof field !== "string") ||
        (row.pid !== undefined && (typeof row.pid !== "number" || !Number.isInteger(row.pid))) ||
        (row.host !== undefined && typeof row.host !== "string")) {
      throw new Error("Project reservation record is invalid; refusing to discard its boundary.");
    }
    const key = JSON.stringify([row.sessionId, row.assignmentId]);
    if (identities.has(key)) throw new Error("Project reservation registry contains duplicate assignment identities.");
    identities.add(key);
  }
  return registry as Registry;
}

async function writeRegistry(project: string, registry: Registry): Promise<void> {
  const directory = await registryDirectory(project);
  const temporary = join(directory, `${REGISTRY_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(registry)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, join(directory, REGISTRY_FILE));
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Rows whose recorded owner process is dead, or too old to still be held, are orphans. */
function sweepDeadReservations(registry: Registry): Registry | undefined {
  const host = hostname();
  const now = Date.now();
  const live = registry.reservations.filter((row) => {
    if (row.pid !== undefined && row.host === host && !processIsAlive(row.pid)) return false;
    if (Date.parse(row.reservedAt) < now - ORPHAN_ROW_MS) return false;
    return true;
  });
  return live.length === registry.reservations.length ? undefined : { ...registry, reservations: live };
}

async function withProjectLock<T>(project: string, action: () => Promise<T>): Promise<T | undefined> {
  const lock = join(await registryDirectory(project), LOCK_DIR);
  try {
    return await withStaleAwareLock(lock, action, { label: "write-lock registry", busyMs: LOCK_BUSY_MS, staleMs: 30_000 });
  } catch (error) {
    if (error instanceof LockBusyError) return undefined;
    throw error;
  }
}

/** Acquire a transient whole-checkout reservation for a bounded install operation. */
export async function reserveProjectCheckout(projectDir: string, request: ProjectReservationIdentity & Omit<ProjectReservationRequest, "files">): Promise<ProjectReservationResult> {
  validateIdentity(request);
  const project = await canonicalProjectDirectory(projectDir);
  const result = await withProjectLock(project, async (): Promise<ProjectReservationResult> => {
    const stale = sweepDeadReservations(await readRegistry(project));
    const registry = stale ?? (await readRegistry(project));
    if (stale) await writeRegistry(project, registry);
    const conflicts = registry.reservations.filter((row) => !sameIdentity(row, request));
    if (conflicts.length) return { kind: "conflict", conflicts };
    const reservation: ProjectReservation = {
      ...request,
      files: [],
      projectDir: project,
      reservedAt: new Date().toISOString(),
      pid: process.pid,
      host: hostname(),
    };
    registry.reservations.push(reservation);
    await writeRegistry(project, registry);
    return { kind: "reserved", reservation };
  });
  return result ?? { kind: "busy" };
}

/** Acquire exact file locks immediately before an omp write tool executes. */
export async function reserveProjectFiles(projectDir: string, request: ProjectReservationRequest): Promise<ProjectReservationResult> {
  validateIdentity(request);
  const project = await canonicalProjectDirectory(projectDir);
  const result = await withProjectLock(project, async (): Promise<ProjectReservationResult> => {
    const files = await canonicalFiles(project, await realpath(projectDir), request.files);
    if (!files.length || files.some((file) => file === ".")) throw new Error("A write lock requires exact target file paths; whole-checkout and directory locks are not allowed.");
    for (const file of files) {
      const info = await stat(join(project, file)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (info?.isDirectory()) throw new Error(`A write lock must target a file, not a directory: ${file}`);
    }
    const stale = sweepDeadReservations(await readRegistry(project));
    const registry = stale ?? (await readRegistry(project));
    if (stale) await writeRegistry(project, registry);
    const existing = registry.reservations.find((row) => sameIdentity(row, request));
    if (existing && (existing.files.length !== files.length || existing.files.some((file, index) => file !== files[index]))) {
      throw new Error("An existing reservation boundary cannot change; release it explicitly before reserving again.");
    }
    const conflicts = registry.reservations.filter((row) => !sameIdentity(row, request) && overlaps(row.files, files));
    if (conflicts.length) return { kind: "conflict", conflicts };
    if (existing) return { kind: "reserved", reservation: existing };
    const reservation: ProjectReservation = {
      ...request,
      files,
      projectDir: project,
      reservedAt: new Date().toISOString(),
      pid: process.pid,
      host: hostname(),
    };
    registry.reservations.push(reservation);
    await writeRegistry(project, registry);
    return { kind: "reserved", reservation };
  });
  return result ?? { kind: "busy" };
}

/** Release this exact write lock immediately after its native tool result. */
export async function releaseProjectFiles(projectDir: string, sessionId: string, assignmentId: string): Promise<ProjectReleaseResult> {
  const identity = { sessionId, assignmentId };
  validateIdentity(identity);
  const project = await canonicalProjectDirectory(projectDir);
  const result = await withProjectLock(project, async () => {
    const registry = await readRegistry(project);
    const remaining = registry.reservations.filter((row) => !sameIdentity(row, identity));
    const released = remaining.length !== registry.reservations.length;
    if (released) await writeRegistry(project, { ...registry, reservations: remaining });
    return { kind: "released" as const, released };
  });
  return result ?? { kind: "busy" };
}

/** Read active and legacy lock records; contention and corruption fail closed. */
export async function listProjectReservations(projectDir: string): Promise<ProjectReservation[]> {
  const project = await canonicalProjectDirectory(projectDir);
  const result = await withProjectLock(project, async () => (await readRegistry(project)).reservations);
  if (!result) throw new Error("Write-lock registry is busy; retry after the current file operation.");
  return result;
}

/** Drop reservation rows whose owning process is dead (or far too old). Returns the count removed. */
export async function sweepProjectReservations(projectDir: string): Promise<number> {
  const project = await canonicalProjectDirectory(projectDir);
  const result = await withProjectLock(project, async () => {
    const stale = sweepDeadReservations(await readRegistry(project));
    if (!stale) return 0;
    const removed = (await readRegistry(project)).reservations.length - stale.reservations.length;
    await writeRegistry(project, stale);
    return removed;
  });
  return result ?? 0;
}

/** Advisory queue check only: dispatch must still reserve atomically. */
export async function checkProjectConflicts(projectDir: string, files: string[], exclude?: ProjectReservationIdentity): Promise<ProjectConflictResult> {
  const project = await canonicalProjectDirectory(projectDir);
  const result = await withProjectLock(project, async (): Promise<ProjectConflictResult> => {
    const canonical = await canonicalFiles(project, await realpath(projectDir), files);
    const stale = sweepDeadReservations(await readRegistry(project));
    const registry = stale ?? (await readRegistry(project));
    if (stale) await writeRegistry(project, registry);
    const conflicts = registry.reservations.filter((row) => (!exclude || !sameIdentity(row, exclude)) && overlaps(row.files, canonical));
    return conflicts.length ? { kind: "conflict", conflicts } : { kind: "clear" };
  });
  return result ?? { kind: "busy" };
}
/** Human-authorized reclaim is exact-token CAS: a renewed reservation is never removed. */
export async function reclaimProjectFiles(projectDir: string, expected: ProjectReservation): Promise<ProjectReleaseResult> {
  validateIdentity(expected);
  const project = await canonicalProjectDirectory(projectDir);
  if (expected.projectDir !== project) throw new Error("Write lock belongs to another checkout.");
  const result = await withProjectLock(project, async () => {
    const registry = await readRegistry(project);
    const current = registry.reservations.find((row) => sameIdentity(row, expected));
    if (!current) return { kind: "released" as const, released: false };
    if (current.reservedAt !== expected.reservedAt || current.files.join("\0") !== expected.files.join("\0") ||
        current.festival !== expected.festival || current.task !== expected.task || current.worker !== expected.worker) {
      throw new Error("Write lock changed since inspection; reread active writes before reclaiming.");
    }
    await writeRegistry(project, { ...registry, reservations: registry.reservations.filter((row) => !sameIdentity(row, expected)) });
    return { kind: "released" as const, released: true };
  });
  return result ?? { kind: "busy" };
}
