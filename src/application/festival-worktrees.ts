/**
 * Worktree-per-festival lifecycle: each active festival gets a git worktree per
 * linked project under `projects/worktrees/<project>/<festival>` on branch
 * `fest/<festival>`; `fest_complete` merges the branch back into the project's
 * base branch and removes the worktree. The manifest in the festival dir makes
 * every step resumable after a crash — re-running either side is a no-op.
 */
import { lstat, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { writeAtomically } from "./fs-atomic.js";
import type { CampProject } from "../domain/types.js";
import type { ExecRunner } from "../ports.js";

export const WORKTREES_FILE = ".omp-fest-worktrees.json";

export interface FestivalWorktree {
  project: string;
  projectPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
}

export interface WorktreeMergeConflict {
  project: string;
  branch: string;
  files: string[];
}

export interface WorktreeMergeResult {
  merged: FestivalWorktree[];
  removed: string[];
  conflicts: WorktreeMergeConflict[];
  dirty: { worktreePath: string; files: string[] }[];
}

function enoent(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }

function manifestPath(festivalDir: string): string { return join(festivalDir, WORKTREES_FILE); }

export async function readFestivalWorktrees(festivalDir: string): Promise<FestivalWorktree[]> {
  const text = await readFile(manifestPath(festivalDir), "utf8").catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
  if (!text) return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is FestivalWorktree =>
    !!row && typeof row === "object" &&
    typeof (row as FestivalWorktree).project === "string" &&
    typeof (row as FestivalWorktree).projectPath === "string" &&
    typeof (row as FestivalWorktree).worktreePath === "string" &&
    typeof (row as FestivalWorktree).branch === "string" &&
    typeof (row as FestivalWorktree).baseBranch === "string" &&
    typeof (row as FestivalWorktree).baseCommit === "string");
}

async function writeFestivalWorktrees(festivalDir: string, rows: FestivalWorktree[]): Promise<void> {
  if (!rows.length) { await rm(manifestPath(festivalDir), { force: true }); return; }
  await writeAtomically(manifestPath(festivalDir), `${JSON.stringify(rows, null, 2)}\n`);
}

async function isGitRepo(exec: ExecRunner, dir: string): Promise<boolean> {
  const result = await exec.run("git", ["-C", dir, "rev-parse", "--git-dir"]);
  return result.code === 0;
}

