import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { processIsAlive, withStaleAwareLock } from "./fs-lock.js";

const JOURNAL_VERSION = 1;
const MARKER = ".omp-fest-creation.json";
const OWNER = ".omp-fest-owner.json";
const APPROVED_PLAN = "APPROVED_PLAN.json";
const QUARANTINE = ".omp-fest-quarantine.json";
type Journal = CreationReceipt & { version: number; state: "scaffolding"; preexisting: string[]; festivalDir?: string };
export interface CreationReceipt { id: string; name: string; planPath: string; sessionId: string; startedAt: string; journalPath: string; pid?: number; host?: string }
export interface FestivalCreationOrphan { receipt: CreationReceipt; festivalDir?: string }

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function enoent(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
async function realDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe festival directory: ${path}`);
}
async function ensureStorage(root: string): Promise<string> {
  let current = root;
  for (const part of [".ompfest", "creations"]) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: unknown) => { if (!enoent(error) && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    await realDirectory(current);
  }
  return current;
}
function validReceipt(value: unknown): asserts value is Journal {
  if (!value || typeof value !== "object") throw new Error("Invalid festival creation journal.");
  const j = value as Partial<Journal>;
  if (j.version !== JOURNAL_VERSION || j.state !== "scaffolding" || typeof j.id !== "string" || !/^[0-9a-f-]{36}$/.test(j.id) ||
      typeof j.name !== "string" || typeof j.planPath !== "string" || typeof j.sessionId !== "string" || !j.sessionId ||
      typeof j.startedAt !== "string" || !Number.isFinite(Date.parse(j.startedAt)) || typeof j.journalPath !== "string" ||
      !Array.isArray(j.preexisting) || j.preexisting.some((n) => typeof n !== "string" || n === "." || n === ".." || n.includes(sep)) ||
      (j.festivalDir !== undefined && typeof j.festivalDir !== "string") ||
      (j.pid !== undefined && (typeof j.pid !== "number" || !Number.isInteger(j.pid))) ||
      (j.host !== undefined && typeof j.host !== "string")) throw new Error("Invalid festival creation journal.");
}
async function readJournal(path: string, expectedRoot: string): Promise<Journal> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("Unsafe festival creation journal.");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  validReceipt(value);
  const dir = await ensureStorage(expectedRoot);
  if (resolve(path) !== join(dir, `${value.id}.json`) || resolve(value.journalPath) !== resolve(path)) throw new Error("Festival creation journal path mismatch.");
  return value;
}
async function planningRoot(campRoot: string): Promise<{ camp: string; planning: string }> {
  const camp = await realpath(campRoot);
  const planning = join(camp, "festivals", "planning");
  await realDirectory(join(camp, "festivals"));
  await realDirectory(planning);
  return { camp, planning };
}
async function safeFestivalPath(campRoot: string, festivalDir: string): Promise<{ camp: string; planning: string; target: string }> {
  const { camp, planning } = await planningRoot(campRoot);
  const target = resolve(camp, festivalDir);
  const rel = relative(planning, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.includes(sep)) {
    throw new Error("Festival directory must be a direct child of festivals/planning.");
  }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(target) !== target) throw new Error("Festival target must be a real directory, not a symlink.");
  return { camp, planning, target };
}
async function markerFor(target: string, id: string): Promise<boolean> {
  const path = join(target, MARKER);
  const info = await lstat(path).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
  if (!info) return false;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return false;
  try { const value: unknown = JSON.parse(await readFile(path, "utf8")); return !!value && typeof value === "object" && "id" in value && value.id === id; }
  catch { return false; }
}
async function removeJournal(journalPath: string, root: string, id: string): Promise<void> {
  const journal = await readJournal(journalPath, root);
  if (journal.id !== id) throw new Error("Festival creation journal identity mismatch.");
  await rm(journalPath);
}

export async function festivalCreationIsScaffolded(receipt: CreationReceipt): Promise<boolean> {
  const camp = await realpath(resolve(receipt.journalPath, "../../.."));
  const journal = await readJournal(receipt.journalPath, camp);
  if (journal.id !== receipt.id || !journal.festivalDir) return false;
  const planPath = resolve(camp, journal.planPath);
  const plans = join(camp, ".ompfest", "plans");
  if (!inside(plans, planPath) || dirname(planPath) !== plans || !basename(planPath).endsWith(".STRUCTURE.md")) return false;
  const actualPlans = await realpath(plans).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
  if (actualPlans !== plans) return false;
  const planInfo = await lstat(planPath).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
  const festivalInfo = await lstat(journal.festivalDir).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
  if (!planInfo?.isFile() || planInfo.isSymbolicLink() || !festivalInfo?.isDirectory() || festivalInfo.isSymbolicLink()) return false;
  const statusPath = `${planPath}.status.json`;
  const info = await lstat(statusPath).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) return false;
  try {
    const value: unknown = JSON.parse(await readFile(statusPath, "utf8"));
    return !!value && typeof value === "object" && !Array.isArray(value) && "state" in value &&
      value.state === "scaffolded" && "festivalDir" in value && typeof value.festivalDir === "string" &&
      resolve(camp, value.festivalDir) === journal.festivalDir;
  } catch { return false; }
}

/** A journal that never recorded a festival dir and is this old was abandoned mid-write. */
const STALE_JOURNAL_MS = 30 * 60_000;

async function withCreationIndexLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  return withStaleAwareLock(join(directory, ".index.lock"), action, { label: "Festival creation index", busyMs: 10_000, staleMs: 30_000 });
}

/**
 * Classify a same-name journal on scaffold retry:
 * `resume` — festivalDir recorded: the tool re-validates, then completes or rolls back.
 * `stale` — no festivalDir and older than STALE_JOURNAL_MS: auto-clear and proceed.
 * `in_flight` — anything else: keep blocking (a live scaffold may be running).
 */
export function classifyCreationOrphan(orphan: FestivalCreationOrphan, nowMs = Date.now()): "resume" | "stale" | "in_flight" {
  if (orphan.festivalDir) return "resume";
  // A recorded scaffold process that no longer exists crashed — treat as stale.
  if (orphan.receipt.pid !== undefined && orphan.receipt.host === hostname() && !processIsAlive(orphan.receipt.pid)) return "stale";
  return nowMs - Date.parse(orphan.receipt.startedAt) > STALE_JOURNAL_MS ? "stale" : "in_flight";
}

/** Remove a verified-stale journal that never recorded a festival directory. */
export async function clearStaleCreationJournal(campRoot: string, orphan: FestivalCreationOrphan): Promise<void> {
  if (classifyCreationOrphan(orphan) !== "stale") throw new Error("Only stale journals without a festival directory may be cleared automatically.");
  await clearCreationJournal(campRoot, orphan);
}

/** Remove a journal-only orphan (no festivalDir) after re-verifying its id under the index lock. */
export async function clearCreationJournal(campRoot: string, orphan: FestivalCreationOrphan): Promise<void> {
  const camp = await realpath(campRoot);
  const dir = await ensureStorage(camp);
  await withCreationIndexLock(dir, async () => {
    const current = await readJournal(orphan.receipt.journalPath, camp);
    if (current.id !== orphan.receipt.id || current.festivalDir) throw new Error("Creation journal changed since inspection; reread orphans before clearing.");
    await rm(orphan.receipt.journalPath);
  });
}

/**
 * True when the journal's scaffold may still be running: a different session
 * with a recorded live pid on this host, or a recent journal with unknown
 * liveness. Own-session retries and dead/aged journals never count as live.
 */
export function creationJournalMayBeLive(orphan: FestivalCreationOrphan, sessionId: string, nowMs = Date.now()): boolean {
  if (orphan.receipt.sessionId === sessionId) return false;
  if (orphan.receipt.pid !== undefined && orphan.receipt.host === hostname()) return processIsAlive(orphan.receipt.pid);
  return nowMs - Date.parse(orphan.receipt.startedAt) <= STALE_JOURNAL_MS;
}

export async function beginFestivalCreation(campRoot: string, name: string, planPath: string, sessionId: string): Promise<CreationReceipt> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !sessionId || !planPath) throw new Error("Festival creation requires a lowercase slug, plan path, and session id.");
  const camp = await realpath(campRoot), planning = join(camp, "festivals", "planning");
  await realDirectory(join(camp, "festivals")); await realDirectory(planning);
  const dir = await ensureStorage(camp);
  return withCreationIndexLock(dir, async () => {
    const collisions = (await listFestivalCreationOrphans(camp)).filter((orphan) => orphan.receipt.name === name);
    // Auto-clear stale, dead-pid, and same-session journals; only a possibly-live
    // foreign scaffold blocks the retry.
    const unresolved = collisions.filter((orphan) => classifyCreationOrphan(orphan) !== "stale" && creationJournalMayBeLive(orphan, sessionId));
    if (unresolved.length) {
      throw new Error(`Festival ${name} already has an incomplete creation transaction ${unresolved[0]?.receipt.id ?? ""}. Review /fest orphans before retrying.`);
    }
    for (const orphan of collisions) {
      await rm(orphan.receipt.journalPath, { force: true });
    }
    const existing = await lstat(join(planning, name)).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
    if (existing) throw new Error(`Festival ${name} already exists in planning; existing data is never overwritten.`);
    const id = randomUUID(), journalPath = join(dir, `${id}.json`);
    const record: Journal = { version: JOURNAL_VERSION, id, name, planPath, sessionId, startedAt: new Date().toISOString(), journalPath, state: "scaffolding", preexisting: await readdir(planning), pid: process.pid, host: hostname() };
    const temporary = `${journalPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, journalPath);
    } finally {
      await rm(temporary, { force: true });
    }
    return { id, name, planPath, sessionId, startedAt: record.startedAt, journalPath, pid: record.pid, host: record.host };
  });
}

