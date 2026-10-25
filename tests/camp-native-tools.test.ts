import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerCampNativeTools } from "../src/adapters/omp/camp-native-tools.js";
import { campRelativePath, intentCommand, parseNativeJson, questCommand, triageCommand, triageRevision, workitemCommand } from "../src/application/camp-native.js";
import type { PiLike, ToolDeps } from "../src/adapters/omp/tools.js";
import type { ExecResult } from "../src/ports.js";

interface Result { content: { text: string }[]; isError?: boolean }
interface Context { cwd: string; agent?: { kind: string }; ui?: { confirm(title: string, message: string): Promise<boolean> } }
type Execute = (id: string, params: Record<string, unknown>, signal: unknown, update: unknown, ctx: Context) => Promise<Result>;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "camp-native-tools-")); roots.push(root);
  const dir = join(root, ".campaign", "triage", "runs", "run-native-1"); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.json"), JSON.stringify({ run_id: "run-native-1", phase: "reviewing" }));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({ rows: [{ stable_id: "design-auth-1" }] }));
  await writeFile(join(dir, "TRIAGE_REVIEW.md"), "# Native review\n\n`design-auth-1` → dungeon/completed\n");
  return { root, dir };
}
function harness(root: string, respond?: (args: string[]) => Promise<ExecResult> | ExecResult) {
  const tools = new Map<string, Execute>(); const calls: string[][] = [];
  const schema = { optional() { return this; }, describe() { return this; } };
  const zod = { object: () => schema, string: () => schema, number: () => schema, boolean: () => schema, enum: () => schema, array: () => schema };
  const deps = {
    camp: { raw: async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (respond) return respond(args);
      const action = args[1];
      const native = action === "status" ? { run: { run_id: "run-native-1" } }
        : action === "review" ? { render: { review_path: ".campaign/triage/runs/run-native-1/TRIAGE_REVIEW.md" } }
          : action === "apply" ? { run_id: "run-native-1", dry_run: args.includes("--dry-run"), plan: { entries: [{ stable_id: "design-auth-1", undo: ["camp", "workitem", "demote", "design-auth-1"] }] } }
            : { run_id: "run-native-1", native: true };
      return { code: 0, stdout: JSON.stringify(native), stderr: "" };
    } },
    detect: { locate: () => Promise.resolve({ campRoot: root }) },
  } as unknown as ToolDeps;
  registerCampNativeTools({ zod, registerTool: (tool) => { tools.set(String(tool.name), tool.execute as Execute); } } satisfies PiLike, deps);
  return { calls, invoke: async (name: string, params: Record<string, unknown>, ctx: Context = { cwd: root }) => {
    const execute = tools.get(name); if (!execute) throw new Error(`Missing tool ${name}`);
    const result = await execute("test", params, undefined, undefined, ctx);
    return { ...result, value: parseNativeJson(result.content[0]?.text ?? "null") };
  } };
}

describe("native Camp command construction", () => {
  it("creates design tracking with explicit cross-project and quest metadata", () => {
    expect(workitemCommand("/camp", { action: "create", slug: "auth-design", type: "design", title: "Auth", projects: ["projects/api", "projects/web"], quest: "qst_launch", tags: ["launch"] })).toEqual(["workitem", "create", "auth-design", "--title", "Auth", "--type", "design", "--quest", "qst_launch", "--project", "projects/api", "--project", "projects/web", "--tag", "launch", "--json"]);
    expect(workitemCommand("/camp", { action: "link", selector: "WI-ab12cd", festival: "demo-DE0001" })).toEqual(["workitem", "link", "WI-ab12cd", "--festival", "demo-DE0001", "--json"]);
  });
  it("uses workitem promotion for native WI refs, universal promotion for intents", () => {
    expect(workitemCommand("/camp", { action: "promote", selector: "WI-ab12cd", target: "ready", dryRun: true })).toEqual(["workitem", "promote", "WI-ab12cd", "--target", "ready", "--json", "--no-commit", "--dry-run"]);
    expect(intentCommand({ action: "promote", selector: "intent-native-1", target: "design", dryRun: true })).toEqual(["promote", "intent-native-1", "--target", "design", "--json", "--no-commit", "--dry-run"]);
  });
  it("uses the native checklist link command and scoped metadata edits", () => {
    expect(questCommand("/camp", { action: "item_link", quest: "qst_launch", item: "qci_1", workitem: "WI-ab12cd" })).toEqual({ args: ["quest", "item", "link-workitem", "qst_launch", "qci_1", "WI-ab12cd", "--no-commit", "--json"], json: true });
    expect(questCommand("/camp", { action: "update", quest: "qst_launch", purpose: "" })).toEqual({ args: ["quest", "update", "qst_launch", "--purpose", "", "--no-commit"], json: false });
  });
  it("rejects option-like selectors, escaped paths, ambiguous scopes and empty evidence", () => {
    expect(() => workitemCommand("/camp", { action: "links", selector: "--help" })).toThrow("literal");
    expect(() => campRelativePath("/camp", "../outside")).toThrow("within");
    expect(() => workitemCommand("/camp", { action: "link", selector: "WI-ab12cd", project: "api", festival: "demo" })).toThrow("exactly one");
    expect(() => triageCommand({ action: "evidence", stableId: "design-auth-1" })).toThrow("exactly one");
    expect(() => triageCommand({ action: "approve", ids: ["design-auth-1"], lane: "parked" })).toThrow("exactly one");
  });
  it("keeps native scopes and avoids identity repair, force and interactive review", () => {
    expect(triageCommand({ action: "start", scopes: ["type:design", "project:projects/api"] })).toEqual(["triage", "start", "--scope", "type:design", "--scope", "project:projects/api", "--identity", "strict", "--json"]);
    expect(triageCommand({ action: "review", run: "run-native-1" })).toEqual(["triage", "review", "--run", "run-native-1", "--render-only", "--json"]);
  });
});