async function gitOutput(exec: ExecRunner, dir: string, args: string[]): Promise<string> {
  const result = await exec.run("git", ["-C", dir, ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

/**
 * Create worktrees for each git project the festival can touch. Idempotent:
 * existing destination dirs and manifest rows are kept; the manifest is the
 * source of truth for what finish must later merge+remove.
 */
export async function createFestivalWorktrees(
  exec: ExecRunner,
  campRoot: string,
  festivalDir: string,
  festivalName: string,
  projects: CampProject[],
): Promise<FestivalWorktree[]> {
  const rows = await readFestivalWorktrees(festivalDir);
  const branch = `fest/${festivalName}`;
  for (const project of projects) {
    const projectPath = isAbsolute(project.path) ? project.path : resolve(campRoot, project.path);
    if (rows.some((row) => row.projectPath === projectPath)) continue;
    if (!existsSync(projectPath) || !(await isGitRepo(exec, projectPath))) continue;
    const worktreePath = join(campRoot, "projects", "worktrees", basename(projectPath), festivalName);
    if (!existsSync(worktreePath)) {
      const baseBranch = (await gitOutput(exec, projectPath, ["rev-parse", "--abbrev-ref", "HEAD"])) || "main";
      const baseCommit = await gitOutput(exec, projectPath, ["rev-parse", "HEAD"]);
      const branchExists = (await exec.run("git", ["-C", projectPath, "show-ref", "--verify", `refs/heads/${branch}`])).code === 0;
      const add = await exec.run("git", ["-C", projectPath, "worktree", "add", worktreePath, ...(branchExists ? [] : ["-b", branch]), ...(branchExists ? [branch] : [baseCommit])]);
      if (add.code !== 0) throw new Error(`git worktree add failed for ${projectPath}: ${add.stderr.trim() || add.stdout.trim()}`);
      rows.push({ project: project.name || basename(projectPath), projectPath, worktreePath, branch, baseBranch, baseCommit });
    } else {
      const baseBranch = (await gitOutput(exec, projectPath, ["rev-parse", "--abbrev-ref", "HEAD"])) || "main";
      const baseCommit = await gitOutput(exec, projectPath, ["rev-parse", "HEAD"]);
      rows.push({ project: project.name || basename(projectPath), projectPath, worktreePath, branch, baseBranch, baseCommit });
    }
    await writeFestivalWorktrees(festivalDir, rows);
  }
  return rows;
}

async function worktreeDirtyFiles(exec: ExecRunner, worktreePath: string): Promise<string[]> {
  const status = await exec.run("git", ["-C", worktreePath, "status", "--porcelain"]);
  if (status.code !== 0) return [];
  return status.stdout.split("\n").map((line) => line.slice(3).trim()).filter(Boolean);
}

/**
 * Merge every recorded festival worktree back into its base branch, then remove
 * the worktree and branch. Each entry is handled independently and removed from
 * the manifest as it completes, so a conflict or dirty tree mid-way leaves a
 * resumable state — rerun after fixing and only the remainder is retried.
 */
export async function mergeFestivalWorktrees(
  exec: ExecRunner,
  festivalDir: string,
): Promise<WorktreeMergeResult> {
  const rows = await readFestivalWorktrees(festivalDir);
  const result: WorktreeMergeResult = { merged: [], removed: [], conflicts: [], dirty: [] };
  const remaining: FestivalWorktree[] = [];
  for (const row of rows) {
    if (!existsSync(row.worktreePath)) {
      // Worktree already removed (e.g. previous run after merge) — drop the row.
      continue;
    }
    const dirty = await worktreeDirtyFiles(exec, row.worktreePath);
    if (dirty.length) {
      result.dirty.push({ worktreePath: row.worktreePath, files: dirty.slice(0, 25) });
      remaining.push(row);
      continue;
    }
    const merge = await exec.run("git", ["-C", row.projectPath, "merge", "--no-ff", "--no-edit", row.branch]);
    if (merge.code !== 0) {
      const files = (await exec.run("git", ["-C", row.projectPath, "diff", "--name-only", "--diff-filter=U"])).stdout
        .split("\n").map((line) => line.trim()).filter(Boolean);
      await exec.run("git", ["-C", row.projectPath, "merge", "--abort"]);
      result.conflicts.push({ project: row.project, branch: row.branch, files: files.slice(0, 25) });
      remaining.push(row);
      continue;
    }
    result.merged.push(row);
    const remove = await exec.run("git", ["-C", row.projectPath, "worktree", "remove", row.worktreePath]);
    if (remove.code === 0) {
      result.removed.push(row.worktreePath);
      await exec.run("git", ["-C", row.projectPath, "branch", "-d", row.branch]);
    } else {
      // Keep the manifest row so finish can retry the removal; the merge itself is done.
      remaining.push({ ...row, branch: row.branch });
    }
  }
  await writeFestivalWorktrees(festivalDir, remaining);
  return result;
}

/** True when the festival still has recorded worktrees to merge or remove. */
export async function festivalWorktreesPending(festivalDir: string): Promise<boolean> {
  return (await readFestivalWorktrees(festivalDir)).length > 0;
}

/** Drop worktree rows whose directories no longer exist (cleanup after manual removal). */
export async function pruneFestivalWorktrees(festivalDir: string): Promise<void> {
  const rows = await readFestivalWorktrees(festivalDir);
  const kept: FestivalWorktree[] = [];
  for (const row of rows) {
    const info = await lstat(row.worktreePath).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
    if (info) kept.push(row);
  }
  await writeFestivalWorktrees(festivalDir, kept);
}
