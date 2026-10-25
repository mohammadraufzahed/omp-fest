import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareStructuredPlan,
  renderTaskContract,
  structuredHierarchyName,
  structuredPhaseName,
  structuredPlanSchema,
  type StructuredPlan,
} from "../src/application/structured-plan.js";
import { finalizeApprovedScaffold } from "../src/application/plan-scaffold.js";
import type { ZodLike, ZodSchema } from "../src/adapters/omp/zod-types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "structured-plan-"));
  roots.push(root);
  const workingDir = "projects/app";
  const project = join(root, workingDir);
  await mkdir(join(project, "src"), { recursive: true });
  // An intentionally invalid executable proves preparation reads script evidence, not execution output.
  await writeFile(join(project, "package.json"), JSON.stringify({ scripts: { test: "must-never-execute-during-planning", build: "also-never-execute" } }));
  await writeFile(join(project, "src", "feature.ts"), "export const enabled = false;\n");
  const spec: StructuredPlan = {
    goal: "Enable the feature without changing the public API",
    scope: ["Feature behavior and regression coverage"],
    exclusions: ["Public API changes"],
    acceptance: [{ id: "AC-01", description: "The feature returns the enabled result for a valid request" }],
    questions: [],
    inspection: [{ path: "src/feature.ts", reason: "Existing implementation and public interface" }, { path: "package.json", reason: "Available verification scripts" }],
    phases: [{
      id: "phase-build", name: "Build feature", type: "implementation",
      sequences: [{
        id: "sequence-core", name: "Core behavior",
        tasks: [{
          id: "implement", title: "Enable feature", description: "Return the enabled result while preserving the public interface",
          dependsOn: [], implements: ["AC-01"], verifies: [],
          files: [{ path: "src/feature.ts", status: "existing" }, { path: "tests/feature.test.ts", status: "proposed" }], verification: [],
        }, {
          id: "verify", title: "Verify feature", description: "Run the regression checks against the enabled behavior",
          dependsOn: ["implement"], implements: [], verifies: ["AC-01"], files: [],
          verification: [{ command: "npm run test", cwd: ".", evidencePath: "package.json", expected: "The regression check passes and the full test suite exits zero" }],
        }],
      }],
    }],
  };
  const tasks = spec.phases[0]!.sequences[0]!.tasks;
  return { root, project, workingDir, spec, implement: tasks[0]!, verify: tasks[1]!, check: tasks[1]!.verification[0]! };
}
describe("task priority", () => {
  it.each(["urgent", "high", "normal", "low"] as const)("validates and renders %s priority", async (priority) => {
    const { root, workingDir, spec, implement } = await fixture();
    implement.priority = priority;
    const result = await prepareStructuredPlan(root, workingDir, "feature", spec);
    expect(result.preview).toContain(`Priority: ${priority}`);
    expect(renderTaskContract(spec, implement)).toContain(`Priority: ${priority}`);
  });

  it("defaults omitted priority to normal and rejects unsupported or empty values", async () => {
    const { root, workingDir, spec, implement } = await fixture();
    const result = await prepareStructuredPlan(root, workingDir, "feature", spec);
    expect(result.preview).toContain("Priority: normal");
    expect(renderTaskContract(spec, implement)).toContain("Priority: normal");
    for (const priority of ["", "medium"] as const) {
      const invalid = structuredClone(spec);
      Object.assign(invalid.phases[0]!.sequences[0]!.tasks[0]!, { priority });
      await expect(prepareStructuredPlan(root, workingDir, "feature", invalid)).rejects.toThrow(/priority/);
    }
  });

  it("preserves priority in scaffolded task documents", async () => {
    const { root, spec, implement } = await fixture();
    implement.priority = "urgent";
    const festival = join(root, "festival");
    await mkdir(join(festival, "001_BUILD_FEATURE", "01_CORE_BEHAVIOR"), { recursive: true });
    await writeFile(join(festival, "001_BUILD_FEATURE", "PHASE_GOAL.md"), "---\nfest_name: build_feature\n---\n");
    await writeFile(join(festival, "001_BUILD_FEATURE", "01_CORE_BEHAVIOR", "SEQUENCE_GOAL.md"), "---\nfest_name: Core behavior\n---\n");
    await writeFile(join(festival, "001_BUILD_FEATURE", "01_CORE_BEHAVIOR", "01_enable-feature.md"), "---\nfest_name: Enable feature\n---\n");
    await writeFile(join(festival, "001_BUILD_FEATURE", "01_CORE_BEHAVIOR", "02_verify-feature.md"), "---\nfest_name: Verify feature\n---\n");
    await finalizeApprovedScaffold(root, festival, { name: "feature", workingDir: "projects/app", rules: "", spec });
    expect(await readFile(join(festival, "001_BUILD_FEATURE", "01_CORE_BEHAVIOR", "01_enable-feature.md"), "utf8")).toContain("Priority: urgent");
  });
});