describe("native Camp tool authority and decisions", () => {
  it("allows worker queue reads but blocks all state recording", async () => {
    const { root } = await fixture(); const h = harness(root); const worker = { cwd: root, agent: { kind: "sub" } };
    expect((await h.invoke("camp_triage", { action: "queue" }, worker)).isError).toBeUndefined();
    h.calls.splice(0);
    for (const [name, params] of [["camp_triage", { action: "propose", stableId: "design-auth-1", disposition: "completed", summary: "evidence" }], ["camp_quest", { action: "item_done", quest: "qst_1", item: "qci_1" }], ["camp_workitem", { action: "create", slug: "new" }], ["camp_intent", { action: "create", title: "New" }]] as const) {
      expect((await h.invoke(name, params, worker)).isError).toBe(true);
    }
    expect(h.calls).toEqual([]);
  });
  it("never approves without a human UI and preserves run pins", async () => {
    const { root } = await fixture(); const h = harness(root);
    const result = await h.invoke("camp_triage", { action: "approve", ids: ["design-auth-1"] });
    expect(result.isError).toBe(true); expect(JSON.stringify(result.value)).toContain("native confirmation UI");
    expect(h.calls.some((args) => args[1] === "approve")).toBe(false);
    expect(h.calls.filter((args) => args[1] !== "status").every((args) => args.includes("run-native-1"))).toBe(true);
  });
  it("refreshes and shows review before separately confirming native approval", async () => {
    const { root } = await fixture(); const h = harness(root); const prompts: string[] = [];
    const result = await h.invoke("camp_triage", { action: "approve", ids: ["design-auth-1"] }, { cwd: root, ui: { confirm: (_title, message) => { prompts.push(message); return Promise.resolve(true); } } });
    expect(result.isError).toBeUndefined(); expect(prompts[0]).toContain("dungeon/completed");
    expect(h.calls.map((args) => args[1])).toEqual(["status", "refresh", "review", "review", "approve"]);
    expect(h.calls.at(-1)).toContain("design-auth-1");
    expect(h.calls.some((args) => args[1] === "apply")).toBe(false);
  });
  it("rejects a decision if native evidence changes during human review", async () => {
    const { root, dir } = await fixture(); const h = harness(root);
    const result = await h.invoke("camp_triage", { action: "approve", ids: ["design-auth-1"] }, { cwd: root, ui: { confirm: async () => { await writeFile(join(dir, "decisions.jsonl"), '{"event":"superseded"}\n'); return true; } } });
    expect(result.isError).toBe(true); expect(JSON.stringify(result.value)).toContain("changed while the human");
    expect(h.calls.some((args) => args[1] === "approve")).toBe(false);
  });
  it("shows native undo plan and requires another confirmation before applying", async () => {
    const { root } = await fixture(); const h = harness(root); const prompts: string[] = [];
    await h.invoke("camp_triage", { action: "apply" }, { cwd: root, ui: { confirm: (_title, message) => { prompts.push(message); return Promise.resolve(true); } } });
    expect(prompts[0]).toContain("undo");
    expect(h.calls.map((args) => args[1])).toEqual(["status", "refresh", "apply", "apply"]);
    expect(h.calls.at(-2)).toContain("--dry-run"); expect(h.calls.at(-1)).not.toContain("--dry-run");
    expect(h.calls.flat()).not.toContain("--force");
  });
  it("honors human cancellation without recording verdicts", async () => {
    const { root } = await fixture(); const h = harness(root);
    const result = await h.invoke("camp_triage", { action: "approve", ids: ["design-auth-1"] }, { cwd: root, ui: { confirm: () => Promise.resolve(false) } });
    expect(JSON.stringify(result.value)).toContain("camp_triage_cancelled"); expect(h.calls.some((args) => args[1] === "approve")).toBe(false);
  });
  it("stops before approval when native freshness refresh fails", async () => {
    const { root } = await fixture(); let confirmations = 0;
    const h = harness(root, (args) => args[1] === "status" ? { code: 0, stdout: '{"run":{"run_id":"run-native-1"}}', stderr: "" } : { code: 2, stdout: '{"stale":["design-auth-1"]}', stderr: "refresh refused" });
    const result = await h.invoke("camp_triage", { action: "approve", ids: ["design-auth-1"] }, { cwd: root, ui: { confirm: () => { confirmations++; return Promise.resolve(true); } } });
    expect(result.isError).toBe(true); expect(confirmations).toBe(0);
    expect(h.calls.map((args) => args[1])).toEqual(["status", "refresh"]);
  });
  it("preserves native create identity, revision fields, paths and content next action", async () => {
    const { root } = await fixture();
    const native = { schema_version: "workitem-create/v1alpha1", workitem: { id: "design-auth-2026-10-25", ref: "WI-ab12cd", marker_version: "v1alpha9", relative_path: "workflow/design/auth" }, next: { command: "fest create workflow auth", cwd: "workflow/design/auth", hint: "tracking only" } };
    const h = harness(root, () => ({ code: 0, stdout: JSON.stringify(native), stderr: "" }));
    const result = await h.invoke("camp_workitem", { action: "create", slug: "auth", type: "design" });
    expect(result.value).toEqual({ kind: "camp_workitem", native, campRoot: root });
  });
  it("lets workers inspect apply plans without refreshing or opening approval", async () => {
    const { root } = await fixture(); const h = harness(root);
    const result = await h.invoke("camp_triage", { action: "apply", dryRun: true }, { cwd: root, agent: { kind: "sub" } });
    expect(result.isError).toBeUndefined(); expect(h.calls.map((args) => args[1])).toEqual(["status", "apply"]);
    expect(h.calls.at(-1)).toContain("--dry-run");
  });
  it("propagates native nonzero verification as failure with exact diagnostics", async () => {
    const { root } = await fixture(); const h = harness(root, (args) => args[1] === "status" ? { code: 0, stdout: '{"run":{"run_id":"run-native-1"}}', stderr: "" } : { code: 1, stdout: '{"mismatches":["stage"]}', stderr: "verification mismatch" });
    const result = await h.invoke("camp_triage", { action: "verify" });
    expect(result.isError).toBe(true); expect(JSON.stringify(result.value)).toContain("verification mismatch"); expect(JSON.stringify(result.value)).toContain('"code":1');
  });
  it("returns shell context instructions without claiming terminal activation", async () => {
    const { root } = await fixture(); const h = harness(root, () => ({ code: 0, stdout: "export CAMP_QUEST=qst_launch\n", stderr: "" }));
    const result = await h.invoke("camp_quest", { action: "context", quest: "qst_launch" });
    expect(JSON.stringify(result.value)).toContain('"activated":false'); expect(JSON.stringify(result.value)).toContain("CAMP_QUEST");
  });
  it("binds revision to native evidence and decisions, not rendered markdown", async () => {
    const { root, dir } = await fixture(); const before = await triageRevision(root, "run-native-1");
    await writeFile(join(dir, "TRIAGE_REVIEW.md"), "render changed"); expect(await triageRevision(root, "run-native-1")).toBe(before);
    await writeFile(join(dir, "decisions.jsonl"), '{"event":"approved"}\n'); expect(await triageRevision(root, "run-native-1")).not.toBe(before);
    await expect(triageRevision(root, "../escape")).rejects.toThrow("Invalid native run");
  });
});
