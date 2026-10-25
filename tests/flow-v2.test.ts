/** Wave tests: festival worktrees (crash-resumable create/merge), delegateMode config, ownership release. */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFestivalWorktrees, mergeFestivalWorktrees, readFestivalWorktrees, WORKTREES_FILE } from "../src/application/festival-worktrees.js";
import { claimFestivalOwnership, festivalOwner, releaseFestivalOwnership } from "../src/application/festival-ownership.js";
import { loadConfig } from "../src/domain/config.js";
import { DEFAULT_CONVENTIONS } from "../src/domain/types.js";
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

  it("honors convention templates for branch and worktree dir", async () => {
    const { root, project, festivalDir } = await makeCampWithProject();
    const create = fakeExec();
    const conventions = { ...DEFAULT_CONVENTIONS, branch: "feature/{festival}", worktreeDir: ".wt/{project}/{festival}" };
    const rows = await createFestivalWorktrees(create.exec, root, festivalDir, "demo", [{ name: "app", path: project }], conventions);
    expect(rows[0]!.branch).toBe("feature/demo");
    expect(rows[0]!.worktreePath).toBe(join(root, ".wt", "app", "demo"));
    const add = create.calls.find((call) => call.args.join(" ").includes("worktree add"));
    expect(add?.args.join(" ")).toContain("-b feature/demo");
  });

  it("squash-merges worktrees when finishMerge=squash", async () => {
    const { root, project, festivalDir } = await makeCampWithProject();
    const create = fakeExec();
    const rows = await createFestivalWorktrees(create.exec, root, festivalDir, "demo", [{ name: "app", path: project }]);
    await mkdir(rows[0]!.worktreePath, { recursive: true });
    const merge = fakeExec();
    const result = await mergeFestivalWorktrees(merge.exec, festivalDir, "squash");
    expect(result.merged).toHaveLength(1);
    expect(merge.calls.some((call) => call.args.join(" ").includes("merge --squash fest/demo"))).toBe(true);
    expect(merge.calls.some((call) => call.args.join(" ").includes("commit --no-edit"))).toBe(true);
    expect(result.removed).toEqual([rows[0]!.worktreePath]);
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

import { campRules, campRulesCount, festivalCampRules, seedFestivalRules, stampGateRules, syncCampRules, CAMP_RULES_FILE } from "../src/application/festival-rules.js";

async function makeRulesCamp(withRules = true): Promise<{ root: string; festivalDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "ompfest-rules-"));
  const festivalDir = join(root, "festivals", "active", "demo");
  await mkdir(festivalDir, { recursive: true });
  if (withRules) await writeFile(join(root, CAMP_RULES_FILE), "# Camp Rules\n\n- never edit generated files\n- tests required\n");
  return { root, festivalDir };
}

describe("camp rules", () => {
  it("seeds camp RULES.md into FESTIVAL_RULES.md inside markers", async () => {
    const { root, festivalDir } = await makeRulesCamp();
    const result = await seedFestivalRules(root, festivalDir, "custom constraint");
    expect(result.campRules).toBe(true);
    const text = await readFile(join(festivalDir, "FESTIVAL_RULES.md"), "utf8");
    expect(text).toContain("<!-- omp-fest:camp-rules -->");
    expect(text).toContain("never edit generated files");
    expect(text).toContain("custom constraint");
    expect(campRulesCount(await campRules(root))).toBe(2);
    expect(await festivalCampRules(festivalDir)).toContain("tests required");
  });

  it("syncs a drifted camp block and preserves text outside the markers", async () => {
    const { root, festivalDir } = await makeRulesCamp();
    await seedFestivalRules(root, festivalDir, "keep me");
    await writeFile(join(root, CAMP_RULES_FILE), "# Camp Rules\n\n- changed rule\n");
    expect(await syncCampRules(root)).toBe(1);
    const text = await readFile(join(festivalDir, "FESTIVAL_RULES.md"), "utf8");
    expect(text).toContain("changed rule");
    expect(text).not.toContain("never edit generated files");
    expect(text).toContain("keep me");
    expect(await syncCampRules(root)).toBe(0);
  });

  it("appends the block to a native festival file, seeds a missing one, honors opt-out", async () => {
    const { root, festivalDir } = await makeRulesCamp();
    await writeFile(join(festivalDir, "FESTIVAL_RULES.md"), "# Festival Rules\n\nNative content.\n");
    expect(await syncCampRules(root)).toBe(1);
    expect((await readFile(join(festivalDir, "FESTIVAL_RULES.md"), "utf8"))).toContain("Native content.");
    const empty = join(root, "festivals", "active", "bare");
    await mkdir(empty, { recursive: true });
    expect(await syncCampRules(root)).toBe(1);
    expect(await festivalCampRules(empty)).toContain("never edit generated files");
    const opted = join(root, "festivals", "active", "opted");
    await mkdir(opted, { recursive: true });
    await writeFile(join(opted, "FESTIVAL_RULES.md"), "# Own rules\n<!-- omp-fest:no-camp-rules -->\n");
    expect(await syncCampRules(root)).toBe(0);
    expect((await readFile(join(opted, "FESTIVAL_RULES.md"), "utf8"))).not.toContain("Camp Rules");
  });

  it("removes the marked block when camp RULES.md is deleted", async () => {
    const { root, festivalDir } = await makeRulesCamp();
    await seedFestivalRules(root, festivalDir);
    const { rm } = await import("node:fs/promises");
    await rm(join(root, CAMP_RULES_FILE));
    expect(await syncCampRules(root)).toBe(1);
    expect((await readFile(join(festivalDir, "FESTIVAL_RULES.md"), "utf8"))).not.toContain("omp-fest:camp-rules");
  });

  it("stamps camp rules into gate tasks alongside planning constraints", async () => {
    const { root, festivalDir } = await makeRulesCamp();
    await seedFestivalRules(root, festivalDir, "constraint one");
    const gateDir = join(festivalDir, "001_phase", "seq1");
    await mkdir(gateDir, { recursive: true });
    await writeFile(join(gateDir, "gate.md"), "---\nfest_type: gate\n---\n# Gate\n");
    expect(await stampGateRules(festivalDir)).toBe(1);
    const stamped = await readFile(join(gateDir, "gate.md"), "utf8");
    expect(stamped).toContain("constraint one");
    expect(stamped).toContain("never edit generated files");
    expect(await stampGateRules(festivalDir)).toBe(0);
  });
});
