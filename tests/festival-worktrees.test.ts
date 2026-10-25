import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvedWorktreeSourceDirectory, createFestivalWorktrees, festivalWorktreesPending,
  mergeFestivalWorktrees, readFestivalWorktrees, WORKTREES_FILE,
} from "../src/application/festival-worktrees.js";
import { DEFAULT_CONVENTIONS } from "../src/domain/types.js";
import type { ExecRunner } from "../src/ports.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const exec: ExecRunner = {
  run: async (command, args, cwd) => {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
      return { stdout, stderr, code: 0 };
    } catch (error) {
      if (!error || typeof error !== "object") throw error;
      const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
      const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : error instanceof Error ? error.message : "Process execution failed";
      return { stdout, stderr, code: "code" in error && typeof error.code === "number" ? error.code : 1 };
    }
  },
};
async function git(path: string, ...args: string[]): Promise<string> {
  const result = await exec.run("git", ["-C", path, ...args]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
async function init(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, "init", "--initial-branch=main");
  await git(path, "config", "user.name", "Worktree Test");
  await git(path, "config", "user.email", "worktree@example.invalid");
  await writeFile(join(path, "source.txt"), "original\n");
  await git(path, "add", ".");
  await git(path, "commit", "-m", "initial");
}
async function fixture(workingDir = "projects/app") {
  const root = await mkdtemp(join(tmpdir(), "festival-worktrees-")); roots.push(root);
  const project = join(root, "projects/app"), other = join(root, "projects/other"), festival = join(root, "festivals/active/demo");
  await init(project); await init(other);
  await mkdir(join(project, "nested"));
  await writeFile(join(project, "nested/.gitkeep"), "");
  await git(project, "add", "nested/.gitkeep"); await git(project, "commit", "-m", "track approved subdirectory");
  await mkdir(join(festival, "001_build/01_work"), { recursive: true });
  const approved = JSON.stringify({ name: "demo", workingDir, spec: { phases: [] } }, null, 2);
  await writeFile(join(festival, "APPROVED_PLAN.json"), approved);
  await writeFile(join(festival, "001_build/01_work/SEQUENCE_GOAL.md"), `---\nfest_type: sequence\nfest_working_dir: ${JSON.stringify(workingDir)}\n---\n# Approved work\n`);
  const projects = [{ name: "app", path: project }, { name: "other", path: other }];
  return { root, project, other, festival, projects, approved };
}
async function commit(path: string, content = "festival change\n", file = "source.txt"): Promise<string> {
  await writeFile(join(path, file), content); await git(path, "add", file); await git(path, "commit", "-m", "festival changes");
  return git(path, "rev-parse", "HEAD");
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("approved festival worktrees with real Git repositories", () => {
  it("creates only the approved project, binds execution camp-relatively, and preserves approval", async () => {
    const f = await fixture();
    const rows = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.projectPath).toBe(f.project);
    expect(row.approvedWorkingDirs).toEqual(["projects/app"]);
    expect(await git(row.worktreePath, "branch", "--show-current")).toBe("fest/demo");
    expect(await readFile(join(f.festival, "APPROVED_PLAN.json"), "utf8")).toBe(f.approved);
    expect(await readFile(join(f.festival, "001_build/01_work/SEQUENCE_GOAL.md"), "utf8")).toContain(`fest_working_dir: ${JSON.stringify(relative(f.root, row.worktreePath))}`);
    expect(await approvedWorktreeSourceDirectory(f.festival, "projects/app")).toBe(row.worktreePath);
    expect(await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects)).toEqual(rows);
    expect((await git(f.other, "branch", "--list", "fest/demo"))).toBe("");
  });

  it("preserves an approved subdirectory within its owning project", async () => {
    const f = await fixture("projects/app/nested");
    const [row] = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    expect(row!.projectPath).toBe(f.project);
    expect(await approvedWorktreeSourceDirectory(f.festival, "projects/app/nested")).toBe(join(row!.worktreePath, "nested"));
    expect(await readFile(join(f.festival, "001_build/01_work/SEQUENCE_GOAL.md"), "utf8")).toContain(`${relative(f.root, row!.worktreePath)}/nested`);
  });

  it("requires approval rather than creating every camp project", async () => {
    const f = await fixture(); await rm(join(f.festival, "APPROVED_PLAN.json"));
    await expect(createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects)).rejects.toThrow();
    expect(await readFestivalWorktrees(f.festival)).toEqual([]);
  });

  it("honors conventions and adopts only the expected branch and repository", async () => {
    const f = await fixture();
    const conventions = { ...DEFAULT_CONVENTIONS, branch: "feature/{festival}", worktreeDir: ".wt/{project}/{festival}" };
    const destination = join(f.root, ".wt/app/demo");
    await git(f.project, "worktree", "add", "-b", "feature/demo", destination);
    const [row] = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects, conventions);
    expect(row!.worktreePath).toBe(destination);
    await git(destination, "switch", "-c", "unexpected");
    await expect(createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects, conventions)).rejects.toThrow("recorded branch");
    expect((await mergeFestivalWorktrees(exec, f.festival)).pending).toBe(true);
  });

  it("rejects adopting another repository even when its branch name matches", async () => {
    const f = await fixture();
    const destination = join(f.root, "projects/worktrees/app/demo");
    await init(destination); await git(destination, "switch", "-c", "fest/demo");
    await expect(createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects)).rejects.toThrow("repository does not match");
    expect(await readFestivalWorktrees(f.festival)).toEqual([]);
  });

  it("rejects a worktree path whose ancestor symlink escapes camp", async () => {
    const f = await fixture();
    const external = await mkdtemp(join(tmpdir(), "worktree-external-")); roots.push(external);
    await symlink(external, join(f.root, "escape"));
    await expect(createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects, { ...DEFAULT_CONVENTIONS, worktreeDir: "escape/{festival}" })).rejects.toThrow("escapes the camp");
  });

  it.each(["merge", "squash"] as const)("integrates and removes clean worktrees using %s", async (mode) => {
    const f = await fixture(); const [row] = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    await commit(row!.worktreePath);
    const result = await mergeFestivalWorktrees(exec, f.festival, mode);
    expect(result.pending).toBe(false); expect(result.blocked).toEqual([]); expect(result.merged).toHaveLength(1);
    expect(await readFile(join(f.project, "source.txt"), "utf8")).toBe("festival change\n");
    expect(await readFestivalWorktrees(f.festival)).toEqual([]);
    expect(await readFile(join(f.festival, "001_build/01_work/SEQUENCE_GOAL.md"), "utf8")).toContain('fest_working_dir: "projects/app"');
    expect(await approvedWorktreeSourceDirectory(f.festival, "projects/app")).toBeUndefined();
    if (mode === "squash") expect(result.retainedBranches).toEqual(["fest/demo"]);
  });

  it("blocks a wrong destination branch and dirty destination without changing either", async () => {
    const f = await fixture(); const [row] = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    await commit(row!.worktreePath); await git(f.project, "switch", "-c", "unrelated");
    const wrongBranch = await mergeFestivalWorktrees(exec, f.festival);
    expect(wrongBranch.blocked[0]!.message).toContain("recorded base branch main");
    await git(f.project, "switch", "main"); await writeFile(join(f.project, "source.txt"), "user edits\n");
    const dirty = await mergeFestivalWorktrees(exec, f.festival);
    expect(dirty.dirty).toEqual([{ worktreePath: f.project, files: ["source.txt"] }]);
    expect(await readFile(join(f.project, "source.txt"), "utf8")).toBe("user edits\n");
  });

  it("blocks a dirty worktree and repository replacement", async () => {
    const f = await fixture(); const [row] = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    await writeFile(join(row!.worktreePath, "new.txt"), "uncommitted");
    expect((await mergeFestivalWorktrees(exec, f.festival)).dirty[0]!.files).toContain("new.txt");
    await rename(f.project, `${f.project}-original`); await init(f.project);
    const result = await mergeFestivalWorktrees(exec, f.festival);
    expect(result.blocked[0]!.message).toContain("recorded identity"); expect(result.pending).toBe(true);
  });

  it("aborts normal merge conflicts safely and retains the resumable entry", async () => {
    const f = await fixture(); const [row] = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    await commit(row!.worktreePath, "festival\n"); await commit(f.project, "destination\n");
    const result = await mergeFestivalWorktrees(exec, f.festival);
    expect(result.conflicts[0]!.files).toEqual(["source.txt"]); expect(result.pending).toBe(true);
    expect(await readFile(join(f.project, "source.txt"), "utf8")).toBe("destination\n");
    expect(await git(f.project, "status", "--porcelain")).toBe("");
    await git(row!.worktreePath, "merge", "--no-commit", "-s", "ours", "main");
    await git(row!.worktreePath, "commit", "-m", "resolve destination conflict");
    const retried = await mergeFestivalWorktrees(exec, f.festival);
    expect(retried.pending).toBe(false); expect(retried.blocked).toEqual([]);
  });

  it("preserves squash-commit failure changes and resumes after a real recovery commit", async () => {
    const f = await fixture(); const [row] = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    await commit(row!.worktreePath);
    const hook = join(f.project, ".git/hooks/pre-commit"); await writeFile(hook, "#!/bin/sh\nexit 1\n"); await chmod(hook, 0o755);
    const failed = await mergeFestivalWorktrees(exec, f.festival, "squash");
    expect(failed.blocked[0]!.code).toBe("SQUASH_COMMIT_FAILED"); expect(failed.pending).toBe(true);
    expect(await readFile(join(f.project, "source.txt"), "utf8")).toBe("festival change\n");
    expect(await git(f.project, "diff", "--cached", "--name-only")).toBe("source.txt");
    await rm(hook); await git(f.project, "commit", "--no-edit");
    const recovered = await mergeFestivalWorktrees(exec, f.festival, "squash");
    expect(recovered.pending).toBe(false); expect(recovered.blocked).toEqual([]);
  });

  it.each(["merge", "squash"] as const)("keeps failed removal pending and retries %s without another integration commit", async (mode) => {
    const f = await fixture(); const [row] = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    await commit(row!.worktreePath); await git(f.project, "worktree", "lock", row!.worktreePath);
    const failed = await mergeFestivalWorktrees(exec, f.festival, mode);
    expect(failed.blocked[0]!.code).toBe("WORKTREE_REMOVE_FAILED"); expect(failed.pending).toBe(true);
    const integrated = await git(f.project, "rev-parse", "HEAD");
    await git(f.project, "worktree", "unlock", row!.worktreePath);
    const retry = await mergeFestivalWorktrees(exec, f.festival, mode);
    expect(retry.pending).toBe(false); expect(await git(f.project, "rev-parse", "HEAD")).toBe(integrated);
  });

  it("never drops a missing worktree with unmerged commits", async () => {
    const f = await fixture(); const [row] = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    const source = await commit(row!.worktreePath); await git(f.project, "worktree", "remove", row!.worktreePath);
    const result = await mergeFestivalWorktrees(exec, f.festival);
    expect(result.pending).toBe(true); expect(result.blocked[0]!.message).toContain("not proven integrated");
    expect(await git(f.project, "rev-parse", "fest/demo")).toBe(source);
    await expect(approvedWorktreeSourceDirectory(f.festival, "projects/app")).rejects.toThrow("missing");
    await git(f.project, "merge", "--no-edit", "fest/demo");
    expect((await mergeFestivalWorktrees(exec, f.festival)).pending).toBe(false);
  });

  it("blocks detached destination HEAD without integrating", async () => {
    const f = await fixture(); const [row] = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    await commit(row!.worktreePath); await git(f.project, "switch", "--detach");
    const result = await mergeFestivalWorktrees(exec, f.festival);
    expect(result.pending).toBe(true); expect(result.blocked).toHaveLength(1);
    expect(await readFile(join(f.project, "source.txt"), "utf8")).toBe("original\n");
  });

  it("preserves squash-conflict state rather than resetting user files", async () => {
    const f = await fixture(); const [row] = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    await commit(row!.worktreePath, "festival\n"); await commit(f.project, "destination\n");
    const result = await mergeFestivalWorktrees(exec, f.festival, "squash");
    expect(result.pending).toBe(true); expect(result.conflicts[0]!.files).toEqual(["source.txt"]);
    expect(await git(f.project, "diff", "--name-only", "--diff-filter=U")).toBe("source.txt");
    expect(await readFile(join(f.project, "source.txt"), "utf8")).toContain("<<<<<<<");
  });

  it("persists each completed project even while a different project is blocked", async () => {
    const f = await fixture();
    await writeFile(join(f.festival, "APPROVED_PLAN.json"), JSON.stringify({ workingDir: "projects/app", projects: ["projects/other"] }));
    const rows = await createFestivalWorktrees(exec, f.root, f.festival, "demo", f.projects);
    for (const row of rows) await commit(row.worktreePath);
    await writeFile(join(f.other, "user.txt"), "preserve");
    const result = await mergeFestivalWorktrees(exec, f.festival);
    expect(result.merged.map((row) => row.project)).toEqual(["app"]);
    expect((await readFestivalWorktrees(f.festival)).map((row) => row.project)).toEqual(["other"]);
    expect(await festivalWorktreesPending(f.festival)).toBe(true);
    await rm(join(f.other, "user.txt"));
    expect((await mergeFestivalWorktrees(exec, f.festival)).pending).toBe(false);
  });

  it("fails closed on malformed manifests instead of filtering away recorded work", async () => {
    const f = await fixture(); await writeFile(join(f.festival, WORKTREES_FILE), JSON.stringify([{ project: "lost" }]));
    await expect(readFestivalWorktrees(f.festival)).rejects.toThrow("Invalid worktree manifest");
  });
});
