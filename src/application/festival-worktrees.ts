/** Approved-project worktrees, with durable per-entry integration and reversible failures. */
import { lstat, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeAtomically } from "./fs-atomic.js";
import { withStaleAwareLock } from "./fs-lock.js";
import { conventionWorktreeDir, renderConvention } from "./conventions.js";
import { DEFAULT_CONVENTIONS, type CampProject, type Conventions } from "../domain/types.js";
import type { ExecRunner } from "../ports.js";

export const WORKTREES_FILE = ".omp-fest-worktrees.json";
interface IntegrationReceipt {
  sourceCommit: string;
  destinationCommit: string;
  integratedCommit?: string;
  squashTree?: string;
}
export interface FestivalWorktree {
  project: string;
  projectPath: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  repositoryIdentity?: string;
  /** Immutable approved project/subdirectory declarations, not execution paths. */
  approvedWorkingDirs?: string[];
  integration?: IntegrationReceipt;
}
export interface WorktreeMergeConflict { project: string; branch: string; files: string[] }
export interface WorktreeMergeResult {
  merged: FestivalWorktree[];
  removed: string[];
  conflicts: WorktreeMergeConflict[];
  dirty: { worktreePath: string; files: string[] }[];
  blocked: { project: string; code: string; message: string }[];
  retainedBranches: string[];
  pending: boolean;
}
function enoent(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function manifestPath(festivalDir: string): string { return join(festivalDir, WORKTREES_FILE); }
async function exists(path: string): Promise<boolean> { return !!await lstat(path).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; }); }

