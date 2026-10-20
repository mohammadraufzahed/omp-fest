/**
 * fest_working_dir stamping + resolution: scaffold from-plan emits
 * SEQUENCE_GOAL.md without the key and fest next refuses without it.
 * Covers stamping into real sequence goals, idempotency, and the
 * project-resolution ladder (explicit > single project > "." > ambiguous).
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkingDir, stampWorkingDir } from "../src/application/sequence-goals.js";
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
  it("uses the explicit param when given", async () => {
    const root = await mkdtemp(join(tmpdir(), "wd-"));
    await mkdir(join(root, "projects", "api"), { recursive: true });
    const r = await resolveWorkingDir(root, NO_PROJECTS, "projects/web");
    expect(r.dir).toBe("projects/web");
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

  it("falls back to camp.projects when projects/ is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "wd-"));
    const camp = {
      projects: () => Promise.resolve([{ name: "lib", path: "projects/lib" }]),
    } as unknown as CampCli;
    const r = await resolveWorkingDir(root, camp);
    expect(r.dir).toBe("projects/lib");
  });
});
