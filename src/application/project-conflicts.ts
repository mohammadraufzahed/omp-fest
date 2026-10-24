import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout } from "node:timers/promises";

const REGISTRY_FILE = ".omp-fest-reservations.json";
const LOCK_DIR = ".omp-fest-reservations.lock";
const LOCK_ATTEMPTS = 80;
const LOCK_WAIT_MS = 25;

export interface ProjectReservationRequest {
  sessionId: string;
  assignmentId: string;
  /** Paths relative to the supplied working directory, or absolute. Empty reserves the entire checkout. */
  files: string[];
  festival?: string;
  task?: string;
  worker?: string;
}

export interface ProjectReservation extends ProjectReservationRequest {
  projectDir: string;
  reservedAt: string;
}

export interface ProjectReservationIdentity {
  sessionId: string;
  assignmentId: string;
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
        [row.festival, row.task, row.worker].some((field) => field !== undefined && typeof field !== "string")) {
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

async function withProjectLock<T>(project: string, action: () => Promise<T>): Promise<T | undefined> {
  const lock = join(await registryDirectory(project), LOCK_DIR);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await setTimeout(LOCK_WAIT_MS);
      continue;
    }
    try {
      return await action();
    } finally {
      // Only the process that acquired this lock removes it. Never infer stale ownership.
      await rm(lock, { recursive: true, force: true });
    }
  }
  return undefined;
}

/** Reserve before dispatch; records survive process exit until explicitly released by their session. */
export async function reserveProjectFiles(projectDir: string, request: ProjectReservationRequest): Promise<ProjectReservationResult> {
  validateIdentity(request);
  const project = await canonicalProjectDirectory(projectDir);
  const result = await withProjectLock(project, async (): Promise<ProjectReservationResult> => {
    const files = await canonicalFiles(project, await realpath(projectDir), request.files);
    const registry = await readRegistry(project);
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
    };
    registry.reservations.push(reservation);
    await writeRegistry(project, registry);
    return { kind: "reserved", reservation };
  });
  return result ?? { kind: "busy" };
}

/** Release only this session's exact assignment, after acceptance or explicit settlement. */
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

/** Read durable reservations on resume/review; lock contention and corruption fail closed. */
export async function listProjectReservations(projectDir: string): Promise<ProjectReservation[]> {
  const project = await canonicalProjectDirectory(projectDir);
  const result = await withProjectLock(project, async () => (await readRegistry(project)).reservations);
  if (!result) throw new Error("Project reservation registry is busy; retry without dispatching work.");
  return result;
}

/** Advisory queue check only: dispatch must still reserve atomically. */
export async function checkProjectConflicts(projectDir: string, files: string[], exclude?: ProjectReservationIdentity): Promise<ProjectConflictResult> {
  const project = await canonicalProjectDirectory(projectDir);
  const result = await withProjectLock(project, async (): Promise<ProjectConflictResult> => {
    const canonical = await canonicalFiles(project, await realpath(projectDir), files);
    const registry = await readRegistry(project);
    const conflicts = registry.reservations.filter((row) => (!exclude || !sameIdentity(row, exclude)) && overlaps(row.files, canonical));
    return conflicts.length ? { kind: "conflict", conflicts } : { kind: "clear" };
  });
  return result ?? { kind: "busy" };
}