export async function recordFestivalCreation(receipt: CreationReceipt, festivalDir: string): Promise<void> {
  const camp = await realpath(resolve(receipt.journalPath, "../../.."));
  const journal = await readJournal(receipt.journalPath, camp);
  if (journal.id !== receipt.id || journal.sessionId !== receipt.sessionId || journal.name !== receipt.name || journal.planPath !== receipt.planPath) {
    throw new Error("Festival creation receipt does not match journal.");
  }
  const { target } = await safeFestivalPath(camp, festivalDir);
  if (basename(target) !== receipt.name) throw new Error(`Festival target must be exactly festivals/planning/${receipt.name}.`);
  if (journal.preexisting.includes(basename(target))) throw new Error("Cannot mark a pre-existing festival as newly created.");
  const markerPath = join(target, MARKER);
  const current = await lstat(markerPath).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
  if (current) {
    if (!current.isFile() || current.isSymbolicLink() || !(await markerFor(target, receipt.id))) throw new Error("Festival already has a different creation marker.");
  } else await writeFile(markerPath, `${JSON.stringify({ id: receipt.id, name: receipt.name, startedAt: receipt.startedAt })}\n`, { flag: "wx", mode: 0o600 });
  journal.festivalDir = target;
  const temp = `${journal.journalPath}.${randomUUID()}.tmp`;
  try { await writeFile(temp, `${JSON.stringify(journal, null, 2)}\n`, { flag: "wx", mode: 0o600 }); await rename(temp, journal.journalPath); }
  finally { await rm(temp, { force: true }); }
}

