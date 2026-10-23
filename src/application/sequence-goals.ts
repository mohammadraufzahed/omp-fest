/**
 * Sequence-goal post-processing for scaffolded festivals.
 *
 * `fest scaffold from-plan` emits SEQUENCE_GOAL.md files WITHOUT the
 * fest_working_dir frontmatter key, so `fest next` fails validation with
 * "missing fest_working_dir" on every implementation sequence — and no
 * [FILL:]/[REPLACE:] marker covers it (markers only count file bodies).
 * The plugin stamps the resolved dir into every sequence goal missing it.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import type { CampCli } from "../ports.js";

/**
 * Write `fest_working_dir: "<dir>"` into every SEQUENCE_GOAL.md under
 * festivalDir that lacks the key — inserted inside the YAML frontmatter.
 * Returns the number of files stamped.
 */
export async function stampWorkingDir(festivalDir: string, workingDir: string): Promise<number> {
  const line = `fest_working_dir: "${workingDir}"`;
  let stamped = 0;
  for (const phase of await readdir(festivalDir).catch(() => [] as string[])) {
    if (!/^\d{3}_/.test(phase)) {
      continue;
    }
    for (const seq of await readdir(join(festivalDir, phase)).catch(() => [] as string[])) {
      const goal = join(festivalDir, phase, seq, "SEQUENCE_GOAL.md");
      const text = await readFile(goal, "utf8").catch(() => "");
      if (!text.startsWith("---") || text.includes("fest_working_dir")) {
        continue;
      }
      const updated = /^fest_tracking:.*$/m.test(text)
        ? text.replace(/^(fest_tracking:.*)$/m, `$1\n${line}`)
        : text.replace(/\n---\n/, `\n${line}\n---\n`);
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
    if (resolve(explicit) === absolute && relativeDir !== ".." && !relativeDir.startsWith(`..${sep}`)) {
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
