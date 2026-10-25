/** Wave tests: festival worktrees (crash-resumable create/merge), delegateMode config, ownership release. */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFestivalWorktrees, mergeFestivalWorktrees, readFestivalWorktrees, WORKTREES_FILE } from "../src/application/festival-worktrees.js";
import { claimFestivalOwnership, festivalOwner, releaseFestivalOwnership } from "../src/application/festival-ownership.js";
import { loadConfig } from "../src/domain/config.js";
import type { ExecRunner } from "../src/ports.js";

interface GitCall { args: string[] }

function fakeExec(overrides?: { status?: string; mergeCode?: number; unmerged?: string; removeCode?: number; isGit?: boolean }) {
  const calls: GitCall[] = [];
  const exec: ExecRunner = {
    run: (_command: string, args: string[]) => {
      calls.push({ args });
      const key = args.join(" ");
      if (key.includes("rev-parse --git-dir")) return Promise.resolve({ stdout: "", stderr: "", code: overrides?.isGit === false ? 128 : 0 });
      if (key.includes("--abbrev-ref HEAD")) return Promise.resolve({ stdout: "main\n", stderr: "", code: 0 });
      if (key.includes("rev-parse HEAD")) return Promise.resolve({ stdout: "abc123\n", stderr: "", code: 0 });
      if (key.includes("show-ref")) return Promise.resolve({ stdout: "", stderr: "", code: 1 });
      if (key.includes("status --porcelain")) return Promise.resolve({ stdout: overrides?.status ?? "", stderr: "", code: 0 });
      if (key.includes("merge --abort")) return Promise.resolve({ stdout: "", stderr: "", code: 0 });
      if (key.includes("diff --name-only")) return Promise.resolve({ stdout: overrides?.unmerged ?? "", stderr: "", code: 0 });
      if (key.includes(" merge ")) return Promise.resolve({ stdout: "", stderr: overrides?.mergeCode ? "conflict" : "", code: overrides?.mergeCode ?? 0 });
      if (key.includes("worktree remove")) return Promise.resolve({ stdout: "", stderr: "", code: overrides?.removeCode ?? 0 });
      return Promise.resolve({ stdout: "", stderr: "", code: 0 });
    },
  };
  return { exec, calls };
}

async function makeCampWithProject(): Promise<{ root: string; project: string; festivalDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "ompfest-wt-"));
  const project = join(root, "projects", "app");
  const festivalDir = join(root, "festivals", "active", "demo");
  await mkdir(project, { recursive: true });
  await mkdir(festivalDir, { recursive: true });
  return { root, project, festivalDir };
}

