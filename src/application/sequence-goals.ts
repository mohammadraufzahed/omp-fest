/**
 * Sequence-goal post-processing for scaffolded festivals.
 *
 * `fest scaffold from-plan` emits SEQUENCE_GOAL.md files WITHOUT the
 * fest_working_dir frontmatter key, so `fest next` fails validation with
 * "missing fest_working_dir" on every implementation sequence — and no
 * [FILL:]/[REPLACE:] marker covers it (markers only count file bodies).
 * The plugin stamps the resolved dir into every sequence goal missing it.
 */
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { CampCli } from "../ports.js";

/**
 * Write `fest_working_dir: "<dir>"` into every SEQUENCE_GOAL.md under
 * festivalDir that lacks the key — inserted inside the YAML frontmatter.
 * Returns the number of files stamped.
 */
export async function stampWorkingDir(festivalDir: string, workingDir: string): Promise<number> {
  const line = `fest_working_dir: ${JSON.stringify(workingDir)}`;
  let stamped = 0;
  for (const phase of await readdir(festivalDir).catch(() => [] as string[])) {
    if (!/^\d{3}_/.test(phase)) {
      continue;
    }
    for (const seq of await readdir(join(festivalDir, phase)).catch(() => [] as string[])) {
      const goal = join(festivalDir, phase, seq, "SEQUENCE_GOAL.md");
      const text = await readFile(goal, "utf8").catch(() => "");
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (!frontmatter || /^fest_working_dir:/m.test(frontmatter[1] ?? "")) {
        continue;
      }
      const block = frontmatter[0];
      const updatedBlock = block.replace(/\r?\n---(\r?\n|$)$/, `\n${line}\n---$1`);
      const updated = updatedBlock + text.slice(block.length);
      if (updated !== text) {
        await writeFile(goal, updated);
        stamped += 1;
      }
    }
  }
  return stamped;
}

/**
 * Resolve one working directory against the canonical camp root and return
 * the camp-relative path used by plan artifacts and generated festivals.
 */
async function canonicalWorkingDir(campRoot: string, input: string): Promise<string> {
  const root = await realpath(campRoot);
  const candidate = resolve(root, input);
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new Error(`workingDir does not exist from the camp root: ${input}`);
  }
  if (!(await stat(target)).isDirectory()) throw new Error(`workingDir must be a directory: ${input}`);
  const rel = relative(root, target);
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel.split(sep).join("/") || ".";
  for (const entry of await readdir(join(root, "projects")).catch(() => [] as string[])) {
    const link = join(root, "projects", entry);
    if (await realpath(link).catch(() => undefined) === target) return `projects/${entry}`;
  }
  throw new Error("workingDir must be inside the camp or reachable through a projects/ link");
}

/**
 * Pick the working dir a fresh festival should target: the explicit value,
 * else the camp's single registered project, else "." when the camp has no
 * projects, else undefined (multiple projects and the human must choose).
 * Explicit relative paths are always interpreted from the camp root.
 */
export async function resolveWorkingDir(
  campRoot: string,
  camp: CampCli,
  explicit?: string,
): Promise<{ dir?: string; candidates: string[] }> {
  if (explicit && explicit.length > 0) {
    const dir = await canonicalWorkingDir(campRoot, explicit);
    return { dir, candidates: [] };
  }
  const root = await realpath(campRoot);
  // `camp project list` is authoritative — projects/ also holds camp-internal
  // entries (OBEY.md, worktrees/) that aren't projects.
  const registered = await camp.projects(campRoot).catch(() => [] as { name: string; path: string }[]);
  const candidates = await Promise.all(registered.map(async (project) => {
    try { return await canonicalWorkingDir(root, project.path); }
    catch { return undefined; }
  }));
  const validCandidates = [...new Set(candidates.filter((path): path is string => !!path))];
  if (validCandidates.length === 0) {
    for (const entry of await readdir(join(root, "projects")).catch(() => [] as string[])) {
      if (entry.startsWith(".")) continue;
      const path = join(root, "projects", entry);
      const isDir = (await stat(path).catch(() => undefined))?.isDirectory();
      if (isDir === true) validCandidates.push(`projects/${entry}`);
    }
  }
  if (validCandidates.length === 1) return { dir: validCandidates[0], candidates: validCandidates };
  if (validCandidates.length === 0) return { dir: ".", candidates: [] };
  return { candidates: validCandidates };
}

/** Frontmatter always stores a camp-relative path, including linked external checkouts. */
export async function campRelativeWorkingDir(campRoot: string, workingDir: string): Promise<string> {
  return canonicalWorkingDir(campRoot, workingDir);
}
