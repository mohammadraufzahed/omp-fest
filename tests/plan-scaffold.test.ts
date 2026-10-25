import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeApprovedScaffold } from "../src/application/plan-scaffold.js";
import type { PlanArtifact } from "../src/application/plan-artifacts.js";
import { structuredHierarchyName } from "../src/application/structured-plan.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "plan-scaffold-"));
  roots.push(root);
  const festival = join(root, "festivals", "planning", "feature");
  const phase = join(festival, "001_BUILD");
  const sequence = join(phase, "01_core_feature");
  await mkdir(sequence, { recursive: true });
  await mkdir(join(root, "projects", "app"), { recursive: true });
  const artifact: PlanArtifact = {
    name: "feature", workingDir: join(root, "projects", "app"), rules: "- Keep the public API unchanged.\n- No new dependencies.",
    spec: {
      goal: "Enable the approved feature", scope: ["Existing feature and regression coverage"], exclusions: ["API redesign"],
      acceptance: [{ id: "AC-01", description: "Feature returns the enabled result" }], questions: [],
      inspection: [{ path: "package.json", reason: "Existing verification script" }],
      phases: [{
        id: "build", name: "Build", type: "implementation",
        objective: "Enable the approved behavior without changing the public API",
        deliverables: ["Feature behavior available to callers"],
        completionCriteria: ["Feature returns the enabled result", "Regression test exits zero"],
        sequences: [{ id: "core", name: "core_feature", tasks: [{
        id: "implement", title: "Implement_feature", description: "Enable the result without changing the API", dependsOn: [],
        implements: ["AC-01"], verifies: ["AC-01"], files: [{ path: "feature.ts", status: "existing" }],
        verification: [{ command: "npm run test", cwd: ".", evidencePath: "package.json", expected: "Regression test exits zero" }],
      }] }] }],
    },
  };
  const template = (type: string, name: string) => `---\nfest_type: ${type}\nfest_name: ${name}\nfest_id: preserved-id\nfest_status: pending\n---\n\n# Template\n\n## Objective\n[FILL: describe the objective]\n\n## Instructions\n[REPLACE: obsolete template instructions]\n\n## Human Notes\nPreserve this independently authored note.\n`;
  await writeFile(join(festival, "FESTIVAL_GOAL.md"), template("festival", "feature"));
  await writeFile(join(festival, "FESTIVAL_OVERVIEW.md"), template("festival", "feature"));
  await writeFile(join(phase, "PHASE_GOAL.md"), template("phase", "build"));
  await writeFile(join(sequence, "SEQUENCE_GOAL.md"), template("sequence", "core_feature"));
  await writeFile(join(sequence, "01_implement_feature.md"), template("task", "Implement_feature"));
  return { root, festival, phase, sequence, artifact };
}

describe("approved scaffold finalization", () => {
  it("renders marker-free goals and task contracts while retaining frontmatter, constraints, and user notes", async () => {
    const { root, festival, phase, sequence, artifact } = await fixture();
    const result = await finalizeApprovedScaffold(root, festival, artifact);
    expect(result.workingDir).toBe("projects/app");
    for (const path of result.files.filter((path) => path.endsWith(".md"))) {
      const content = await readFile(path, "utf8");
      expect(content).not.toMatch(/\[(?:FILL|REPLACE):/);
      expect(content).not.toContain("obsolete template instructions");
      expect(content).toContain("fest_id: preserved-id");
      expect(content).toContain("Preserve this independently authored note.");
    }
    expect(await readFile(join(festival, "FESTIVAL_GOAL.md"), "utf8")).toContain("API redesign");
    expect(await readFile(join(festival, "FESTIVAL_OVERVIEW.md"), "utf8")).toContain("No new dependencies.");
    expect(await readFile(join(phase, "PHASE_GOAL.md"), "utf8")).toContain("Enable the approved behavior without changing the public API");
    expect(await readFile(join(phase, "PHASE_GOAL.md"), "utf8")).toContain("Feature returns the enabled result");
    expect(await readFile(join(phase, "PHASE_GOAL.md"), "utf8")).toContain("- [ ] Regression test exits zero");
    expect(await readFile(join(sequence, "SEQUENCE_GOAL.md"), "utf8")).toContain('fest_working_dir: "projects/app"');
    const task = await readFile(join(sequence, "01_implement_feature.md"), "utf8");
    expect(task).toContain("Task ID: implement");
    expect(task).toContain("npm run test");
    expect(task).toContain("Regression test exits zero");
    expect(JSON.parse(await readFile(join(festival, "APPROVED_PLAN.json"), "utf8"))).toEqual({ ...artifact, workingDir: "projects/app" });
  });

  it("is idempotent and does not duplicate the approved contract or independently authored notes", async () => {
    const { root, festival, sequence, artifact } = await fixture();
    const first = await finalizeApprovedScaffold(root, festival, artifact);
    const contents = await Promise.all(first.files.map((path) => readFile(path, "utf8")));
    await finalizeApprovedScaffold(root, festival, artifact);
    expect(await Promise.all(first.files.map((path) => readFile(path, "utf8")))).toEqual(contents);
    expect((await readFile(join(sequence, "01_implement_feature.md"), "utf8")).match(/Task ID: implement/g)).toHaveLength(1);
  });

  it("checks the entire scaffold before replacing any template body", async () => {
    const { root, festival, sequence, artifact } = await fixture();
    const goal = join(festival, "FESTIVAL_GOAL.md");
    const before = await readFile(goal, "utf8");
    await writeFile(join(sequence, "01_implement_feature.md"), "---\nfest_name: wrong-task\n---\n");
    await expect(finalizeApprovedScaffold(root, festival, artifact)).rejects.toThrow("Scaffold name differs");
    expect(await readFile(goal, "utf8")).toBe(before);
  });

  it("refuses symlinked scaffold documents", async () => {
    const { root, festival, sequence, artifact } = await fixture();
    const target = join(root, "external.md");
    await writeFile(target, "Unrelated user data");
    const task = join(sequence, "01_implement_feature.md");
    await rm(task);
    await symlink(target, task);
    await expect(finalizeApprovedScaffold(root, festival, artifact)).rejects.toThrow("Scaffold tasks differ");
    expect(await readFile(target, "utf8")).toBe("Unrelated user data");
  });

  it("keeps underscore hierarchy labels literal for the upstream directory parser", () => {
    expect(structuredHierarchyName("core_feature")).toBe("core_feature");
    expect(structuredHierarchyName("Implement_feature (server)")).toBe("Implement_feature server");
    expect(structuredHierarchyName("core_feature")).not.toContain("\\");
  });
});