export async function completeFestivalCreation(receipt: CreationReceipt): Promise<void> {
  const camp = await realpath(resolve(receipt.journalPath, "../../.."));
  const journal = await readJournal(receipt.journalPath, camp);
  if (journal.id !== receipt.id) throw new Error("Festival creation receipt does not match journal.");
  if (!(await festivalCreationIsScaffolded(receipt))) throw new Error("Festival creation is not validated and marked scaffolded; refusing to finalize its journal.");
  if (journal.festivalDir) {
    const marker = join(journal.festivalDir, MARKER);
    const info = await lstat(marker).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
    if (info) {
      if (!info.isFile() || info.isSymbolicLink() || !(await markerFor(journal.festivalDir, receipt.id))) throw new Error("Festival creation marker no longer matches this transaction.");
      await rm(marker);
    }
  }
  await removeJournal(journal.journalPath, camp, receipt.id);
}

export async function rollbackFestivalCreation(receipt: CreationReceipt, createdFestivalDir?: string): Promise<FestivalCreationOrphan | undefined> {
  const camp = await realpath(resolve(receipt.journalPath, "../../.."));
  const journal = await readJournal(receipt.journalPath, camp);
  if (journal.id !== receipt.id) throw new Error("Festival creation receipt does not match journal.");
  const candidate = createdFestivalDir ?? journal.festivalDir;
  if (!candidate) return { receipt };
  let target: string;
  try {
    ({ target } = await safeFestivalPath(camp, candidate));
    if (journal.preexisting.includes(basename(target)) || basename(target) !== journal.name || !await markerFor(target, receipt.id)) return { receipt, festivalDir: target };
    await quarantineOwnedFestival(camp, target);
  } catch { return { receipt, festivalDir: candidate }; }
  await removeJournal(journal.journalPath, camp, receipt.id);
  return undefined;
}