export async function readFestivalWorktrees(festivalDir: string): Promise<FestivalWorktree[]> {
  const text = await readFile(manifestPath(festivalDir), "utf8").catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
  if (text === undefined) return [];
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || !value.every((row: unknown) => record(row) &&
    ["project", "projectPath", "worktreePath", "branch", "baseBranch", "baseCommit"].every((key) => typeof row[key] === "string" && !!row[key]) &&
    (row.repositoryIdentity === undefined || typeof row.repositoryIdentity === "string") &&
    (row.approvedWorkingDirs === undefined || (Array.isArray(row.approvedWorkingDirs) && row.approvedWorkingDirs.every((path: unknown) => typeof path === "string" && !!path))) &&
    (row.integration === undefined || (record(row.integration) && typeof row.integration.sourceCommit === "string" && typeof row.integration.destinationCommit === "string" &&
      (row.integration.integratedCommit === undefined || typeof row.integration.integratedCommit === "string") && (row.integration.squashTree === undefined || typeof row.integration.squashTree === "string"))))) {
    throw new Error(`Invalid worktree manifest: ${manifestPath(festivalDir)}; preserve it and repair the recorded entries.`);
  }
  return value as FestivalWorktree[];
}
async function writeFestivalWorktrees(festivalDir: string, rows: FestivalWorktree[]): Promise<void> {
  if (!rows.length) { await rm(manifestPath(festivalDir), { force: true }); return; }
  await writeAtomically(manifestPath(festivalDir), `${JSON.stringify(rows, null, 2)}\n`);
}
async function gitOutput(exec: ExecRunner, dir: string, args: string[]): Promise<string> {
  const result = await exec.run("git", ["-C", dir, ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}
async function repositoryIdentity(exec: ExecRunner, path: string): Promise<string> {
  const top = await realpath(await gitOutput(exec, path, ["rev-parse", "--show-toplevel"]));
  if (top !== await realpath(path)) throw new Error(`Expected a repository checkout root at ${path}, found ${top}`);
  const common = await realpath(resolve(path, await gitOutput(exec, path, ["rev-parse", "--git-common-dir"])));
  const info = await stat(common);
  return `${common}:${info.dev}:${info.ino}`;
}
async function currentBranch(exec: ExecRunner, path: string): Promise<string> {
  return gitOutput(exec, path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}
async function verifyWorktree(exec: ExecRunner, row: FestivalWorktree): Promise<void> {
  const identity = await repositoryIdentity(exec, row.projectPath);
  if (row.repositoryIdentity && identity !== row.repositoryIdentity) throw new Error("Destination repository no longer matches recorded identity");
  if (identity !== await repositoryIdentity(exec, row.worktreePath)) throw new Error(`Worktree repository does not match ${row.projectPath}`);
  if (await currentBranch(exec, row.worktreePath) !== row.branch) throw new Error(`Worktree is not on recorded branch ${row.branch}: ${row.worktreePath}`);
  if (await realpath(row.projectPath) === await realpath(row.worktreePath)) throw new Error("Worktree must not be the destination checkout");
}
async function approvedDirectories(festivalDir: string): Promise<string[]> {
  const artifact: unknown = JSON.parse(await readFile(join(festivalDir, "APPROVED_PLAN.json"), "utf8"));
  if (!record(artifact) || typeof artifact.workingDir !== "string" || !artifact.workingDir.trim()) throw new Error("Worktrees require an approved plan with workingDir");
  const dirs = [artifact.workingDir];
  if (artifact.projects !== undefined) {
    if (!Array.isArray(artifact.projects)) throw new Error("Approved plan projects must be an array of project paths");
    for (const project of artifact.projects as unknown[]) {
      const path = typeof project === "string" ? project : record(project) ? project.workingDir ?? project.path : undefined;
      if (typeof path !== "string" || !path.trim()) throw new Error("Approved project declaration requires a path or workingDir");
      dirs.push(path);
    }
  }
  return [...new Set(dirs)];
}
async function safeWorktreePath(campRoot: string, target: string): Promise<void> {
  let ancestor = target;
  while (!await exists(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
  if (!inside(await realpath(campRoot), await realpath(ancestor))) throw new Error(`Worktree path escapes the camp through a symlink: ${target}`);
}

/** Resolve source reads without changing the approved artifact or hashing a transient execution path. */
export async function approvedWorktreeSourceDirectory(festivalDir: string, approvedWorkingDir: string): Promise<string | undefined> {
  for (const row of await readFestivalWorktrees(festivalDir)) {
    if (row.approvedWorkingDirs?.includes(approvedWorkingDir)) {
      const original = resolve(festivalDir, "../../..", approvedWorkingDir);
      const subdir = relative(row.projectPath, await realpath(original));
      if (!inside(row.projectPath, resolve(row.projectPath, subdir))) throw new Error("Approved worktree source escapes project");
      if (!await exists(row.worktreePath)) {
        if (!row.integration?.integratedCommit) throw new Error("Approved execution worktree is missing before proven integration");
        return resolve(row.projectPath, subdir);
      }
      return resolve(row.worktreePath, subdir);
    }
  }
  return undefined;
}

async function bindSequenceDirectories(campRoot: string, festivalDir: string, rows: FestivalWorktree[], primary: string, restore = false): Promise<void> {
  const bindings = new Map<string, string>();
  for (const row of rows) for (const original of row.approvedWorkingDirs ?? []) {
    const path = resolve(row.worktreePath, relative(row.projectPath, await realpath(resolve(campRoot, original))));
    const execution = relative(campRoot, path).split(sep).join("/");
    bindings.set(restore ? execution : original, restore ? original : execution);
  }
  for (const phase of await readdir(festivalDir, { withFileTypes: true })) {
    if (!phase.isDirectory() || !/^\d{3}_/.test(phase.name)) continue;
    for (const sequence of await readdir(join(festivalDir, phase.name), { withFileTypes: true })) {
      if (!sequence.isDirectory()) continue;
      const goal = join(festivalDir, phase.name, sequence.name, "SEQUENCE_GOAL.md");
      const text = await readFile(goal, "utf8").catch((error: unknown) => { if (enoent(error)) return undefined; throw error; });
      if (text === undefined) continue;
      const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
      if (front?.[1] === undefined) throw new Error(`Sequence goal lacks frontmatter: ${goal}`);
      const match = /^fest_working_dir:\s*(.*?)\s*$/m.exec(front[1]);
      let original = primary;
      if (match) {
        const raw = match[1] ?? "";
        original = raw.startsWith('"') ? JSON.parse(raw) as string : raw.replace(/^'(.*)'$/, "$1");
      }
      if ([...bindings.values()].includes(original)) continue;
      const execution = bindings.get(original);
      if (!execution) {
        if (restore || !bindings.size) continue;
        throw new Error(`Sequence working directory is not an approved project: ${original}`);
      }
      const line = `fest_working_dir: ${JSON.stringify(execution)}`;
      const body = match ? front[1].replace(/^fest_working_dir:.*$/m, line) : `${front[1]}\n${line}`;
      await writeAtomically(goal, `---\n${body}\n---\n${text.slice(front[0].length)}`);
    }
  }
}

/** Create only approved project worktrees. Existing directories are adopted only after Git identity checks. */
export async function createFestivalWorktrees(exec: ExecRunner, campRoot: string, festivalDir: string, festivalName: string, projects: CampProject[], conventions: Conventions = DEFAULT_CONVENTIONS): Promise<FestivalWorktree[]> {
  return withStaleAwareLock(`${manifestPath(festivalDir)}.lock`, async () => {
    const approved = await approvedDirectories(festivalDir);
    const rows = await readFestivalWorktrees(festivalDir);
    const selected = new Map<string, { project: string; declarations: string[] }>();
    const registered = await Promise.all(projects.map(async (project) => ({ ...project, actual: await realpath(resolve(campRoot, project.path)).catch((error: unknown) => { if (enoent(error)) return undefined; throw error; }) })));
    for (const declaration of approved) {
      const actual = await realpath(resolve(campRoot, declaration));
      const project = registered.filter((item): item is CampProject & { actual: string } => !!item.actual && inside(item.actual, actual)).sort((a, b) => b.actual.length - a.actual.length)[0];
      const projectPath = project?.actual ?? actual;
      const isGit = await exec.run("git", ["-C", projectPath, "rev-parse", "--git-dir"]);
      if (isGit.code !== 0) continue;
      await repositoryIdentity(exec, projectPath);
      const entry = selected.get(projectPath) ?? { project: project?.name ?? basename(projectPath), declarations: [] };
      entry.declarations.push(declaration); selected.set(projectPath, entry);
    }
    for (const row of rows) if (!selected.has(await realpath(row.projectPath))) throw new Error(`Recorded worktree is outside the approved project scope: ${row.project}`);
    const branch = renderConvention(conventions.branch, { festival: festivalName });
    await gitOutput(exec, campRoot, ["check-ref-format", "--branch", branch]);
    for (const [projectPath, selection] of selected) {
      const existing = rows.find((row) => row.projectPath === projectPath);
      if (existing) {
        await verifyWorktree(exec, existing);
        existing.repositoryIdentity = await repositoryIdentity(exec, projectPath);
        existing.approvedWorkingDirs = selection.declarations;
        await writeFestivalWorktrees(festivalDir, rows);
        continue;
      }
      const baseBranch = await currentBranch(exec, projectPath);
      if (branch === baseBranch) throw new Error("Festival branch must differ from the destination base branch");
      const baseCommit = await gitOutput(exec, projectPath, ["rev-parse", "HEAD"]);
      const worktreePath = conventionWorktreeDir(conventions, campRoot, projectPath, festivalName);
      await safeWorktreePath(campRoot, worktreePath);
      const row: FestivalWorktree = { project: selection.project, projectPath, worktreePath, branch, baseBranch, baseCommit, repositoryIdentity: await repositoryIdentity(exec, projectPath), approvedWorkingDirs: selection.declarations };
      if (!await exists(worktreePath)) {
        const branchExists = (await exec.run("git", ["-C", projectPath, "show-ref", "--verify", `refs/heads/${branch}`])).code === 0;
        await gitOutput(exec, projectPath, ["worktree", "add", worktreePath, ...(branchExists ? [branch] : ["-b", branch, baseCommit])]);
      }
      await verifyWorktree(exec, row);
      rows.push(row); await writeFestivalWorktrees(festivalDir, rows);
    }
    const primary = approved[0];
    if (!primary) throw new Error("Approved plan must identify a project before creating worktrees");
    await bindSequenceDirectories(campRoot, festivalDir, rows, primary);
    return rows;
  });
}
async function dirtyFiles(exec: ExecRunner, path: string): Promise<string[]> {
  const status = await exec.run("git", ["-C", path, "status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0) throw new Error(`Cannot inspect checkout status at ${path}: ${status.stderr}`);
  return status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3));
}
async function ancestor(exec: ExecRunner, path: string, commit: string, head: string): Promise<boolean> {
  const result = await exec.run("git", ["-C", path, "merge-base", "--is-ancestor", commit, head]);
  if (result.code > 1) throw new Error(result.stderr || "Cannot establish merge ancestry");
  return result.code === 0;
}

/** Fail closed before merging; every removal and integration receipt is persisted independently. */
export async function mergeFestivalWorktrees(exec: ExecRunner, festivalDir: string, mode: "merge" | "squash" = "merge"): Promise<WorktreeMergeResult> {
  return withStaleAwareLock(`${manifestPath(festivalDir)}.lock`, async () => {
    const rows = await readFestivalWorktrees(festivalDir);
    const remaining = [...rows];
    const result: WorktreeMergeResult = { merged: [], removed: [], conflicts: [], dirty: [], blocked: [], retainedBranches: [], pending: false };
    for (const row of rows) {
      try {
        const identity = await repositoryIdentity(exec, row.projectPath);
        if (row.repositoryIdentity && identity !== row.repositoryIdentity) throw new Error("Destination repository no longer matches recorded identity");
        if (await currentBranch(exec, row.projectPath) !== row.baseBranch) throw new Error(`Destination must be checked out on recorded base branch ${row.baseBranch}`);
        if (!await ancestor(exec, row.projectPath, row.baseCommit, "HEAD")) throw new Error("Destination no longer contains the recorded base commit");
        for (const state of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
          if ((await exec.run("git", ["-C", row.projectPath, "rev-parse", "--verify", state])).code === 0) throw new Error(`Destination has an unfinished Git operation (${state})`);
        }
        for (const state of ["rebase-merge", "rebase-apply", "sequencer"]) {
          const statePath = await gitOutput(exec, row.projectPath, ["rev-parse", "--git-path", state]);
          if (await exists(resolve(row.projectPath, statePath))) throw new Error(`Destination has an unfinished Git operation (${state})`);
        }
        const destinationDirty = await dirtyFiles(exec, row.projectPath);
        if (destinationDirty.length) { result.dirty.push({ worktreePath: row.projectPath, files: destinationDirty.slice(0, 25) }); continue; }
        const present = await exists(row.worktreePath);
        if (present) {
          await verifyWorktree(exec, row);
          const dirty = await dirtyFiles(exec, row.worktreePath);
          if (dirty.length) { result.dirty.push({ worktreePath: row.worktreePath, files: dirty.slice(0, 25) }); continue; }
        }
        const branchResult = await exec.run("git", ["-C", row.projectPath, "rev-parse", "--verify", `refs/heads/${row.branch}`]);
        const source = branchResult.code === 0 ? branchResult.stdout.trim() : undefined;
        const head = await gitOutput(exec, row.projectPath, ["rev-parse", "HEAD"]);
        const receipt = row.integration;
        if (receipt && source && receipt.sourceCommit !== source &&
            (receipt.integratedCommit || receipt.squashTree || await ancestor(exec, row.projectPath, receipt.sourceCommit, head))) {
          throw new Error("Worktree branch changed after integration; preserve it and review before retrying removal");
        }
        let integrated = !!receipt?.integratedCommit && await ancestor(exec, row.projectPath, receipt.integratedCommit, head);
        if (!integrated && source) integrated = await ancestor(exec, row.projectPath, source, head);
        if (!integrated && receipt?.squashTree && head !== receipt.destinationCommit) {
          integrated = await gitOutput(exec, row.projectPath, ["rev-parse", "HEAD^{tree}"]) === receipt.squashTree &&
            await gitOutput(exec, row.projectPath, ["rev-parse", "HEAD^"]) === receipt.destinationCommit;
        }
        if (!present && !integrated) throw new Error("Worktree directory is missing and its changes are not proven integrated; restore the worktree or integrate its recorded branch first");
        if (!integrated) {
          if (!source) throw new Error(`Recorded branch ${row.branch} is missing`);
          row.integration = { sourceCommit: source, destinationCommit: head };
          await writeFestivalWorktrees(festivalDir, remaining);
          const merge = await exec.run("git", ["-C", row.projectPath, "merge", ...(mode === "squash" ? ["--squash"] : ["--no-ff", "--no-edit"]), row.branch]);
          if (merge.code !== 0) {
            const files = (await gitOutput(exec, row.projectPath, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
            if (mode === "merge") {
              const abort = await exec.run("git", ["-C", row.projectPath, "merge", "--abort"]);
              if (abort.code !== 0) result.blocked.push({ project: row.project, code: "MERGE_ABORT_FAILED", message: abort.stderr || abort.stdout });
            }
            result.conflicts.push({ project: row.project, branch: row.branch, files: files.length ? files.slice(0, 25) : [merge.stderr.trim() || merge.stdout.trim()] });
            continue;
          }
          if (mode === "squash") {
            row.integration.squashTree = await gitOutput(exec, row.projectPath, ["write-tree"]);
            await writeFestivalWorktrees(festivalDir, remaining);
            const commit = await exec.run("git", ["-C", row.projectPath, "commit", "--no-edit"]);
            if (commit.code !== 0) {
              result.blocked.push({ project: row.project, code: "SQUASH_COMMIT_FAILED", message: `Staged merge is preserved for recovery: ${commit.stderr.trim() || commit.stdout.trim()}` });
              continue;
            }
          }
        }
        if (row.integration) row.integration.integratedCommit = await gitOutput(exec, row.projectPath, ["rev-parse", "HEAD"]);
        await writeFestivalWorktrees(festivalDir, remaining);
        result.merged.push(row);
        if (present) {
          const remove = await exec.run("git", ["-C", row.projectPath, "worktree", "remove", row.worktreePath]);
          if (remove.code !== 0) { result.blocked.push({ project: row.project, code: "WORKTREE_REMOVE_FAILED", message: remove.stderr.trim() || remove.stdout.trim() }); continue; }
        }
        const declared = row.approvedWorkingDirs?.[0];
        if (declared) await bindSequenceDirectories(resolve(festivalDir, "../../.."), festivalDir, [row], declared, true);
        result.removed.push(row.worktreePath);
        if (source) {
          const deleted = await exec.run("git", ["-C", row.projectPath, "branch", "-d", row.branch]);
          if (deleted.code !== 0) result.retainedBranches.push(row.branch);
        }
        remaining.splice(remaining.indexOf(row), 1);
        await writeFestivalWorktrees(festivalDir, remaining);
      } catch (error) {
        result.blocked.push({ project: row.project, code: "WORKTREE_SAFETY_CHECK_FAILED", message: error instanceof Error ? error.message : String(error) });
      }
    }
    result.pending = remaining.length > 0;
    return result;
  });
}
export async function festivalWorktreesPending(festivalDir: string): Promise<boolean> { return (await readFestivalWorktrees(festivalDir)).length > 0; }

