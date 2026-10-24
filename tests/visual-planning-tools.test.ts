import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { registerTools, type PiLike } from "../src/adapters/omp/tools.js";
import { registerCommands, type PiCommandsLike } from "../src/adapters/omp/commands.js";
import { LoopTracker } from "../src/application/loop-tracker.js";
import type { CampCli, FestCli } from "../src/ports.js";
import { PAGE, SVG, TASK } from "./visual-fixture.js";
import type { StructuredPlan } from "../src/application/structured-plan.js";
import { listFestivalCreationOrphans } from "../src/application/festival-creation.js";
import { festivalOwner } from "../src/application/festival-ownership.js";

type Execute = (id: string, params: Record<string, unknown>, signal: unknown, update: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }>;
const schema = (): { optional(): unknown; describe(): unknown } => ({ optional: schema, describe: schema });
function jsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value as Record<string, unknown>;
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "visual-tools-"));
  const plans = join(root, ".ompfest", "plans");
  const referencesDir = join(plans, "feature.references");
  const page = join(referencesDir, "pages", "results");
  const festival = join(root, "festivals", "planning", "feature");
  const sequence = join(festival, "001_BUILD", "01_ui");
  const taskPath = "001_BUILD/01_ui/01_results.md";
  await mkdir(page, { recursive: true });
  await mkdir(join(root, "projects"), { recursive: true });
  await mkdir(join(root, "festivals", "planning"), { recursive: true });
  const plan = join(plans, "feature.STRUCTURE.md");
  await writeFile(plan, "# Festival Structure");
  await writeFile(join(page, "PAGE.md"), PAGE);
  await writeFile(join(page, "wireframe.svg"), SVG);
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  const spec: StructuredPlan = {
    goal: "Search results in RTL", scope: ["Results search"], exclusions: ["Pagination"],
    acceptance: [{ id: "results/AC-01", description: "Search works in RTL" }],
    questions: [], inspection: [{ path: "package.json", reason: "Existing test command" }],
    phases: [{ id: "build", name: "BUILD", type: "implementation", sequences: [{
      id: "ui", name: "ui", tasks: [{
        id: "results", title: "results", description: "Implement and verify RTL search",
        dependsOn: [], implements: ["results/AC-01"], verifies: ["results/AC-01"],
        files: [{ path: "package.json", status: "existing" }],
        verification: [{ command: "npm test", cwd: ".", evidencePath: "package.json", expected: "RTL search passes" }],
      }],
    }] }],
  };
  const scaffoldFromPlan = vi.fn(async (_campRoot: string, options: { name: string; plan: string; dest?: string; dryRun?: boolean }) => {
    const result = {
      ok: true,
      festival_dir: festival,
      phases_created: 1,
      sequences_created: 1,
      tasks_created: 1,
      dry_run: options.dryRun === true,
    };
    if (options.dryRun) return JSON.stringify(result);
    await mkdir(sequence, { recursive: true });
    await writeFile(join(festival, "fest.yaml"), "id: feature\n");
    await writeFile(join(festival, "001_BUILD", "PHASE_GOAL.md"), "---\nfest_name: build\n---\n");
    await writeFile(join(sequence, "01_results.md"), "---\nfest_type: task\nfest_name: results\n---\n# Task: results\n\nTemplate-only guidance is preserved.\n");
    await writeFile(join(sequence, "SEQUENCE_GOAL.md"), "---\nfest_name: ui\nfest_tracking: true\n---\n");
    return JSON.stringify(result);
  });
  const promote = vi.fn(() => Promise.resolve("ok"));
  const taskComplete = vi.fn(() => Promise.resolve({ ok: true, output: "done" }));
  const workflowAdvance = vi.fn(() => Promise.resolve("pending"));
  const workflowApprove = vi.fn(() => Promise.resolve("approved"));
  const fest: FestCli = {
    scaffoldFromPlan,
    gatesApply: () => Promise.resolve({ created: 0, output: "ok" }),
    validate: () => Promise.resolve({ score: 100, output: "ok" }),
    next: () => Promise.resolve({ kind: "task", path: taskPath, doc: TASK, goals: [] }),
    promote,
    taskComplete,
    workflowAdvance,
    workflowApprove,
  } as unknown as FestCli;
  const tracker = new LoopTracker();
  tracker.claimFestival("session-1", festival);
  const tools = new Map<string, Execute>();
  registerTools({
    zod: { object: schema, string: schema, number: schema, boolean: schema, enum: schema, array: schema } as never,
    registerTool: (tool) => tools.set(tool.name as string, tool.execute as Execute),
  } satisfies PiLike, {
    fest,
    camp: { projects: () => Promise.resolve([]) } as unknown as CampCli,
    detect: new CampFsDetect(),
    tracker,
  });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "session-1" } };
  async function call(name: string, params: Record<string, unknown> = {}, ui?: Record<string, unknown>) {
    const result = await tools.get(name)!("id", params, undefined, undefined, { ...ctx, ...(ui ? { ui } : {}) });
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  }
  async function scaffold(params: Record<string, unknown>) {
    const visual = params.referencesDir ? { visualIntent: "ui_visual", attachments: [{ name: "design-reference", description: "User-provided UI design reference", role: "ui_design" }] } : {};
    const preview = await call("fest_plan", { ...params, ...visual, action: "preview", spec }, { custom: () => Promise.resolve("closed"), confirm: () => Promise.resolve(true) });
    expect(preview.kind).toBe("plan_preview");
    const result = await call("fest_plan", { ...params, ...visual, action: "scaffold", approvedRevision: preview.planRevision });
    await handler?.("select feature", { cwd: root, sessionManager: { getSessionId: () => "session-1" }, ui: { notify: vi.fn() } });
    return result;
  }
  let handler: Parameters<PiCommandsLike["registerCommand"]>[1]["handler"] | undefined;
  const sent: string[] = [];
  registerCommands({
    registerCommand: (_name, options) => { handler = options.handler; },
    sendMessage: (message) => { sent.push(String(message.content)); },
  }, { fest, camp: {} as CampCli, detect: new CampFsDetect(), tracker });
  async function command(args: string): Promise<string> {
    await handler?.(args, { cwd: root, sessionManager: { getSessionId: () => "session-1" }, ui: { notify: vi.fn() } });
    return sent.at(-1) ?? "";
  }
  return { root, referencesDir, festival, plan, spec, taskPath, scaffoldFromPlan, promote, taskComplete, workflowAdvance, workflowApprove, call, command, scaffold, fest, tracker };
}