async function quarantineOwnedFestival(camp: string, target: string): Promise<string> {
  const storage = join(camp, ".ompfest");
  await mkdir(storage, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await realDirectory(storage);
  const orphans = join(storage, "orphans");
  await mkdir(orphans, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await realDirectory(orphans);
  const destination = join(orphans, `${randomUUID()}-${Date.now()}`);
  const manifest = join(target, QUARANTINE);
  await writeFile(manifest, `${JSON.stringify({ version: 1, originalName: basename(target), quarantinedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
  try { await rename(target, destination); }
  catch (error) { await rm(manifest, { force: true }); throw error; }
  return destination;
}

export interface QuarantinedFestival { id: string; name: string }

export async function listQuarantinedFestivals(campRoot: string): Promise<QuarantinedFestival[]> {
  const camp = await realpath(campRoot);
  await ensureStorage(camp);
  const orphans = join(camp, ".ompfest", "orphans");
  await mkdir(orphans, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await realDirectory(orphans);
  const result: QuarantinedFestival[] = [];
  for (const id of await readdir(orphans)) {
    const target = join(orphans, id);
    try {
      await realDirectory(target);
      const manifestPath = join(target, QUARANTINE), info = await lstat(manifestPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) continue;
      const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 ||
          !("originalName" in value) || typeof value.originalName !== "string" ||
          value.originalName === "." || value.originalName === ".." || value.originalName.includes(sep)) continue;
      result.push({ id, name: value.originalName });
    } catch { /* Invalid quarantine entries are not safe restore candidates. */ }
  }
  return result;
}

export async function listFestivalCreationOrphans(campRoot: string): Promise<FestivalCreationOrphan[]> {
  const camp = await realpath(campRoot), dir = await ensureStorage(camp), result: FestivalCreationOrphan[] = [];
  for (const entry of await readdir(dir)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(entry)) continue;
    try {
      const journal = await readJournal(join(dir, entry), camp);
      if (`${journal.id}.json` !== entry) continue;
      result.push({ receipt: { id: journal.id, name: journal.name, planPath: journal.planPath, sessionId: journal.sessionId, startedAt: journal.startedAt, journalPath: journal.journalPath, ...(journal.pid !== undefined ? { pid: journal.pid } : {}), ...(journal.host !== undefined ? { host: journal.host } : {}) }, ...(journal.festivalDir ? { festivalDir: journal.festivalDir } : {}) });
    } catch { /* Invalid journals are never surfaced as safe rollback candidates. */ }
  }
  return result;
}

export async function quarantineFestival(campRoot: string, festivalDir: string): Promise<string> {
  const { camp, planning, target } = await safeFestivalPath(campRoot, festivalDir);
  for (const file of [OWNER, APPROVED_PLAN, MARKER, QUARANTINE]) {
    const path = join(target, file), info = await lstat(path).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
    if (info) throw new Error(`Cannot quarantine a festival with ${file}.`);
  }
  if ((await listFestivalCreationOrphans(camp)).some((orphan) => orphan.receipt.name === basename(target) || orphan.festivalDir === target)) {
    throw new Error("A festival creation journal is still present; resolve that transaction before quarantining.");
  }
  if (!inside(planning, target) || target === planning) throw new Error("Festival directory must be within planning.");
  return quarantineOwnedFestival(camp, target);
}

export async function restoreQuarantinedFestival(campRoot: string, quarantineDir: string): Promise<string> {
  const camp = await realpath(campRoot), orphans = join(camp, ".ompfest", "orphans"), target = resolve(quarantineDir);
  if (!inside(orphans, target) || target === orphans) throw new Error("Quarantine path must be inside .ompfest/orphans.");
  const parent = await realpath(orphans);
  if (parent !== orphans) throw new Error("Quarantine storage must not be a symlink.");
  await realDirectory(target);
  const manifestPath = join(target, QUARANTINE), info = await lstat(manifestPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("Quarantine manifest is unsafe.");
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || !("version" in manifest) || manifest.version !== 1 ||
      !("originalName" in manifest) || typeof manifest.originalName !== "string" ||
      manifest.originalName === "." || manifest.originalName === ".." || manifest.originalName.includes(sep)) {
    throw new Error("Quarantine manifest is invalid.");
  }
  const planning = join(camp, "festivals", "planning");
  await realDirectory(planning);
  const destination = join(planning, manifest.originalName);
  const exists = await lstat(destination).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
  if (exists) throw new Error(`Cannot restore: ${manifest.originalName} already exists in planning.`);
  await rename(target, destination);
  await rm(join(destination, QUARANTINE));
  return destination;
}