describe("festival worktrees", () => {
  it("creates a fest/<name> worktree per git project and records the manifest", async () => {
    const { root, project, festivalDir } = await makeCampWithProject();
    const { exec, calls } = fakeExec();
    const rows = await createFestivalWorktrees(exec, root, festivalDir, "demo", [{ name: "app", path: project }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.branch).toBe("fest/demo");
    expect(rows[0]!.worktreePath).toBe(join(root, "projects", "worktrees", "app", "demo"));
    const add = calls.find((call) => call.args.join(" ").includes("worktree add"));
    expect(add?.args).toContain("-b");
    expect(add?.args).toContain("fest/demo");
    const manifest = JSON.parse(await readFile(join(festivalDir, WORKTREES_FILE), "utf8")) as unknown[];
    expect(manifest).toHaveLength(1);
  });

  it("skips non-git projects and stays idempotent on a rerun", async () => {
    const { root, project, festivalDir } = await makeCampWithProject();
    const { exec } = fakeExec({ isGit: false });
    const rows = await createFestivalWorktrees(exec, root, festivalDir, "demo", [{ name: "app", path: project }]);
    expect(rows).toHaveLength(0);
    const good = fakeExec();
    await createFestivalWorktrees(good.exec, root, festivalDir, "demo", [{ name: "app", path: project }]);
    const before = good.calls.length;
    await createFestivalWorktrees(good.exec, root, festivalDir, "demo", [{ name: "app", path: project }]);
    expect(good.calls.length).toBe(before);
  });

  it("merges clean worktrees, removes them, and clears the manifest", async () => {
    const { root, project, festivalDir } = await makeCampWithProject();
    const create = fakeExec();
    const rows = await createFestivalWorktrees(create.exec, root, festivalDir, "demo", [{ name: "app", path: project }]);
    await mkdir(rows[0]!.worktreePath, { recursive: true });
    const merge = fakeExec();
    const result = await mergeFestivalWorktrees(merge.exec, festivalDir);
    expect(result.merged).toHaveLength(1);
    expect(result.removed).toEqual([rows[0]!.worktreePath]);
    expect(merge.calls.some((call) => call.args.join(" ").includes("branch -d fest/demo"))).toBe(true);
    expect(await readFestivalWorktrees(festivalDir)).toHaveLength(0);
    expect(existsSync(join(festivalDir, WORKTREES_FILE))).toBe(false);
  });

  it("reports a dirty worktree and keeps the row for a resumable retry", async () => {
    const { root, project, festivalDir } = await makeCampWithProject();
    const create = fakeExec();
    const rows = await createFestivalWorktrees(create.exec, root, festivalDir, "demo", [{ name: "app", path: project }]);
    await mkdir(rows[0]!.worktreePath, { recursive: true });
    const merge = fakeExec({ status: " M src/dirty.ts\n" });
    const result = await mergeFestivalWorktrees(merge.exec, festivalDir);
    expect(result.dirty).toHaveLength(1);
    expect(result.merged).toHaveLength(0);
    expect(await readFestivalWorktrees(festivalDir)).toHaveLength(1);
  });

  it("aborts a conflicting merge, reports files, and leaves a resumable row", async () => {
    const { root, project, festivalDir } = await makeCampWithProject();
    const create = fakeExec();
    const rows = await createFestivalWorktrees(create.exec, root, festivalDir, "demo", [{ name: "app", path: project }]);
    await mkdir(rows[0]!.worktreePath, { recursive: true });
    const merge = fakeExec({ mergeCode: 1, unmerged: "src/a.ts\n" });
    const result = await mergeFestivalWorktrees(merge.exec, festivalDir);
    expect(result.conflicts).toEqual([{ project: "app", branch: "fest/demo", files: ["src/a.ts"] }]);
    expect(merge.calls.some((call) => call.args.join(" ").includes("merge --abort"))).toBe(true);
    expect(await readFestivalWorktrees(festivalDir)).toHaveLength(1);
  });

  it("drops manifest rows whose worktree vanished — crash between remove and manifest write self-heals", async () => {
    const { root, project, festivalDir } = await makeCampWithProject();
    const create = fakeExec();
    await createFestivalWorktrees(create.exec, root, festivalDir, "demo", [{ name: "app", path: project }]);
    const merge = fakeExec();
    const result = await mergeFestivalWorktrees(merge.exec, festivalDir);
    expect(result.dirty).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(await readFestivalWorktrees(festivalDir)).toHaveLength(0);
  });
});

describe("delegateMode config", () => {
  it("defaults to auto and sanitizes invalid values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ompfest-cfg-"));
    expect((await loadConfig(dir)).delegateMode).toBe("auto");
    await writeFile(join(dir, ".ompfest.json"), JSON.stringify({ delegateMode: "never" }));
    expect((await loadConfig(dir)).delegateMode).toBe("never");
    await writeFile(join(dir, ".ompfest.json"), JSON.stringify({ delegateMode: "bogus" }));
    expect((await loadConfig(dir)).delegateMode).toBe("auto");
  });
});

describe("festival ownership release", () => {
  it("removes the owner file when the session owns it, keeps a foreign live owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ompfest-own-"));
    await claimFestivalOwnership(dir, "session-a");
    expect(await releaseFestivalOwnership(dir, "session-a")).toBe("released");
    expect(await festivalOwner(dir)).toBeUndefined();
    await claimFestivalOwnership(dir, "session-b");
    expect(await releaseFestivalOwnership(dir, "session-c")).toBe("kept");
    expect((await festivalOwner(dir))?.sessionId).toBe("session-b");
  });
});
