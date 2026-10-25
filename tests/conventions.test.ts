import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkCommitMessage,
  conventionWarnings,
  conventionWorktreeDir,
  conventionsEcho,
  festivalNameOk,
  parseConventionWords,
  renderConvention,
} from "../src/application/conventions.js";
import { loadConfig, saveConfig } from "../src/domain/config.js";
import { DEFAULT_CONVENTIONS, type Conventions } from "../src/domain/types.js";

const conv = (patch: Partial<Conventions> = {}): Conventions => ({ ...DEFAULT_CONVENTIONS, ...patch });

describe("renderConvention", () => {
  it("substitutes known placeholders and leaves unknown ones literal", () => {
    expect(renderConvention("fest/{festival}-{project}", { festival: "auth", project: "api" })).toBe("fest/auth-api");
    expect(renderConvention("x/{nope}", { festival: "a" })).toBe("x/{nope}");
  });
});

describe("conventionWarnings", () => {
  it("flags unknown placeholders and bad regexes, not valid config", () => {
    expect(conventionWarnings(conv())).toEqual([]);
    expect(conventionWarnings(conv({ branch: "{bogus}/{festival}" }))[0]).toContain("{bogus}");
    expect(conventionWarnings(conv({ festivalName: "([unclosed" }))[0]).toContain("festivalName");
  });
});

describe("festivalNameOk", () => {
  it("enforces the regex only when configured", () => {
    expect(festivalNameOk(conv(), "ANY Name!")).toEqual({ ok: true });
    expect(festivalNameOk(conv({ festivalName: "[a-z][a-z0-9-]+" }), "my-fest")).toEqual({ ok: true });
    expect(festivalNameOk(conv({ festivalName: "[a-z][a-z0-9-]+" }), "My_Fest")).toMatchObject({ ok: false, pattern: "[a-z][a-z0-9-]+" });
    expect(festivalNameOk(conv({ festivalName: "([bad" }), "anything")).toEqual({ ok: true });
  });
});

describe("conventionWorktreeDir", () => {
  it("renders inside the camp and falls back when the template escapes", async () => {
    const camp = await mkdtemp(join(tmpdir(), "conv-camp-"));
    const projectPath = join(camp, "projects", "api");
    expect(conventionWorktreeDir(conv(), camp, projectPath, "demo")).toBe(join(camp, "projects", "worktrees", "api", "demo"));
    expect(conventionWorktreeDir(conv({ worktreeDir: ".wt/{festival}" }), camp, projectPath, "demo")).toBe(join(camp, ".wt", "demo"));
    expect(conventionWorktreeDir(conv({ worktreeDir: "../escape/{festival}" }), camp, projectPath, "demo")).toBe(join(camp, "projects", "worktrees", "api", "demo"));
    expect(conventionWorktreeDir(conv({ worktreeDir: "/abs/{festival}" }), camp, projectPath, "demo")).toBe(join(camp, "projects", "worktrees", "api", "demo"));
  });
});

describe("checkCommitMessage", () => {
  const vars = { camp: "mycamp", festival: "auth" };
  it("free style passes anything through trimmed", () => {
    expect(checkCommitMessage(conv(), "  whatever  ", vars)).toEqual({ ok: true, message: "whatever" });
    expect(checkCommitMessage(conv(), "  ", vars)).toMatchObject({ ok: false });
  });
  it("conventional validates type(scope): subject", () => {
    const c = conv({ commitStyle: "conventional" });
    expect(checkCommitMessage(c, "feat(auth): add login", vars)).toEqual({ ok: true, message: "feat(auth): add login" });
    expect(checkCommitMessage(c, "fix!: breaking", vars)).toEqual({ ok: true, message: "fix!: breaking" });
    expect(checkCommitMessage(c, "added login", vars)).toMatchObject({ ok: false });
    expect(checkCommitMessage(c, "wip: not a real type", vars)).toMatchObject({ ok: false });
  });
  it("prefix auto-prepends the rendered prefix when missing", () => {
    const c = conv({ commitStyle: "prefix", commitPrefix: "[{camp}:{festival}]" });
    expect(checkCommitMessage(c, "add login", vars)).toEqual({ ok: true, message: "[mycamp:auth] add login" });
    expect(checkCommitMessage(c, "[mycamp:auth] add login", vars)).toEqual({ ok: true, message: "[mycamp:auth] add login" });
  });
});

describe("parseConventionWords", () => {
  it("maps common phrasings to a conventions patch", () => {
    expect(parseConventionWords("use conventional commits").patch.commitStyle).toBe("conventional");
    expect(parseConventionWords("feature branches").patch.branch).toBe("feature/{festival}");
    expect(parseConventionWords("feature/* branches").patch.branch).toBe("feature/{festival}");
    expect(parseConventionWords("branches named release/{festival}").patch.branch).toBe("release/{festival}");
    expect(parseConventionWords("squash merges").patch.finishMerge).toBe("squash");
    expect(parseConventionWords("merge commits").patch.finishMerge).toBe("merge");
    expect(parseConventionWords("worktrees in .wt").patch.worktreeDir).toBe(".wt/{festival}");
    expect(parseConventionWords("commit prefix [team]").patch).toMatchObject({ commitStyle: "prefix", commitPrefix: "[team]" });
    expect(parseConventionWords("kebab-case festival names").patch.festivalName).toBe("[a-z][a-z0-9-]+");
  });
  it("splits clauses and reports the ones it cannot map", () => {
    const { patch, unparsed } = parseConventionWords("conventional commits, feature branches, something about pigeons");
    expect(patch).toMatchObject({ commitStyle: "conventional", branch: "feature/{festival}" });
    expect(unparsed).toEqual(["something about pigeons"]);
  });
});

describe("conventionsEcho", () => {
  it("is a one-line summary", () => {
    expect(conventionsEcho(conv())).toBe("branch=fest/{festival} worktree=projects/worktrees/{project}/{festival} commit=free merge=merge");
    expect(conventionsEcho(conv({ commitStyle: "conventional", festivalName: "[a-z]+" }))).toContain("commit=conventional");
    expect(conventionsEcho(conv({ festivalName: "[a-z]+" }))).toContain("names=/[a-z]+/");
  });
});

describe("loadConfig conventions", () => {
  it("fills defaults, merges file keys, and keeps prior conventions on save", async () => {
    const dir = await mkdtemp(join(tmpdir(), "conv-cfg-"));
    const empty = await loadConfig(dir);
    expect(empty.conventions).toEqual(DEFAULT_CONVENTIONS);
    const saved = await saveConfig(dir, { conventions: { commitStyle: "conventional" } as Conventions });
    expect(saved.conventions.commitStyle).toBe("conventional");
    expect(saved.conventions.branch).toBe(DEFAULT_CONVENTIONS.branch);
    const again = await saveConfig(dir, { conventions: { finishMerge: "squash" } as Conventions });
    expect(again.conventions).toMatchObject({ commitStyle: "conventional", finishMerge: "squash", branch: DEFAULT_CONVENTIONS.branch });
    const reloaded = await loadConfig(dir);
    expect(reloaded.conventions.finishMerge).toBe("squash");
    expect(reloaded.configWarnings).toEqual([]);
  });
});