describe("visual planning tool handoff", () => {
  it("never claims an unowned festival from an explicit model tool override", async () => {
    const { festival, call } = await setup();
    await mkdir(festival, { recursive: true });
    await writeFile(join(festival, "fest.yaml"), "id: feature\nname: Feature\n");
    expect(await call("fest_next", { festival: "feature" })).toMatchObject({ kind: "festival_unselected" });
    expect(await festivalOwner(festival)).toBeUndefined();
  });
  it("refuses completion while the current task is paused by a project reservation", async () => {
    const { plan, taskPath, taskComplete, tracker, call, scaffold } = await setup();
    await scaffold({ name: "feature", plan });
    tracker.taskOpened("session-1", taskPath);
    tracker.taskPaused("session-1", taskPath, "Another session owns overlapping project files.");
    const result = await call("fest_task_complete", { evidence: "No work was performed.", task: taskPath });
    expect(result).toMatchObject({ kind: "completion_blocked", blocker: "Another session owns overlapping project files." });
    expect(taskComplete).not.toHaveBeenCalled();
  });
  it("reports missing task mutation fields before invoking fest", async () => {
    const { plan, scaffold, call } = await setup();
    await scaffold({ name: "feature", plan });
    expect(await call("fest_task_update", { action: "update" })).toMatchObject({
      kind: "task_update_invalid", field: "percent",
    });
    expect(await call("fest_task_update", { action: "blocked" })).toMatchObject({
      kind: "task_update_invalid", field: "reason",
    });
  });
  it("previews within the plan flow and applies reviewed revisions without scaffolding again", async () => {
    const { referencesDir, festival, plan, scaffoldFromPlan, call, scaffold } = await setup();
    const preview = await call("fest_plan", { name: "feature", plan, referencesDir, referenceAction: "preview" });
    expect(preview.kind).toBe("plan_preview");
    expect((preview.preview as { file: string }).file).toBe(plan.replace(".STRUCTURE.md", ".preview.html"));
    expect(scaffoldFromPlan).not.toHaveBeenCalled();
    await scaffold({ name: "feature", plan, referencesDir });
    await writeFile(join(referencesDir, "pages", "results", "wireframe.svg"), SVG.replace("Search</text>", "Find</text>"));
    const review = await call("fest_plan", { name: "feature", plan, referencesDir, festival: "feature", referenceAction: "preview" });
    const impact = review.revisionImpact as { baseRevision: string; proposalRevision: string; affectedChecks: unknown[] };
    expect(impact.affectedChecks).toHaveLength(1);
    const rejected = await call("fest_plan", { name: "feature", plan, referencesDir, festival: "feature", referenceAction: "revise",
      baseRevision: "invalid", proposalRevision: impact.proposalRevision });
    expect(rejected.kind).toBe("plan_failed");
    const revised = await call("fest_plan", { name: "feature", plan, referencesDir, festival: "feature", referenceAction: "revise",
      baseRevision: impact.baseRevision, proposalRevision: impact.proposalRevision });
    expect(revised.kind).toBe("references_revised");
    expect(await readFile(join(festival, "references", "pages", "results", "wireframe.svg"), "utf8")).toContain("Find</text>");
    expect(scaffoldFromPlan).toHaveBeenCalledTimes(2);
  });
  it("previews persisted draft content without resending a spec and rejects stale revisions", async () => {
    const { call, plan } = await setup();
    const draft = await call("fest_plan", { action: "create",
      name: "feature",
      goal: "Fix sidebar overflow",
      scope: ["Sidebar layout"],
      acceptance: ["Sidebar remains usable"],
      inspection: [{ path: "package.json", reason: "Existing test command" }],
      verification: { command: "npm test", evidencePath: "package.json", expected: "Sidebar behavior checks pass" },
    });
    const preview = await call("fest_plan", { action: "preview", draftId: draft.draftId, draftRevision: draft.revision });
    expect(preview.kind).toBe("plan_preview");
    expect(await readFile(plan, "utf8")).toContain("Sidebar remains usable");
    const changed = await call("fest_plan", { action: "update", draftId: draft.draftId, draftRevision: draft.revision, goal: "Fix sidebar wrapping" });
    expect(changed.revision).not.toBe(draft.revision);
    const stale = await call("fest_plan", { action: "preview", draftId: draft.draftId, draftRevision: draft.revision });
    expect(stale.kind).toBe("plan_failed");
    expect(stale.error).toContain("Draft changed");
  });

  it("opens a native proposal review before allowing scaffolding", async () => {
    const { plan, spec, call } = await setup();
    const ui = {
      custom: () => Promise.resolve("closed"),
      confirm: () => Promise.resolve(true),
    };
    const preview = await call("fest_plan", { name: "feature", plan, spec, action: "preview" }, ui);
    expect(preview.kind).toBe("plan_preview");
    expect(preview.approval).toBe("approved");
    expect(preview.nextSteps).toContain("action:'scaffold'");
  });


  it("does not create or delete a festival when parser preflight disagrees with approval", async () => {
    const { festival, plan, scaffoldFromPlan, scaffold } = await setup();
    await mkdir(festival, { recursive: true });
    const existingFile = join(festival, "FESTIVAL_GOAL.md");
    await writeFile(existingFile, "Keep existing plan data");
    scaffoldFromPlan.mockImplementationOnce(() => Promise.resolve(JSON.stringify({
      ok: true,
      festival_dir: festival,
      phases_created: 0,
      sequences_created: 0,
      tasks_created: 0,
      dry_run: true,
    })));

    const result = await scaffold({ name: "feature", plan });
    expect(result.kind).toBe("plan_failed");
    expect(result.actual).toEqual({ phases: 0, sequences: 0, tasks: 0 });
    expect(scaffoldFromPlan).toHaveBeenCalledTimes(1);
    expect(scaffoldFromPlan.mock.calls[0]?.[1].dryRun).toBe(true);
    expect(await readFile(existingFile, "utf8")).toBe("Keep existing plan data");
  });

  it("removes an invalid newly scaffolded festival and clears its creation journal", async () => {
    const { festival, plan, fest, root, scaffold } = await setup();
    vi.spyOn(fest, "validate").mockResolvedValue({ score: 80, output: "unfilled markers" });
    const result = await scaffold({ name: "feature", plan });
    expect(result.kind).toBe("plan_failed");
    await expect(lstat(festival)).rejects.toThrow();
    expect(await listFestivalCreationOrphans(root)).toEqual([]);
  });

  it("scaffolds references, validates task links and supplies page notes to next and parallel", async () => {
    const { referencesDir, festival, plan, taskPath, call, command, scaffold } = await setup();
    const scaffolded = await scaffold({ name: "feature", plan, referencesDir, rules: "- preserve RTL column order" });
    expect(scaffolded.kind).toBe("plan_scaffolded");
    expect(scaffolded.visualReferences).toEqual(["references/pages/results/PAGE.md"]);
    expect(await readFile(join(festival, "references", "pages", "results", "PAGE.md"), "utf8")).toContain("RTL");
    const generatedTask = await readFile(join(festival, taskPath), "utf8");
    expect(generatedTask).toContain("Task ID: results");
    expect(generatedTask).toContain("Dependencies: none");
    expect(generatedTask).toContain("Implements:");
    expect(generatedTask).toContain("npm test");
    expect(generatedTask).toContain("Search works in RTL");
    expect(generatedTask).toContain("Template-only guidance is preserved.");
    expect(await readFile(join(festival, "FESTIVAL_RULES.md"), "utf8")).toContain("preserve RTL column order");
    const validation = await call("fest_validate");
    expect((validation.visualReferences as { issues: string[] }).issues).toEqual([]);
    const next = await call("fest_next");
    expect((next.visualReferences as { content: string }[])[0]?.content).toContain("filters.search");
    const backend = join(festival, "001_BUILD", "02_api");
    await mkdir(backend);
    await writeFile(join(backend, "01_api.md"), "---\nfest_type: task\n---\n# Backend");
    const deprecatedParallel = await call("fest_parallel");
    expect(deprecatedParallel).toMatchObject({ kind: "parallel_queue_deprecated" });
    expect(deprecatedParallel.nextAction).toContain("fest_supervisor");
    expect(await command("next")).toContain("filters.search");
    expect(await command("validate")).toContain("Visual references: valid");
    expect(await command("parallel")).toContain("fest_supervisor action:'queue'");
  });

  it("rejects invalid bundles before calling the scaffold and blocks missing links at promotion", async () => {
    const { referencesDir, festival, plan, spec, scaffoldFromPlan, promote, call, taskPath, command, scaffold } = await setup();
    const failure = await call("fest_plan", { name: "feature", plan, referencesDir: join(referencesDir, "pages"), action: "preview", spec });
    expect(failure.kind).toBe("plan_failed");
    expect(scaffoldFromPlan).not.toHaveBeenCalled();
    await scaffold({ name: "feature", plan, referencesDir });
    await writeFile(join(festival, taskPath), "# UI\nNo link");
    const validation = await call("fest_validate");
    expect(validation.kind).toBe("validation_failed");
    expect((await call("fest_promote", { festival: "feature" })).kind).toBe("promotion_blocked");
    expect((await call("fest_gate_submit", { evidence: "done" })).kind).toBe("gate_blocked");
    expect(await command("promote")).toContain("Promotion blocked");
    expect(promote).not.toHaveBeenCalled();
  });

  it("completes a task using the exact absolute path returned by fest_next", async () => {
    const { referencesDir, festival, plan, taskPath, taskComplete, call, scaffold, fest } = await setup();
    await scaffold({ name: "feature", plan, referencesDir });
    fest.next = () => Promise.resolve({ kind: "task", path: join(festival, taskPath), doc: TASK, goals: [] });
    const next = await call("fest_next");
    expect(next.path).toBe(join(festival, taskPath));
    const result = await call("fest_task_complete", {
      task: next.path,
      evidence: "Reviewed task acceptance and verified automated checks.",
      visualEvidence: [{ page: "results", check: "AC-01", status: "untested", proof: "Browser validation not yet performed." }],
    });
    expect(result.status).toBe("completed");
    expect(taskComplete).toHaveBeenCalledWith(festival, taskPath, "Reviewed task acceptance and verified automated checks.");
  });

  it("requires honest task evidence and blocks the gate for missing, failed or stale checks", async () => {
    const { referencesDir, festival, plan, taskPath, taskComplete, workflowAdvance, call, command, scaffold } = await setup();
    await scaffold({ name: "feature", plan, referencesDir });
    const noEvidence = await call("fest_task_complete", { task: taskPath, evidence: "tests passed" });
    expect(noEvidence.kind).toBe("completion_blocked");
    expect(taskComplete).not.toHaveBeenCalled();
    const failed = await call("fest_task_complete", { task: taskPath, evidence: "tests failed", visualEvidence: [
      { page: "results", check: "AC-01", status: "failed", proof: "Search did not filter" },
    ] });
    expect(failed.kind).toBe("completion_blocked");
    expect(taskComplete).not.toHaveBeenCalled();
    const evidence = { page: "results", check: "AC-01", status: "untested", proof: "Browser unavailable" };
    expect((await call("fest_task_complete", { task: taskPath, evidence: "unit tested", visualEvidence: [evidence] })).status).toBe("completed");
    expect(taskComplete).toHaveBeenCalledTimes(1);
    await mkdir(join(festival, ".fest"));
    await writeFile(join(festival, ".fest", "progress_events.jsonl"), `${JSON.stringify({ ts: "2026-10-20T00:00:00Z", event: "completed", task: taskPath })}\n`);
    const validation = await call("fest_validate");
    expect((validation.visualVerification as { untested: unknown[] }).untested).toHaveLength(1);
    expect((await call("fest_gate_submit", { evidence: "unit tests pass" })).status).toBe("awaiting_human");
    expect(await command("approve")).toContain("UNTESTED results/AC-01");
    expect(await command("approve --allow-untested")).toContain("approved");
    expect(workflowAdvance).toHaveBeenCalledTimes(1);
    const failedGate = await call("fest_gate_submit", { evidence: "needs repair", visualEvidence: [
      { task: taskPath, page: "results", check: "AC-01", status: "failed", proof: "Layout is wrong" },
    ] });
    expect(failedGate.kind).toBe("gate_blocked");
    expect(workflowAdvance).toHaveBeenCalledTimes(1);
    await writeFile(join(festival, "references", "pages", "results", "PAGE.md"), PAGE.replace("Search works", "Search changed"));
    const stale = await call("fest_gate_submit", { evidence: "tests passed" });
    expect((stale.issues as string[]).join("\n")).toContain("Stale evidence");
    expect((await call("fest_validate")).kind).toBe("validation_failed");
    expect(await command("approve")).toContain("Stale evidence");
  });

  it("reverifies completed tasks at the existing gate and shows route and viewport to the human", async () => {
    const { referencesDir, festival, plan, taskPath, call, workflowAdvance, workflowApprove, scaffold } = await setup();
    await scaffold({ name: "feature", plan, referencesDir });
    await mkdir(join(festival, ".fest"));
    await writeFile(join(festival, ".fest", "progress_events.jsonl"), `${JSON.stringify({ ts: "2026-10-20T00:00:00Z", event: "completed", task: taskPath })}\n`);
    expect((await call("fest_gate_submit", { evidence: "tests pass" })).kind).toBe("gate_blocked");
    const messages: string[] = [];
    const ui = { confirm: (_title: string, message: string) => {
      messages.push(message);
      return Promise.resolve(true);
    } };
    const result = await call("fest_gate_submit", { evidence: "search test passed", visualEvidence: [{
      task: taskPath, page: "results", check: "AC-01", status: "verified", proof: "Browser search test passed",
      route: "/results", viewport: "1280x800", state: "initial",
    }] }, ui);
    expect(result.status).toBe("approved");
    expect(workflowAdvance).toHaveBeenCalledTimes(1);
    expect(workflowApprove).toHaveBeenCalledTimes(1);
    expect(messages.join("\n")).toContain("/results (1280x800, initial)");
  });

  it("requires approval and rejects edits made after a text-only preview", async () => {
    const { plan, spec, call, scaffoldFromPlan } = await setup();
    expect((await call("fest_plan", { name: "feature", plan })).kind).toBe("plan_failed");
    const preview = await call("fest_plan", { name: "feature", plan, action: "preview", spec });
    expect(preview.kind).toBe("plan_preview");
    expect(preview.counts).toEqual({ phases: 1, sequences: 1, tasks: 1 });
    await writeFile(plan, `${await readFile(plan, "utf8")}\nChanged after approval\n`);
    const result = await call("fest_plan", { name: "feature", plan, action: "scaffold", approvedRevision: preview.planRevision });
    expect(result.kind).toBe("plan_failed");
    expect(result.error).toContain("changed since approval");
    expect(scaffoldFromPlan).not.toHaveBeenCalled();
  });
  it("blocks direct scaffold until the exact preview revision is human-approved", async () => {
    const { plan, spec, call, scaffoldFromPlan } = await setup();
    const preview = await call("fest_plan", { name: "feature", plan, action: "preview", spec });
    const blocked = await call("fest_plan", { name: "feature", plan, action: "scaffold", approvedRevision: preview.planRevision });
    expect(blocked.kind).toBe("plan_failed");
    expect(String(blocked.error)).toContain("not been approved");
    expect(scaffoldFromPlan).not.toHaveBeenCalled();
    const approved = await call("fest_plan", { name: "feature", plan, action: "preview", spec }, { confirm: () => Promise.resolve(true) });
    const result = await call("fest_plan", { name: "feature", plan, action: "scaffold", approvedRevision: approved.planRevision });
    expect(result.kind).toBe("plan_scaffolded");
  });

  it("rejects and cancels only the matching plan revision while preserving artifacts", async () => {
    const { root, plan, spec, call } = await setup();
    const rejected = await call("fest_plan", { name: "feature", plan, action: "preview", spec }, { confirm: () => Promise.resolve(false), input: () => Promise.resolve("revise") });
    const artifact = join(root, ".ompfest", "plans", "feature.STRUCTURE.md.json");
    const overlap = await call("fest_plan", { name: "other-plan", action: "preview", spec });
    expect(overlap.kind).toBe("plan_preview");
    expect(await readFile(artifact, "utf8")).toContain('"name": "feature"');
    const next = await call("fest_plan", { name: "feature", plan, action: "preview", spec, conflictChoice: "sequence" });
    const wrongRevision = await call("fest_plan", { name: "feature", plan, action: "cancel", approvedRevision: rejected.planRevision });
    expect(wrongRevision.kind).toBe("plan_failed");
    const cancelled = await call("fest_plan", { name: "feature", plan, action: "cancel", approvedRevision: next.planRevision });
    expect(cancelled).toMatchObject({ kind: "plan_cancelled", artifactsPreserved: true });
    expect(await readFile(artifact, "utf8")).toContain('"name": "feature"');
    const stillActive = await call("fest_plan", { name: "third-plan", action: "preview", spec });
    expect(stillActive).toMatchObject({ kind: "planning_conflict", conflicts: [{ name: "other-plan" }] });
  });
  it("invalidates approval when a newer preview replaces the approved revision", async () => {
    const { plan, spec, call, scaffoldFromPlan } = await setup();
    const approved = await call("fest_plan", { name: "feature", plan, action: "preview", spec }, { confirm: () => Promise.resolve(true) });
    const replacement = await call("fest_plan", { name: "feature", plan, action: "preview", spec });
    expect(replacement.planRevision).not.toBe(approved.planRevision);
    const stale = await call("fest_plan", { name: "feature", plan, action: "scaffold", approvedRevision: approved.planRevision });
    expect(stale.kind).toBe("plan_failed");
    expect(scaffoldFromPlan).not.toHaveBeenCalled();
  });

  it("rejects parser counts that lose approved tasks", async () => {
    const { plan, scaffold, scaffoldFromPlan } = await setup();
    scaffoldFromPlan.mockResolvedValueOnce(JSON.stringify({
      ok: true, phases_created: 1, sequences_created: 1, tasks_created: 0, dry_run: true,
    }));
    const result = await scaffold({ name: "feature", plan });
    expect(result.kind).toBe("plan_failed");
    expect(result.error).toContain("differs from the approved plan");
    expect(scaffoldFromPlan).toHaveBeenCalledTimes(1);
  });


  it("does not open a blocking selection modal when a plan overlap needs human choice", async () => {
    const { spec, call } = await setup();
    await call("fest_plan", { name: "modal-first", action: "preview", spec });
    const select = vi.fn(() => new Promise<string | undefined>(() => undefined));
    const result = await call("fest_plan", { name: "modal-second", action: "preview", spec }, { select });
    expect(result).toMatchObject({ kind: "planning_conflict", choices: ["sequence", "narrow", "worktree"] });
    expect(select).not.toHaveBeenCalled();
  });
  it("surfaces overlapping pending plans and leaves both untouched until the human chooses", async () => {
    const { root, spec, call } = await setup();
    const first = await call("fest_plan", { name: "plan-one", action: "preview", spec });
    expect(first.kind).toBe("plan_preview");
    const blocked = await call("fest_plan", { name: "plan-two", action: "preview", spec });
    expect(blocked).toMatchObject({ kind: "planning_conflict", choices: ["sequence", "narrow", "worktree"] });
    expect(await readFile(join(root, ".ompfest", "plans", "plan-one.STRUCTURE.md.json"), "utf8")).toContain('"name": "plan-one"');
    await expect(readFile(join(root, ".ompfest", "plans", "plan-two.STRUCTURE.md"), "utf8")).rejects.toThrow();
    const sequenced = await call("fest_plan", { name: "plan-two", action: "preview", spec, conflictChoice: "sequence" });
    expect(sequenced.kind).toBe("plan_preview");
    expect(jsonObject(await readFile(join(root, ".ompfest", "plans", "plan-two.STRUCTURE.md.json"), "utf8")).rules).toContain("Keep all plans");
  });

  it("does not treat a previously scaffolded plan artifact as pending work", async () => {
    const { scaffold, call, root, spec } = await setup();
    await scaffold({ name: "finished-plan" });
    const next = await call("fest_plan", { name: "next-plan", action: "preview", spec });
    expect(next.kind).toBe("plan_preview");
    const status = jsonObject(await readFile(join(root, ".ompfest", "plans", "finished-plan.STRUCTURE.md.status.json"), "utf8"));
    expect(status.state).toBe("scaffolded");
    expect(typeof status.planRevision).toBe("string");
  });
  it("invalidates approval when visual references change", async () => {
    const { plan, spec, referencesDir, call, scaffoldFromPlan } = await setup();
    const visual = { visualIntent: "ui_visual", attachments: [{ name: "design-reference", description: "User-provided UI design reference", role: "ui_design" }] };
    const preview = await call("fest_plan", { name: "feature", plan, spec, referencesDir, action: "preview", ...visual });
    await writeFile(join(referencesDir, "pages", "results", "wireframe.svg"), SVG.replace("Search</text>", "Find</text>"));
    const result = await call("fest_plan", { name: "feature", plan, referencesDir, action: "scaffold", approvedRevision: preview.planRevision, ...visual });
    expect(result.kind).toBe("plan_failed");
    expect(result.error).toContain("changed since approval");
    expect(scaffoldFromPlan).not.toHaveBeenCalled();
  });
});