describe("structured plan preparation", () => {
  it("renders a deterministic one-phase plan with observable contracts without writing or executing", async () => {
    const { root, project, workingDir, spec } = await fixture();
    const before = await readdir(project, { recursive: true });
    const first = await prepareStructuredPlan(root, workingDir, "feature", spec);
    const second = await prepareStructuredPlan(root, workingDir, "feature", structuredClone(spec));
    expect(second).toEqual(first);
    expect(first.counts).toEqual({ phases: 1, sequences: 1, tasks: 2 });
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.markdown).toContain("- **Festival:** feature\n  - **Phase 1:** BUILD_FEATURE (implementation)\n    - Sequence 1: Core behavior\n      - Task 1: Enable feature\n      - Task 2: Verify feature");
    expect(first.markdown).toContain("## Task Contracts");
    expect(first.preview).toContain("Dependencies: implement");
    expect(first.preview).toContain("Priority: normal");
    expect(first.preview).toContain("src/feature.ts (existing)");
    expect(first.preview).toContain("tests/feature.test.ts (proposed)");
    expect(first.preview).toContain("npm run test; Cwd: .; Evidence: package.json");
    expect(first.preview).toContain("AC-01: The feature returns the enabled result for a valid request");
    expect(first.preview).not.toContain("## Task Contracts");
    expect(first.preview).not.toContain("Done When:");
    expect(first.preview).toContain("Expected: The regression check passes and the full test suite exits zero");
    expect(await readdir(project, { recursive: true })).toEqual(before);
    expect(await readFile(join(project, "src/feature.ts"), "utf8")).toBe("export const enabled = false;\n");
    spec.goal = "Enable the feature and retain compatibility";
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).digest).not.toBe(first.digest);
  });

  it("accepts a single task implementing and verifying acceptance", async () => {
    const { root, workingDir, spec, implement, verify } = await fixture();
    implement.verifies = verify.verifies;
    implement.verification = verify.verification;
    spec.phases[0]!.sequences[0]!.tasks = [implement];
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).counts.tasks).toBe(1);
  });

  it("rejects unrelated tasks but permits transitive prerequisites of accepted work", async () => {
    const { root, workingDir, spec, implement } = await fixture();
    const preparation = { ...structuredClone(implement), id: "prepare", title: "Prepare dependency", implements: [], files: [] };
    spec.phases[0]!.sequences[0]!.tasks.unshift(preparation);
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("Unnecessary task prepare");
    implement.dependsOn = ["prepare"];
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).counts.tasks).toBe(3);
  });

  it("rejects verification before implementation even without forward dependencies", async () => {
    const { root, workingDir, spec, verify } = await fixture();
    verify.dependsOn = [];
    spec.phases[0]!.sequences[0]!.tasks.reverse();
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("precedes implementation");
  });

  it("requires explicit transitive dependencies for cross-sequence acceptance verification", async () => {
    const { root, workingDir, spec, verify } = await fixture();
    spec.phases[0]!.sequences[0]!.tasks.pop();
    spec.phases.push({ id: "phase-checks", name: "Checks", type: "validation", sequences: [{ id: "sequence-checks", name: "Checks", tasks: [verify] }] });
    verify.dependsOn = [];
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("Cross-sequence verification");
    verify.dependsOn = ["implement"];
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).counts.sequences).toBe(2);
  });

  it.each(["core_planning", "core-research", "Core requirements", "docs"])("rejects gate-excluded sequence name %s", async (name) => {
    const { root, workingDir, spec } = await fixture();
    spec.phases[0]!.sequences[0]!.name = name;
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("gate-excluded name suffix");
  });

  it("preserves visual acceptance checkboxes and readable linked descriptions", async () => {
    const { root, workingDir, spec, implement, verify } = await fixture();
    spec.acceptance[0]!.id = "results/AC-01";
    implement.implements = ["results/AC-01"];
    verify.verifies = ["results/AC-01"];
    const result = await prepareStructuredPlan(root, workingDir, "feature", spec);
    expect(result.markdown).toContain("- [ ] Acceptance: results/AC-01 — The feature returns the enabled result for a valid request");
    expect(renderTaskContract(spec, verify)).toContain("- [ ] Verified: results/AC-01");
  });

  it("normalizes unsafe upstream label grammar and keeps the full readable title in contracts", async () => {
    const { root, workingDir, spec, implement } = await fixture();
    spec.phases[0]!.name = "Build - feature";
    spec.phases[0]!.sequences[0]!.name = "Core (required)";
    implement.title = "Enable `feature` (server)";
    const result = await prepareStructuredPlan(root, workingDir, "feature", spec);
    expect(structuredPhaseName("Build - feature")).toBe("BUILD_FEATURE");
    expect(structuredHierarchyName(implement.title)).toBe("Enable feature server");
    expect(result.markdown).toContain("Sequence 1: Core required");
    expect(result.markdown).toContain("Task 1: Enable feature server");
    expect(result.markdown).toContain("### implement — Enable \\`feature\\` (server)");
  });

  it("strips path separators from hierarchy names so upstream cannot create nested paths", async () => {
    const { root, workingDir, spec, implement } = await fixture();
    implement.title = "Enable api/worker endpoints";
    expect(structuredHierarchyName(implement.title)).toBe("Enable api worker endpoints");
    expect(structuredHierarchyName("Enable api\\worker")).toBe("Enable api worker");
    const result = await prepareStructuredPlan(root, workingDir, "feature", spec);
    expect(result.markdown).toContain("Enable api worker endpoints");
  });

  it("allows nonblocking questions and exposes them for approval", async () => {
    const { root, workingDir, spec } = await fixture();
    spec.questions.push({ question: "Should a later release add analytics?", blocking: false });
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).preview).toContain("Nonblocking: Should a later release add analytics?");
  });

  it("requires substantive development to use distinct milestone phases", async () => {
    const { root, workingDir, spec } = await fixture();
    const first = spec.phases[0]!;
    const sequence = first.sequences[0]!;
    const verify = sequence.tasks.pop()!;
    verify.dependsOn = ["implement"];
    first.sequences.push({ id: "sequence-checks", name: "Regression checks", tasks: [verify] });
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow(
      "A single implementation phase is only valid for a small, single-lane change",
    );
  });

  it("allows a compact single-lane implementation phase at the three-task boundary", async () => {
    const { root, workingDir, spec } = await fixture();
    const tasks = spec.phases[0]!.sequences[0]!.tasks;
    const verify = tasks[1]!;
    const prerequisite = structuredClone(tasks[0]!);
    prerequisite.id = "prepare";
    prerequisite.title = "Prepare behavior";
    prerequisite.implements = [];
    prerequisite.verifies = [];
    prerequisite.dependsOn = [];
    verify.dependsOn = ["prepare"];
    tasks.splice(1, 0, prerequisite);
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).resolves.toMatchObject({
      counts: { phases: 1, sequences: 1, tasks: 3 },
    });
  });

  it("rejects a four-task single-phase development plan", async () => {
    const { root, workingDir, spec } = await fixture();
    const tasks = spec.phases[0]!.sequences[0]!.tasks;
    const [implement, verify] = tasks;
    const first = structuredClone(implement!);
    first.id = "extra-first";
    first.title = "Prepare shared behavior";
    first.implements = [];
    first.verifies = [];
    first.verification = [];
    const second = structuredClone(first);
    second.id = "extra-second";
    second.title = "Connect supporting behavior";
    second.dependsOn = ["extra-first"];
    verify!.dependsOn = ["extra-second"];
    tasks.splice(1, 0, first, second);
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow(
      "at most three tasks",
    );
  });

  it.each([
    ["goal", ""], ["scope", []], ["acceptance", []], ["inspection", []], ["phases", []],
    ["questions", undefined], ["exclusions", null],
  ])("validates required runtime content for %s independently of Zod", async (field, value) => {
    const { root, workingDir, spec } = await fixture();
    Object.assign(spec, { [field]: value });
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow(field);
  });

  it.each([
    ["duplicate IDs", (s: StructuredPlan) => { s.phases[0]!.id = "AC-01"; }, /Duplicate id/],
    ["empty sequences", (s: StructuredPlan) => { s.phases[0]!.sequences = []; }, /nonempty array/],
    ["empty tasks", (s: StructuredPlan) => { s.phases[0]!.sequences[0]!.tasks = []; }, /nonempty array/],
    ["invalid phase type", (s: StructuredPlan) => { Object.assign(s.phases[0]!, { type: "deployment" }); }, /unsupported/],
    ["blocking question", (s: StructuredPlan) => { s.questions.push({ question: "Which API?", blocking: true }); }, /Unresolved blocking/],
    ["invalid question flag", (s: StructuredPlan) => { s.questions.push({ question: "Which API?", blocking: "false" as unknown as boolean }); }, /boolean/],
    ["missing implementation", (s: StructuredPlan) => { s.phases[0]!.sequences[0]!.tasks[0]!.implements = []; }, /no implementation/],
    ["missing verification", (s: StructuredPlan) => { s.phases[0]!.sequences[0]!.tasks[1]!.verifies = []; }, /no verification/],
    ["unknown acceptance", (s: StructuredPlan) => { s.phases[0]!.sequences[0]!.tasks[0]!.implements.push("AC-unknown"); }, /Unknown acceptance/],
    ["missing command evidence", (s: StructuredPlan) => { s.phases[0]!.sequences[0]!.tasks[1]!.verification = []; }, /requires a command/],
  ] as const)("rejects %s", async (_label, mutate, error) => {
    const { root, workingDir, spec } = await fixture();
    mutate(spec);
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow(error);
  });

  it.each(["goal", "title", "description", "path", "command"])("rejects newline injection in %s", async (field) => {
    const { root, workingDir, spec, implement, check } = await fixture();
    const injected = "safe\n  - **Phase 9:** INJECTED (implementation)";
    if (field === "goal") spec.goal = injected;
    else if (field === "title") implement.title = injected;
    else if (field === "description") implement.description = injected;
    else if (field === "path") implement.files[0]!.path = injected;
    else check.command = injected;
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("single line");
  });

  it.each(["unknown", "forward", "self", "cycle"])("rejects %s dependencies", async (kind) => {
    const { root, workingDir, spec, implement, verify } = await fixture();
    if (kind === "unknown") verify.dependsOn = ["missing"];
    else if (kind === "self") verify.dependsOn = ["verify"];
    else {
      implement.dependsOn = ["verify"];
      if (kind === "forward") verify.dependsOn = [];
    }
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow(kind === "unknown" ? "Unknown dependency" : "earlier in serialized execution order");
  });

  it("checks task dependencies across sequences and phases in serialization order", async () => {
    const { root, workingDir, spec, verify } = await fixture();
    spec.phases[0]!.sequences[0]!.tasks.pop();
    spec.phases.push({ id: "phase-validation", name: "Validate", type: "validation", sequences: [{ id: "sequence-checks", name: "Regression checks", tasks: [verify] }] });
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).counts).toEqual({ phases: 2, sequences: 2, tasks: 2 });
    spec.phases.reverse();
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("earlier in serialized execution order");
  });

  it.each(["phase", "sequence", "task"])("rejects normalized %s name collisions", async (kind) => {
    const { root, workingDir, spec, verify } = await fixture();
    const first = spec.phases[0]!;
    if (kind === "phase") {
      first.sequences[0]!.tasks.pop();
      spec.phases.push({ id: "phase-check", name: "Build-feature", type: "validation", sequences: [{ id: "sequence-check", name: "Checks", tasks: [verify] }] });
    } else if (kind === "sequence") {
      first.sequences[0]!.tasks.pop();
      first.sequences.push({ id: "sequence-check", name: "Core-behavior", tasks: [verify] });
    } else verify.title = "Enable-feature";
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("Normalized name collision");
  });
});

