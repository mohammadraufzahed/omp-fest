import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface HandoffDecision { decision: string; rationale: string; rejectedAlternatives: string[] }
export interface HandoffChangedFile { path: string; change: string }
export interface HandoffCheck {
  command: string;
  cwd: string;
  status: "passed" | "failed" | "not_run";
  output: string;
  evidencePaths: string[];
}
export interface HandoffInput {
  summary: string;
  decisions: HandoffDecision[];
  changedFiles: HandoffChangedFile[];
  checks: HandoffCheck[];
  failures: string[];
  blockers: string[];
  nextAction: string;
}
export interface Handoff extends HandoffInput { schema: "omp.fest.handoff/v1"; id: string; createdAt: string }

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && !!value.trim(); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(text); }
export function isHandoffInput(value: unknown): value is HandoffInput {
  return record(value) && text(value.summary) && text(value.nextAction)
    && Array.isArray(value.decisions) && value.decisions.every((item: unknown) => record(item) && text(item.decision) && text(item.rationale) && strings(item.rejectedAlternatives))
    && Array.isArray(value.changedFiles) && value.changedFiles.every((item: unknown) => record(item) && text(item.path) && text(item.change))
    && Array.isArray(value.checks) && value.checks.every((item: unknown) => record(item) && text(item.command) && text(item.cwd)
      && ["passed", "failed", "not_run"].includes(String(item.status)) && typeof item.output === "string" && (item.status === "not_run" || text(item.output)) && strings(item.evidencePaths))
    && strings(value.failures) && strings(value.blockers);
}

async function directory(festivalDir: string, create: boolean): Promise<string> {
  let current = await realpath(festivalDir);
  for (const part of [".ompfest", "handoffs"]) {
    current = join(current, part);
    if (create) await mkdir(current).catch((error: unknown) => {
      if (!record(error) || error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Handoff directory must not be a symlink");
  }
  return current;
}
function relativePath(path: string): void {
  if (!path.trim() || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error("Handoff paths must be festival-relative without traversal");
}

/** Immutable, festival-relative handoff. Caller-reported checks are never upgraded to verified. */
export async function writeHandoff(festivalDir: string, input: HandoffInput): Promise<{ path: string; handoff: Handoff }> {
  if (!isHandoffInput(input)) throw new Error("Handoff needs concrete decisions, changed files, check outcomes, failures, blockers and next action; use empty arrays only when none exist");
  if (Buffer.byteLength(JSON.stringify(input)) > 2 * 1024 * 1024) throw new Error("Handoff exceeds 2 MiB");
  const root = await realpath(festivalDir);
  for (const file of input.changedFiles) relativePath(file.path);
  for (const check of input.checks) {
    relativePath(check.cwd);
    for (const path of check.evidencePaths) {
      relativePath(path);
      const target = await realpath(resolve(root, path));
      const rel = relative(root, target);
      if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !(await lstat(target)).isFile()) throw new Error("Handoff evidence must be an existing file inside the festival");
    }
  }
  const handoff: Handoff = { ...input, schema: "omp.fest.handoff/v1", id: randomUUID(), createdAt: new Date().toISOString() };
  await writeFile(join(await directory(root, true), `${handoff.id}.json`), JSON.stringify(handoff, null, 2), { flag: "wx", mode: 0o600 });
  return { path: `.ompfest/handoffs/${handoff.id}.json`, handoff };
}

export async function readHandoff(festivalDir: string, id: string): Promise<Handoff> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new Error("Invalid handoff id");
  const path = join(await directory(festivalDir, false), `${id}.json`);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 3 * 1024 * 1024) throw new Error("Unsafe handoff artifact");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isHandoffInput(value) || !record(value) || value.schema !== "omp.fest.handoff/v1" || value.id !== id || !text(value.createdAt)) throw new Error("Malformed handoff artifact");
  return { ...value, schema: "omp.fest.handoff/v1", id, createdAt: value.createdAt };
}
