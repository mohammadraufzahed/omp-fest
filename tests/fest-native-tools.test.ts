import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFestNativeTools } from "../src/adapters/omp/fest-native-tools.js";
import type { PiLike, ToolDeps } from "../src/adapters/omp/tools.js";
import type { NativeContext } from "../src/adapters/omp/fest-native-context.js";
import type { ZodSchema } from "../src/adapters/omp/zod-types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
type Execute = (id: string, params: Record<string, unknown>, signal: unknown, update: unknown, context: NativeContext) => Promise<{ content: { text: string }[] }>;
const schema = (): ZodSchema => ({ optional: schema, describe: schema });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-tools-")); roots.push(root);
  await writeFile(join(root, "fest.yaml"), "metadata: {id: EX0001}\n");
  await writeFile(join(root, ".omp-fest-owner.json"), JSON.stringify({ sessionId: "main", pid: process.pid, claimedAt: new Date().toISOString() }));
  const raw = vi.fn((_cwd: string, args: string[]) => Promise.resolve({ code: 0, stdout: args.includes("--json") || args.includes("--agent") ? "{}" : "native output", stderr: "" }));
  const deps = { fest: { raw }, detect: { locate: () => Promise.resolve({ kind: "camp-root", campRoot: root }), listFestivals: () => Promise.resolve([{ id: "example-EX0001", path: root, name: "example", status: "planning" }]) } } as unknown as ToolDeps;
  const tools = new Map<string, Execute>();
  registerFestNativeTools({ zod: { object: schema, string: schema, number: schema, boolean: schema, enum: schema, array: schema }, registerTool: (tool) => tools.set(String(tool.name), tool.execute as Execute) } satisfies PiLike, deps);
  const context: NativeContext = { cwd: root, sessionManager: { getSessionId: () => "main" } };
  async function call(name: string, params: Record<string, unknown>, ctx: NativeContext = context) {
    const result = await tools.get(name)!("id", params, undefined, undefined, ctx);
    const data: unknown = JSON.parse(result.content[0]!.text);
    if (!data || typeof data !== "object") throw new Error("Expected tool object");
    return data as Record<string, unknown>;
  }
  return { root, raw, tools, call, context };
}
describe("typed native fest surfaces", () => {
  it("registers concrete feature tools rather than a generic args escape", async () => {
    const { tools } = await fixture();
    expect([...tools.keys()].sort()).toEqual(["fest_authoring", "fest_chain", "fest_feedback", "fest_handoff", "fest_judge", "fest_replay", "fest_research", "fest_ritual", "fest_workflow_native"]);
  });
  it("allows reads but blocks worker and non-owner mutations", async () => {
    const { root, raw, call, context } = await fixture();
    expect(await call("fest_feedback", { action: "view", festival: "EX0001" }, { ...context, agent: { kind: "sub" } })).toMatchObject({ kind: "native_result" });
    raw.mockClear();
    expect(await call("fest_feedback", { action: "add", festival: "EX0001", criterion: "Quality", observation: "Observed output" }, { ...context, agent: { kind: "sub" } })).toMatchObject({ kind: "native_blocked" });
    expect(await call("fest_feedback", { action: "add", festival: "EX0001", criterion: "Quality", observation: "Observed output" }, { cwd: root, sessionManager: { getSessionId: () => "other" } })).toMatchObject({ kind: "native_blocked" });
    expect(raw).not.toHaveBeenCalled();
  });
  it("requires both explicit judge opt-in and real human approval", async () => {
    const { raw, call, context } = await fixture();
    expect(await call("fest_judge", { action: "run", festival: "EX0001" })).toMatchObject({ kind: "native_blocked" });
    expect(raw).not.toHaveBeenCalled();
    expect(await call("fest_judge", { action: "run", festival: "EX0001", operatorOptIn: true })).toMatchObject({ kind: "native_blocked" });
    expect(raw.mock.calls.some(([, args]) => args.includes("judge"))).toBe(false);
    await call("fest_judge", { action: "run", festival: "EX0001", operatorOptIn: true, wait: true }, { ...context, ui: { confirm: () => Promise.resolve(true) } });
    expect(raw.mock.calls.at(-1)?.[1]).toEqual(["workflow", "judge", "--wait"]);
    expect(raw.mock.calls.every(([, args]) => !args.includes("--judge-command"))).toBe(true);
  });
  it("links an operator rejection to native remediation without approval impersonation", async () => {
    const { raw, call, context } = await fixture();
    await call("fest_judge", { action: "reject", festival: "EX0001", reason: "Missing acceptance proof", remediationPhase: "005_REMEDIATE" }, { ...context, ui: { confirm: () => Promise.resolve(true) } });
    expect(raw.mock.calls.at(-1)?.[1]).toEqual(["workflow", "reject", "--reason", "Missing acceptance proof", "--remediation-phase", "005_REMEDIATE"]);
  });
  it("uses relative phase selectors and rejects standalone ownership bypass", async () => {
    const { raw, call } = await fixture();
    await call("fest_workflow_native", { action: "status", mode: "festival", festival: "EX0001", phase: "001_PLAN" });
    expect(raw.mock.calls.at(-1)?.[1]).toEqual(["workflow", "status", "--json", "--phase", "001_PLAN"]);
    raw.mockClear();
    expect(await call("fest_workflow_native", { action: "advance", mode: "standalone" })).toMatchObject({ kind: "native_blocked" });
    expect(raw).not.toHaveBeenCalled();
  });
  it("authors standalone steps without requiring a camp or claiming a festival", async () => {
    const { raw, call, context } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "standalone-native-")); roots.push(outside);
    const result = await call("fest_workflow_native", { action: "create", mode: "standalone", name: "review", title: "Review change", steps: [{ name: "Inspect", goal: "Observe changes", actions: ["Read source"], output: "Actual findings", checkpoint: "approval_required" }] }, { ...context, cwd: outside });
    expect(result).toMatchObject({ kind: "native_result" });
    expect(raw.mock.calls.at(-1)?.[0]).toBe(outside);
    expect(raw.mock.calls.at(-1)?.[1].slice(0, 5)).toEqual(["workflow", "create", "review", "--agent", "--steps"]);
  });
  it("requires human decisions for ritual and chain changes", async () => {
    const { raw, call } = await fixture();
    expect(await call("fest_ritual", { action: "convert", festival: "EX0001" })).toMatchObject({ kind: "native_blocked" });
    expect(await call("fest_chain", { action: "complete", chain: "CH0001" })).toMatchObject({ kind: "native_blocked" });
    expect(raw).not.toHaveBeenCalled();
  });
  it("rejects output symlink escapes before invoking the CLI", async () => {
    const { root, raw, call } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "native-outside-")); roots.push(outside);
    await symlink(outside, join(root, "outside"));
    expect(await call("fest_replay", { action: "generate", festival: "EX0001", output: "outside/replay.gif" })).toMatchObject({ kind: "native_blocked" });
    expect(raw).not.toHaveBeenCalled();
  });
});
