/**
 * fest_working_dir stamping + resolution: scaffold from-plan emits
 * SEQUENCE_GOAL.md without the key and fest next refuses without it.
 * Covers stamping into real sequence goals, idempotency, and the
 * project-resolution ladder (explicit > single project > "." > ambiguous).
 */
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkingDir, stampWorkingDir } from "../src/application/sequence-goals.js";
import { festivalConstraints, seedFestivalRules, stampGateRules } from "../src/application/festival-rules.js";
import type { CampCli } from "../src/ports.js";

const NO_PROJECTS = {
  projects: () => Promise.resolve([]),
} as unknown as CampCli;

async function makeSequenceGoal(festivalDir: string, phase: string, seq: string): Promise<string> {
  const dir = join(festivalDir, phase, seq);
  await mkdir(dir, { recursive: true });
  const goal = join(dir, "SEQUENCE_GOAL.md");
  await writeFile(
    goal,
    [
      "---",
      "fest_type: sequence",
      `fest_id: ${seq}`,
      "fest_tracking: true",
      "---",
      "",
      "# Sequence Goal: x",
    ].join("\n"),
  );
  return goal;
}

describe("stampWorkingDir", () => {
  it("writes fest_working_dir into every sequence goal frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seq-goal-"));
    const a = await makeSequenceGoal(dir, "001_BUILD", "01_core");
    const b = await makeSequenceGoal(dir, "001_BUILD", "02_ui");
    await makeSequenceGoal(dir, "002_VERIFY", "01_checks");

    expect(await stampWorkingDir(dir, "projects/app")).toBe(3);
    const text = await readFile(a, "utf8");
    expect(text).toContain('fest_working_dir: "projects/app"');
    // inside frontmatter, before the closing ---
    expect(text.indexOf("fest_working_dir")).toBeLessThan(text.indexOf("---", 4));
    const bText = await readFile(b, "utf8");
    expect(bText).toContain('fest_working_dir: "projects/app"');
  });

  it("is idempotent — never double-writes the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seq-goal-"));
    const goal = await makeSequenceGoal(dir, "001_BUILD", "01_core");
    await stampWorkingDir(dir, "projects/app");
    expect(await stampWorkingDir(dir, "projects/other")).toBe(0);
    const text = await readFile(goal, "utf8");
    expect(text.match(/fest_working_dir/g)).toHaveLength(1);
  });
});

describe("resolveWorkingDir", () => {
  it("resolves explicit paths from camp root and rejects missing targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "wd-"));
    await mkdir(join(root, "projects", "api"), { recursive: true });
    const r = await resolveWorkingDir(root, NO_PROJECTS, "projects/api");
    expect(r.dir).toBe("projects/api");
    await expect(resolveWorkingDir(root, NO_PROJECTS, "projects/missing")).rejects.toThrow("does not exist from the camp root");
  });

  it("converts an external checkout to its camp projects link", async () => {
    const root = await mkdtemp(join(tmpdir(), "wd-"));
    const external = await mkdtemp(join(tmpdir(), "external-project-"));
    await mkdir(join(root, "projects"), { recursive: true });
    await symlink(external, join(root, "projects", "linked"));
    const result = await resolveWorkingDir(root, NO_PROJECTS, external);
    expect(result.dir).toBe("projects/linked");
    const absolute = await resolveWorkingDir(root, NO_PROJECTS, resolve(root, "projects/linked"));
    expect(absolute.dir).toBe("projects/linked");
  });

  it("picks the single project on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "wd-"));
    await mkdir(join(root, "projects", "api"), { recursive: true });
    const r = await resolveWorkingDir(root, NO_PROJECTS);
    expect(r.dir).toBe("projects/api");
  });

  it("defaults to '.' when the camp has no projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "wd-"));
    await mkdir(join(root, "projects"), { recursive: true });
    const r = await resolveWorkingDir(root, NO_PROJECTS);
    expect(r.dir).toBe(".");
  });

  it("returns no dir (ambiguous) with multiple projects and no param", async () => {
    const root = await mkdtemp(join(tmpdir(), "wd-"));
    await mkdir(join(root, "projects", "api"), { recursive: true });
    await mkdir(join(root, "projects", "web"), { recursive: true });
    const r = await resolveWorkingDir(root, NO_PROJECTS);
    expect(r.dir).toBeUndefined();
    expect(r.candidates).toEqual(["projects/api", "projects/web"]);
  });

  it("uses camp.projects as the authoritative project list", async () => {
    const root = await mkdtemp(join(tmpdir(), "wd-"));
    await mkdir(join(root, "projects", "lib"), { recursive: true });
    const camp = {
      projects: () => Promise.resolve([{ name: "lib", path: "projects/lib" }]),
    } as unknown as CampCli;
    const r = await resolveWorkingDir(root, camp);
    expect(r.dir).toBe("projects/lib");
  });
});

