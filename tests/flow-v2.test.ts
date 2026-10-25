/** Configuration and ownership lifecycle behavior. Real worktree safety lives in festival-worktrees.test.ts. */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimFestivalOwnership, festivalOwner, releaseFestivalOwnership } from "../src/application/festival-ownership.js";
import { loadConfig } from "../src/domain/config.js";

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
