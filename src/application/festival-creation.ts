import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const JOURNAL_VERSION = 1;
const MARKER = ".omp-fest-creation.json";
const OWNER = ".omp-fest-owner.json";
const APPROVED_PLAN = "APPROVED_PLAN.json";
const QUARANTINE = ".omp-fest-quarantine.json";
type Journal = CreationReceipt & { version: number; state: "scaffolding"; preexisting: string[]; festivalDir?: string };
export interface CreationReceipt { id: string; name: string; planPath: string; sessionId: string; startedAt: string; journalPath: string }
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
      (j.festivalDir !== undefined && typeof j.festivalDir !== "string")) throw new Error("Invalid festival creation journal.");
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
  const target = resolve(festivalDir);
  if (!inside(planning, target) || target === planning) throw new Error("Festival directory must be inside festivals/planning.");
  const rel = relative(planning, target).split(sep);
  let parent = planning;
  for (const part of rel.slice(0, -1)) { parent = join(parent, part); await realDirectory(parent); }
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

async function withCreationIndexLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  const lock = join(directory, ".index.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(lock);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Festival creation lock is unsafe.", { cause: error });
    if (Date.now() - info.mtimeMs > 10_000) await rm(lock, { recursive: true, force: true });
    else throw new Error("Another plan creation is starting; retry shortly.", { cause: error });
    await mkdir(lock, { mode: 0o700 });
  }
  try { return await action(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function beginFestivalCreation(campRoot: string, name: string, planPath: string, sessionId: string): Promise<CreationReceipt> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !sessionId || !planPath) throw new Error("Festival creation requires a lowercase slug, plan path, and session id.");
  const camp = await realpath(campRoot), planning = join(camp, "festivals", "planning");
  await realDirectory(join(camp, "festivals")); await realDirectory(planning);
  const dir = await ensureStorage(camp);
  return withCreationIndexLock(dir, async () => {
    if ((await listFestivalCreationOrphans(camp)).some((orphan) => orphan.receipt.name === name)) {
      throw new Error(`Festival ${name} already has an incomplete creation transaction. Review /fest orphans before retrying.`);
    }
    const existing = await lstat(join(planning, name)).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
    if (existing) throw new Error(`Festival ${name} already exists in planning; existing data is never overwritten.`);
    const id = randomUUID(), journalPath = join(dir, `${id}.json`);
    const record: Journal = { version: JOURNAL_VERSION, id, name, planPath, sessionId, startedAt: new Date().toISOString(), journalPath, state: "scaffolding", preexisting: await readdir(planning) };
    const temporary = `${journalPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, journalPath);
    } finally {
      await rm(temporary, { force: true });
    }
    return { id, name, planPath, sessionId, startedAt: record.startedAt, journalPath };
  });
}

export async function recordFestivalCreation(receipt: CreationReceipt, festivalDir: string): Promise<void> {
  const camp = await realpath(resolve(receipt.journalPath, "../../.."));
  const journal = await readJournal(receipt.journalPath, camp);
  if (journal.id !== receipt.id || journal.sessionId !== receipt.sessionId) throw new Error("Festival creation receipt does not match journal.");
  const { target } = await safeFestivalPath(camp, festivalDir);
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
  if (journal.festivalDir && await markerFor(journal.festivalDir, receipt.id)) await rm(join(journal.festivalDir, MARKER));
  await removeJournal(journal.journalPath, camp, receipt.id);
}

export async function rollbackFestivalCreation(receipt: CreationReceipt, createdFestivalDir?: string): Promise<FestivalCreationOrphan | undefined> {
  const camp = await realpath(resolve(receipt.journalPath, "../../.."));
  const journal = await readJournal(receipt.journalPath, camp);
  if (journal.id !== receipt.id) throw new Error("Festival creation receipt does not match journal.");
  const candidate = createdFestivalDir ?? journal.festivalDir;
  if (!candidate) { await removeJournal(journal.journalPath, camp, receipt.id); return undefined; }
  try {
    const { target } = await safeFestivalPath(camp, candidate);
    if (journal.preexisting.includes(basename(target)) || !await markerFor(target, receipt.id)) return { receipt, festivalDir: target };
    await rm(target, { recursive: true, force: false });
    await removeJournal(journal.journalPath, camp, receipt.id);
    return undefined;
  } catch { return { receipt, festivalDir: candidate }; }
}

export async function listFestivalCreationOrphans(campRoot: string): Promise<FestivalCreationOrphan[]> {
  const camp = await realpath(campRoot), dir = await ensureStorage(camp), result: FestivalCreationOrphan[] = [];
  for (const entry of await readdir(dir)) {
    if (!/^[0-9a-f-]{36}\.json$/.test(entry)) continue;
    try {
      const journal = await readJournal(join(dir, entry), camp);
      if (`${journal.id}.json` !== entry) continue;
      result.push({ receipt: { id: journal.id, name: journal.name, planPath: journal.planPath, sessionId: journal.sessionId, startedAt: journal.startedAt, journalPath: journal.journalPath }, ...(journal.festivalDir ? { festivalDir: journal.festivalDir } : {}) });
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
  const storage = join(camp, ".ompfest");
  await mkdir(storage, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await realDirectory(storage);
  const orphans = join(storage, "orphans");
  await mkdir(orphans, { mode: 0o700 }).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  await realDirectory(orphans);
  const destination = join(orphans, `${randomUUID()}-${Date.now()}`);
  if (!inside(planning, target) || target === planning) throw new Error("Festival directory must be within planning.");
  const manifest = join(target, QUARANTINE);
  await writeFile(manifest, `${JSON.stringify({ version: 1, originalName: basename(target), quarantinedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
  try { await rename(target, destination); }
  catch (error) { await rm(manifest, { force: true }); throw error; }
  return destination;
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