describe("seedFestivalRules", () => {
  it("seeds the camp template and appends the human's constraints verbatim", async () => {
    const camp = await mkdtemp(join(tmpdir(), "rules-camp-"));
    const templateDir = join(camp, "festivals", ".festival", "templates", "festival");
    await mkdir(templateDir, { recursive: true });
    await writeFile(join(templateDir, "RULES.md"), "# Festival Rules\n\n## Engineering Excellence\n");
    const fest = await mkdtemp(join(tmpdir(), "rules-fest-"));

    const r = await seedFestivalRules(camp, fest, "- no new deps\n- tests mandatory");
    expect(r).toEqual({ file: "FESTIVAL_RULES.md", seeded: true, constraints: true, campRules: false });
    const text = await readFile(join(fest, "FESTIVAL_RULES.md"), "utf8");
    expect(text).toContain("## Engineering Excellence");
    expect(text).toContain("## Constraints & Rules (agreed during planning)");
    expect(text).toContain("- no new deps\n- tests mandatory");
  });

  it("uses the fallback skeleton when the camp has no template", async () => {
    const camp = await mkdtemp(join(tmpdir(), "rules-camp-"));
    const fest = await mkdtemp(join(tmpdir(), "rules-fest-"));
    const r = await seedFestivalRules(camp, fest);
    expect(r.seeded).toBe(true);
    expect(r.constraints).toBe(false);
    expect(await readFile(join(fest, "FESTIVAL_RULES.md"), "utf8")).toContain("# Festival Rules");
  });

  it("is idempotent — never duplicates the constraints section", async () => {
    const camp = await mkdtemp(join(tmpdir(), "rules-camp-"));
    const fest = await mkdtemp(join(tmpdir(), "rules-fest-"));
    await seedFestivalRules(camp, fest, "- rule one");
    const again = await seedFestivalRules(camp, fest, "- rule one");
    const text = await readFile(join(fest, "FESTIVAL_RULES.md"), "utf8");
    expect(text.match(/Constraints & Rules/g)).toHaveLength(1);
    expect(again.seeded).toBe(false);
  });
});

describe("stampGateRules", () => {
  const GATE_DOC = [
    "---",
    "fest_type: gate",
    "fest_gate_id: testing",
    "fest_status: pending",
    "---",
    "",
    "# Gate: Testing and Verification",
    "",
    "- [ ] All unit tests pass",
  ].join("\n");

  it("stamps constraints into every gate task, skipping plain tasks", async () => {
    const camp = await mkdtemp(join(tmpdir(), "gr-camp-"));
    const fest = await mkdtemp(join(tmpdir(), "gr-fest-"));
    const seq = join(fest, "001_BUILD", "01_core");
    await mkdir(seq, { recursive: true });
    await writeFile(join(seq, "03_testing.md"), GATE_DOC);
    await writeFile(join(seq, "04_review.md"), GATE_DOC.replace("testing", "review"));
    await writeFile(join(seq, "01_impl.md"), "---\nfest_type: task\n---\n\n# Task\n");
    await seedFestivalRules(camp, fest, "- no new deps\n- tests mandatory");

    expect(await stampGateRules(fest)).toBe(2);
    const gate = await readFile(join(seq, "03_testing.md"), "utf8");
    expect(gate).toContain("## Constraints & Rules (agreed during planning)");
    expect(gate).toContain("- no new deps");
    expect(gate).toContain("a violated rule fails this gate");
    const task = await readFile(join(seq, "01_impl.md"), "utf8");
    expect(task).not.toContain("Constraints & Rules");
  });

  it("is idempotent and returns 0 without recorded constraints", async () => {
    const camp = await mkdtemp(join(tmpdir(), "gr-camp-"));
    const fest = await mkdtemp(join(tmpdir(), "gr-fest-"));
    const seq = join(fest, "001_BUILD", "01_core");
    await mkdir(seq, { recursive: true });
    await writeFile(join(seq, "03_testing.md"), GATE_DOC);
    // no rules file at all → nothing to enforce
    expect(await stampGateRules(fest)).toBe(0);
    await seedFestivalRules(camp, fest, "- rule");
    await stampGateRules(fest);
    expect(await stampGateRules(fest)).toBe(0);
  });
});

describe("festivalConstraints", () => {
  it("returns only the recorded constraints section, not template boilerplate", async () => {
    const camp = await mkdtemp(join(tmpdir(), "gr-camp-"));
    const templateDir = join(camp, "festivals", ".festival", "templates", "festival");
    await mkdir(templateDir, { recursive: true });
    await writeFile(join(templateDir, "RULES.md"), "# Festival Rules\n\n## Boilerplate Section\n\n- generic\n");
    const fest = await mkdtemp(join(tmpdir(), "gr-fest-"));
    await seedFestivalRules(camp, fest, "- human rule");
    const c = await festivalConstraints(fest);
    expect(c).toContain("- human rule");
    expect(c).not.toContain("Boilerplate");
  });

  it("returns undefined when the festival has no constraints", async () => {
    const fest = await mkdtemp(join(tmpdir(), "gr-fest-"));
    expect(await festivalConstraints(fest)).toBeUndefined();
  });
});
