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
 * Pick the working dir a fresh festival should target: the explicit value,
 * else the camp's single registered project, else "." when the camp has no
 * projects, else undefined (multiple projects and the human must choose).
 */
export async function resolveWorkingDir(
  campRoot: string,
  camp: CampCli,
  explicit?: string,
): Promise<{ dir?: string; candidates: string[] }> {
  if (explicit && explicit.length > 0) {
    const absolute = resolve(campRoot, explicit);
    const relativeDir = relative(campRoot, absolute);
    if (relativeDir !== ".." && !relativeDir.startsWith(`..${sep}`) && !isAbsolute(relativeDir)) {
      return { dir: relativeDir || ".", candidates: [] };
    }
    return { dir: explicit, candidates: [] };
  }
  // `camp project list` is authoritative — projects/ also holds camp-internal
  // entries (OBEY.md, worktrees/) that aren't projects.
  const registered = await camp.projects(campRoot).catch(() => [] as { name: string; path: string }[]);
  const candidates = registered.map((project) => {
    const rel = relative(campRoot, resolve(campRoot, project.path));
    return rel.length > 0 && !rel.startsWith("..") ? rel : project.path;
  });
  if (candidates.length === 0) {
    for (const entry of await readdir(join(campRoot, "projects")).catch(() => [] as string[])) {
      if (entry.startsWith(".")) {
        continue;
      }
      const isDir = (await stat(join(campRoot, "projects", entry)).catch(() => undefined))?.isDirectory();
      if (isDir === true) {
        candidates.push(`projects/${entry}`);
      }
    }
  }
  if (candidates.length === 1) {
    return { dir: candidates[0], candidates };
  }
  if (candidates.length === 0) {
    return { dir: ".", candidates };
  }
  return { candidates };
}

/** Frontmatter is resolved by fest from the camp, not from the invoking process. */
export async function campRelativeWorkingDir(campRoot: string, workingDir: string): Promise<string> {
  const root = await realpath(campRoot);
  const absolute = resolve(root, workingDir);
  const rel = relative(root, absolute);
  if (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel.split(sep).join("/") || ".";
  // External checkouts must use their camp link so the generated festival is portable.
  const target = await realpath(absolute);
  for (const entry of await readdir(join(root, "projects")).catch(() => [] as string[])) {
    const candidate = join(root, "projects", entry);
    if (await realpath(candidate).catch(() => undefined) === target) return `projects/${entry}`;
  }
  throw new Error("workingDir must be inside the camp or have a projects/ link");
}
