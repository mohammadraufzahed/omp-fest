/**
 * Interactive gate approval: fest_gate_submit must ask the human via the
 * omp UI surface (evidence card -> confirm -> approve, or input reason ->
 * reject) inside the tool call itself — never leave the chat waiting on a
 * text reply when interactive UI exists. Covers the dialog paths and the
 * headless awaiting_human fallback, with a real camp + real gate files.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { registerTools, type PiLike } from "../src/adapters/omp/tools.js";
import { seedFestivalRules } from "../src/application/festival-rules.js";
import { claimFestivalOwnership } from "../src/application/festival-ownership.js";
import { joinFestivalTeam } from "../src/application/festival-team.js";
import { LoopTracker } from "../src/application/loop-tracker.js";
import { DEFAULT_CONFIG, type OmpFestConfig } from "../src/domain/types.js";
import type { CampCli, FestCli } from "../src/ports.js";

interface ToolResultShape {
  content: { type: string; text: string }[];
}

type ToolExecute = (
  id: string,
  params: Record<string, unknown>,
  signal: unknown,
  onUpdate: unknown,
  ctx: unknown,
) => Promise<ToolResultShape>;

const schema = (): { optional(): unknown; describe(): unknown } => ({
  optional: schema,
  describe: schema,
});

function makePi() {
  const tools = new Map<string, { execute: ToolExecute }>();
  const pi: PiLike = {
    zod: {
      object: schema,
      string: schema,
      number: schema,
      boolean: schema,
      enum: schema,
      array: schema,
    } as never,
    registerTool: (tool) => {
      tools.set(tool.name as string, tool as { execute: ToolExecute });
    },
  };
  return { pi, tools };
}

interface FestCalls {
  advanced: number;
  approved: number;
  rejected: string[];
}

function fakeFest(calls: FestCalls): FestCli {
  return {
    workflowAdvance: () => {
      calls.advanced += 1;
      return Promise.resolve("");
    },
    workflowApprove: () => {
      calls.approved += 1;
      return Promise.resolve("approved-ok");
    },
    workflowReject: (_dir: string, reason: string) => {
      calls.rejected.push(reason);
      return Promise.resolve("rejected-ok");
    },
  } as unknown as FestCli;
}

async function makeCampWithFestival(id = "fest-a"): Promise<{ root: string; dir: string }> {
  const root = await mkdtemp(join(tmpdir(), "gate-camp-"));
  await mkdir(join(root, "festivals", "active"), { recursive: true });
  await mkdir(join(root, "projects"), { recursive: true });
  const dir = join(root, "festivals", "active", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "fest.yaml"), `id: ${id}\n`);
  const ownership = await claimFestivalOwnership(dir, "s1");
  if (ownership.kind !== "claimed") throw new Error(`Cannot select gate test festival: ${ownership.kind}`);
  await joinFestivalTeam(root, dir, "s1", "s1");
  return { root, dir };
}

function ctxFor(cwd: string, ui?: Record<string, unknown>) {
  return { cwd, sessionManager: { getSessionId: () => "s1" }, ...(ui ? { ui } : {}) };
}

function parse(result: ToolResultShape): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function harness(calls: FestCalls, config: Partial<OmpFestConfig> = {}) {
  const { pi, tools } = makePi();
  const tracker = new LoopTracker();
  registerTools(pi, {
    fest: fakeFest(calls),
    camp: { projects: () => Promise.resolve([]) } as unknown as CampCli,
    detect: new CampFsDetect(),
    tracker,
    config: () => Promise.resolve({ ...DEFAULT_CONFIG, ...config }),
  });
  const execute = tools.get("fest_gate_submit")!.execute;
  return async (id: string, params: Record<string, unknown>, signal: unknown, update: unknown, ctx: unknown) => {
    const cwd = (ctx as { cwd: string }).cwd;
    tracker.claimFestival("s1", join(cwd, "festivals", "active", "fest-a"));
    return execute(id, params, signal, update, ctx);
  };
}

describe("fest_gate_submit dialog", () => {
  it("asks the human via confirm and runs the real approval", async () => {
    const { root } = await makeCampWithFestival();
    const calls: FestCalls = { advanced: 0, approved: 0, rejected: [] };
    const submit = harness(calls);
    const confirms: { title: string; message: string }[] = [];
    const ui = {
      confirm: (title: string, message: string) => {
        confirms.push({ title, message });
        return Promise.resolve(true);
      },
    };
    const res = await submit("t", { evidence: "tests pass; 4/4 gates" }, undefined, undefined, ctxFor(root, ui));
    expect(parse(res).status).toBe("approved");
    expect(calls.approved).toBe(1);
    expect(calls.advanced).toBe(1); // gate marked pending before the dialog opens
    expect(confirms[0]?.message).toContain("tests pass");
  });

  it("reject prompts for a reason and runs the real rejection", async () => {
    const { root } = await makeCampWithFestival();
    const calls: FestCalls = { advanced: 0, approved: 0, rejected: [] };
    const submit = harness(calls);
    const ui = {
      confirm: () => Promise.resolve(false),
      input: () => Promise.resolve("missing edge-case tests"),
    };
    const res = await submit("t", { evidence: "x" }, undefined, undefined, ctxFor(root, ui));
    const payload = parse(res);
    expect(payload.status).toBe("rejected");
    expect(calls.rejected).toEqual(["missing edge-case tests"]);
  });
  it("shows recorded constraints inside the dialog", async () => {
    const { root, dir } = await makeCampWithFestival();
    await seedFestivalRules(root, dir, "- no force-push");
    const calls: FestCalls = { advanced: 0, approved: 0, rejected: [] };
    const submit = harness(calls);
    let message = "";
    const ui = {
      confirm: (_t: string, m: string) => {
        message = m;
        return Promise.resolve(true);
      },
      custom: (_f: unknown, _o: unknown) => Promise.resolve(undefined),
    };
    // custom returns undefined → showCard falls back → message carries constraints
    const res = await submit("t", { evidence: "all checks green" }, undefined, undefined, ctxFor(root, ui));
    expect(parse(res).status).toBe("approved");
    expect(message).toContain("no force-push");
  });

  it("falls back to awaiting_human with rulesEvidence when no UI exists", async () => {
    const { root, dir } = await makeCampWithFestival();
    await seedFestivalRules(root, dir, "- no force-push");
    const calls: FestCalls = { advanced: 0, approved: 0, rejected: [] };
    const submit = harness(calls);
    const res = await submit("t", { evidence: "e" }, undefined, undefined, ctxFor(root));
    const payload = parse(res);
    expect(payload.status).toBe("awaiting_human");
    expect(payload.rulesEvidence).toContain("no force-push");
    expect(calls.advanced).toBe(1);
    expect(calls.approved).toBe(0);
  });

  it("honors pauseAtGates=false — stays in awaiting_human even with a UI", async () => {
    const { root } = await makeCampWithFestival();
    const calls: FestCalls = { advanced: 0, approved: 0, rejected: [] };
    const submit = harness(calls, { pauseAtGates: false });
    let asked = false;
    const ui = { confirm: () => { asked = true; return Promise.resolve(true); } };
    const res = await submit("t", { evidence: "e" }, undefined, undefined, ctxFor(root, ui));
    expect(parse(res).status).toBe("awaiting_human");
    expect(asked).toBe(false);
  });

  it("requires evidence when the camp demands it", async () => {
    const { root } = await makeCampWithFestival();
    const calls: FestCalls = { advanced: 0, approved: 0, rejected: [] };
    const submit = harness(calls, { evidenceRequiredOnGates: true });
    const res = await submit("t", { evidence: "  " }, undefined, undefined, ctxFor(root, { confirm: () => Promise.resolve(true) }));
    expect(parse(res).kind).toBe("gate_evidence_required");
    expect(calls.approved).toBe(0);
  });
});