describe("project and command evidence boundaries", () => {
  it.each(["inspection", "existing", "evidence", "cwd", "proposed"])("rejects project escapes in %s", async (field) => {
    const { root, workingDir, spec, implement, check } = await fixture();
    if (field === "inspection") spec.inspection[0]!.path = "../outside";
    else if (field === "existing") implement.files[0]!.path = "../outside";
    else if (field === "evidence") check.evidencePath = "../outside";
    else if (field === "cwd") check.cwd = "../outside";
    else implement.files[1]!.path = "../outside";
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("within project");
  });

  it("accepts camp-relative links and absolute paths to external project checkouts", async () => {
    const { root, spec } = await fixture();
    const external = await mkdtemp(join(tmpdir(), "linked-project-"));
    roots.push(external);
    await mkdir(join(external, "src"), { recursive: true });
    await writeFile(join(external, "src", "feature.ts"), "export const enabled = false;\n");
    await writeFile(join(external, "package.json"), JSON.stringify({ scripts: { test: "npm test" } }));
    await symlink(external, join(root, "projects", "linked"));

    const linked = await prepareStructuredPlan(root, "projects/linked", "feature", spec);
    const absolute = await prepareStructuredPlan(root, external, "feature", spec);

    expect(linked.preview).toContain("Project: projects/linked");
    expect(absolute.preview).toContain(`Project: ${external}`);
    expect(linked.counts).toEqual(absolute.counts);
  });

  it("rejects absolute paths and a working directory outside camp", async () => {
    const { root, project, workingDir, spec } = await fixture();
    spec.inspection[0]!.path = join(project, "src", "feature.ts");
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("project-relative");
    spec.inspection[0]!.path = "src/feature.ts";
    await expect(prepareStructuredPlan(root, "..", "feature", spec)).rejects.toThrow("within camp");
  });

  it.each(["inspection", "existing", "evidence", "cwd"])("rejects nonexistent %s paths", async (field) => {
    const { root, workingDir, spec, implement, check } = await fixture();
    if (field === "inspection") spec.inspection[0]!.path = "missing";
    else if (field === "existing") implement.files[0]!.path = "missing";
    else if (field === "evidence") check.evidencePath = "missing";
    else check.cwd = "missing";
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("does not exist");
  });

  it("rejects proposed files which already exist and missing status markers", async () => {
    const { root, workingDir, spec, implement } = await fixture();
    implement.files[0]!.status = "proposed";
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("already exists");
    Object.assign(implement.files[0]!, { status: undefined });
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("status must be existing or proposed");
  });

  it("rejects symlink escapes for inspection, existing files, cwd, evidence and proposed ancestors", async () => {
    const { root, project, workingDir, spec, implement, check } = await fixture();
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "file.ts"), "outside");
    await symlink(join(root, "outside"), join(project, "escape"));
    for (const field of ["inspection", "existing", "evidence", "cwd", "proposed"]) {
      const clone = structuredClone(spec);
      const task = clone.phases[0]!.sequences[0]!.tasks[0]!;
      const verification = clone.phases[0]!.sequences[0]!.tasks[1]!.verification[0]!;
      if (field === "inspection") clone.inspection[0]!.path = "escape/file.ts";
      else if (field === "existing") task.files[0]!.path = "escape/file.ts";
      else if (field === "evidence") verification.evidencePath = "escape/file.ts";
      else if (field === "cwd") verification.cwd = "escape";
      else task.files[1]!.path = "escape/new/deep/file.ts";
      await expect(prepareStructuredPlan(root, workingDir, "feature", clone)).rejects.toThrow("outside project");
    }
    await symlink(join(root, "missing"), join(project, "dangling"));
    implement.files[1]!.path = "dangling/file.ts";
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("unresolved parent");
    implement.files[1]!.path = "tests/feature.test.ts";
    check.cwd = "src/feature.ts";
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("directory");
  });

  it.each(["npm run test", "npm test", "pnpm run test", "yarn run test", "bun run test"])("accepts a proven package script: %s", async (command) => {
    const { root, workingDir, spec, check } = await fixture();
    check.command = command;
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).preview).toContain(command);
  });

  it.each([
    ["npm run missing", "missing package script"],
    ["npm run test --prefix ../other", "declared cwd"],
    ["npm run test && touch bad", "one literal command"],
    ["npm run 'test", "unterminated quote"],
    ["npm install", "must invoke a script"],
    ["bun test", "must invoke a script"],
  ])("rejects unsupported or unproven package commands: %s", async (command, message) => {
    const { root, workingDir, spec, check } = await fixture();
    check.command = command;
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow(message);
  });

  it("requires a script manifest at the actual verification cwd", async () => {
    const { root, project, workingDir, spec, check } = await fixture();
    await mkdir(join(project, "nested"));
    await writeFile(join(project, "nested", "package.json"), JSON.stringify({ scripts: { test: "never-run" } }));
    check.cwd = "nested";
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("cwd/package.json");
    check.evidencePath = "nested/package.json";
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).counts.tasks).toBe(2);
  });

  it("requires expected results and existing command evidence, not a future result log", async () => {
    const { root, workingDir, spec, check } = await fixture();
    check.expected = " ";
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("expected must be nonempty");
    check.expected = "Tests exit zero";
    check.evidencePath = "future-test-results.log";
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("does not exist");
  });

  it("supports checked-in scripts and rejects unrelated evidence", async () => {
    const { root, project, workingDir, spec, check } = await fixture();
    await mkdir(join(project, "scripts"));
    await writeFile(join(project, "scripts", "verify.mjs"), "throw new Error('Do not execute during planning');\n");
    check.command = "node scripts/verify.mjs";
    check.evidencePath = "scripts/verify.mjs";
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).preview).toContain("node scripts/verify.mjs");
    check.command = "invented-tool test";
    await expect(prepareStructuredPlan(root, workingDir, "feature", spec)).rejects.toThrow("not substantiated");
  });

  it.each([
    ["go test ./...", "go.mod", "module example.test/project\n"],
    ["cargo test", "Cargo.toml", '[package]\nname = "app"\n'],
    ["make check", "Makefile", "check:\n\tfalse\n"],
    ["pytest tests", "COMMANDS.txt", "pytest tests\n"],
  ])("substantiates non-package command %s without executing", async (command, evidencePath, content) => {
    const { root, project, workingDir, spec, check } = await fixture();
    await writeFile(join(project, evidencePath), content);
    Object.assign(check, { command, evidencePath });
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).preview).toContain(command);
  });
  it("accepts an existing test directory named by a direct test-runner command", async () => {
    const { root, project, workingDir, spec, check } = await fixture();
    await mkdir(join(project, "tests"), { recursive: true });
    await writeFile(join(project, "tests", "test_feature.py"), "def test_feature(): pass\n");
    Object.assign(check, { command: "pytest tests", evidencePath: "tests" });
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).preview).toContain("pytest tests");
    await writeFile(join(project, "tests", "lint.php"), "<?php echo 'not executed';\n");
    Object.assign(check, { command: "php -l tests/lint.php", evidencePath: "tests" });
    expect((await prepareStructuredPlan(root, workingDir, "feature", spec)).preview).toContain("php -l tests/lint.php");
  });
});

