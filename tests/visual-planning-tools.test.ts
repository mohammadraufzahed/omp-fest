import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { registerTools, type PiLike } from "../src/adapters/omp/tools.js";
import { registerCommands, type PiCommandsLike } from "../src/adapters/omp/commands.js";
import { LoopTracker } from "../src/application/loop-tracker.js";
import type { CampCli, FestCli } from "../src/ports.js";
import { PAGE, SVG, TASK } from "./visual-fixture.js";

type Execute = (id: string, params: Record<string, unknown>, signal: unknown, update: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }>;
const schema = (): { optional(): unknown; describe(): unknown } => ({ optional: schema, describe: schema });

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
  const scaffoldFromPlan = vi.fn(async () => {
      await mkdir(sequence, { recursive: true });
      await writeFile(join(festival, "fest.yaml"), "id: feature\n");
      await writeFile(join(sequence, "01_results.md"), TASK);
      await writeFile(join(sequence, "SEQUENCE_GOAL.md"), "---\nfest_tracking: true\n---\n");
      return JSON.stringify({ ok: true, festival_dir: festival });
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
  const tools = new Map<string, Execute>();
  registerTools({
    zod: { object: schema, string: schema, number: schema, boolean: schema, enum: schema, array: schema } as never,
    registerTool: (tool) => tools.set(tool.name as string, tool.execute as Execute),
  } satisfies PiLike, {
    fest,
    camp: { projects: () => Promise.resolve([]) } as unknown as CampCli,
    detect: new CampFsDetect(),
    tracker: new LoopTracker(),
  });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "session-1" } };
  async function call(name: string, params: Record<string, unknown> = {}, ui?: Record<string, unknown>) {
    const result = await tools.get(name)!("id", params, undefined, undefined, { ...ctx, ...(ui ? { ui } : {}) });
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  }
  let handler: Parameters<PiCommandsLike["registerCommand"]>[1]["handler"] | undefined;
  const sent: string[] = [];
  registerCommands({
    registerCommand: (_name, options) => { handler = options.handler; },
    sendMessage: (message) => { sent.push(String(message.content)); },
  }, { fest, camp: {} as CampCli, detect: new CampFsDetect() });
  async function command(args: string): Promise<string> {
    await handler?.(args, { cwd: root, ui: { notify: vi.fn() } });
    return sent.at(-1) ?? "";
  }
  return { root, referencesDir, festival, plan, taskPath, scaffoldFromPlan, promote, taskComplete, workflowAdvance, workflowApprove, call, command };
}

describe("visual planning tool handoff", () => {
  it("previews within the plan flow and applies reviewed revisions without scaffolding again", async () => {
    const { referencesDir, festival, plan, scaffoldFromPlan, call } = await setup();
    const preview = await call("fest_plan", { name: "feature", plan, referencesDir, referenceAction: "preview" });
    expect(preview.kind).toBe("plan_preview");
    expect((preview.preview as { file: string }).file).toBe(plan.replace(".STRUCTURE.md", ".preview.html"));
    expect(scaffoldFromPlan).not.toHaveBeenCalled();
    await call("fest_plan", { name: "feature", plan, referencesDir });
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
    expect(scaffoldFromPlan).toHaveBeenCalledTimes(1);
  });

  it("scaffolds references, validates task links and supplies page notes to next and parallel", async () => {
    const { referencesDir, festival, plan, taskPath, call, command } = await setup();
    const scaffolded = await call("fest_plan", { name: "feature", plan, referencesDir, rules: "- preserve RTL column order" });
    expect(scaffolded.kind).toBe("plan_scaffolded");
    expect(scaffolded.visualReferences).toEqual(["references/pages/results/PAGE.md"]);
    expect(await readFile(join(festival, "references", "pages", "results", "PAGE.md"), "utf8")).toContain("RTL");
    expect(await readFile(join(festival, "FESTIVAL_RULES.md"), "utf8")).toContain("preserve RTL column order");
    const validation = await call("fest_validate");
    expect((validation.visualReferences as { issues: string[] }).issues).toEqual([]);
    const next = await call("fest_next");
    expect((next.visualReferences as { content: string }[])[0]?.content).toContain("filters.search");
    const backend = join(festival, "001_BUILD", "02_api");
    await mkdir(backend);
    await writeFile(join(backend, "01_api.md"), "---\nfest_type: task\n---\n# Backend");
    const lanes = (await call("fest_parallel")).lanes as { tasks: string[]; visualReferences: { page: string }[] }[];
    expect(lanes[0]?.tasks).toEqual([taskPath]);
    expect(lanes[0]?.visualReferences[0]?.page).toBe("results");
    expect(lanes[1]?.visualReferences).toEqual([]);
    expect(await command("next")).toContain("filters.search");
    expect(await command("validate")).toContain("Visual references: valid");
    expect(await command("parallel")).toContain("wireframe.svg");
  });

  it("rejects invalid bundles before calling the scaffold and blocks missing links at promotion", async () => {
    const { referencesDir, festival, plan, scaffoldFromPlan, promote, call, taskPath, command } = await setup();
    const failure = await call("fest_plan", { name: "feature", plan, referencesDir: join(referencesDir, "pages") });
    expect(failure.kind).toBe("plan_failed");
    expect(scaffoldFromPlan).not.toHaveBeenCalled();
    await call("fest_plan", { name: "feature", plan, referencesDir });
    await writeFile(join(festival, taskPath), "# UI\nNo link");
    const validation = await call("fest_validate");
    expect(validation.kind).toBe("validation_failed");
    expect((await call("fest_promote", { festival: "feature" })).kind).toBe("promotion_blocked");
    expect((await call("fest_gate_submit", { evidence: "done" })).kind).toBe("gate_blocked");
    expect(await command("promote")).toContain("Promotion blocked");
    expect(promote).not.toHaveBeenCalled();
  });

  it("requires honest task evidence and blocks the gate for missing, failed or stale checks", async () => {
    const { referencesDir, festival, plan, taskPath, taskComplete, workflowAdvance, call, command } = await setup();
    await call("fest_plan", { name: "feature", plan, referencesDir });
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
    const { referencesDir, festival, plan, taskPath, call, workflowAdvance, workflowApprove } = await setup();
    await call("fest_plan", { name: "feature", plan, referencesDir });
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
});
