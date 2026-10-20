import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { registerTools, type PiLike } from "../src/adapters/omp/tools.js";
import { registerCommands, type PiCommandsLike } from "../src/adapters/omp/commands.js";
import { LoopTracker } from "../src/application/loop-tracker.js";
import type { CampCli, FestCli } from "../src/ports.js";

type Execute = (id: string, params: Record<string, unknown>, signal: unknown, update: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }>;
const schema = (): { optional(): unknown; describe(): unknown } => ({ optional: schema, describe: schema });
const TASK = "---\nfest_type: task\n---\n# UI\nVisual reference: references/pages/results/PAGE.md\n- [ ] Search works";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="0" y="20">Search</text></svg>';

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
  await writeFile(join(page, "PAGE.md"), "# Results\nfilters.search works; RTL acceptance check");
  await writeFile(join(page, "wireframe.svg"), SVG);
  const scaffoldFromPlan = vi.fn(async () => {
      await mkdir(sequence, { recursive: true });
      await writeFile(join(festival, "fest.yaml"), "id: feature\n");
      await writeFile(join(sequence, "01_results.md"), TASK);
      await writeFile(join(sequence, "SEQUENCE_GOAL.md"), "---\nfest_tracking: true\n---\n");
      return JSON.stringify({ ok: true, festival_dir: festival });
  });
  const promote = vi.fn(() => Promise.resolve("ok"));
  const fest: FestCli = {
    scaffoldFromPlan,
    gatesApply: () => Promise.resolve({ created: 0, output: "ok" }),
    validate: () => Promise.resolve({ score: 100, output: "ok" }),
    next: () => Promise.resolve({ kind: "task", path: taskPath, doc: TASK, goals: [] }),
    promote,
  } as unknown as FestCli;
  const tools = new Map<string, Execute>();
  registerTools({
    zod: { object: schema, string: schema, boolean: schema, enum: schema, array: schema } as never,
    registerTool: (tool) => tools.set(tool.name as string, tool.execute as Execute),
  } satisfies PiLike, {
    fest,
    camp: { projects: () => Promise.resolve([]) } as unknown as CampCli,
    detect: new CampFsDetect(),
    tracker: new LoopTracker(),
  });
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "session-1" } };
  async function call(name: string, params: Record<string, unknown> = {}) {
    const result = await tools.get(name)!("id", params, undefined, undefined, ctx);
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
  return { root, referencesDir, festival, plan, taskPath, scaffoldFromPlan, promote, call, command };
}

describe("visual planning tool handoff", () => {
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
});