describe("structuredPlanSchema", () => {
  it("declares every nested contract field with the host's Zod-like facade", () => {
    interface Shape extends ZodSchema { kind: string; fields?: Record<string, ZodSchema>; item?: ZodSchema; values?: readonly string[] }
    const shape = (kind: string, extra: Partial<Shape> = {}): Shape => ({ kind, ...extra, optional() { return this; }, describe() { return this; } });
    const z: ZodLike = {
      object: (fields) => shape("object", { fields }), string: () => shape("string"), number: () => shape("number"),
      boolean: () => shape("boolean"), enum: (values) => shape("enum", { values }), array: (item) => shape("array", { item }),
    };
    const schema = structuredPlanSchema(z) as Shape;
    expect(Object.keys(schema.fields!)).toEqual(["goal", "scope", "exclusions", "acceptance", "questions", "inspection", "phases"]);
    const phase = (schema.fields!.phases as Shape).item as Shape;
    expect((phase.fields!.type as Shape).values).toEqual(["implementation", "planning", "research", "validation"]);
    const sequence = (phase.fields!.sequences as Shape).item as Shape;
    const task = (sequence.fields!.tasks as Shape).item as Shape;
    expect(Object.keys(task.fields!)).toEqual(["id", "title", "description", "priority", "dependsOn", "implements", "verifies", "files", "verification"]);
    expect(((task.fields!.priority as Shape).values)).toEqual(["urgent", "high", "normal", "low"]);
    const verification = (task.fields!.verification as Shape).item as Shape;
    expect(Object.keys(verification.fields!)).toEqual(["command", "cwd", "evidencePath", "expected"]);
  });
});
