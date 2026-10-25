import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { campRelativePath, intentCommand, isNativeObject, nativeArgument, parseNativeJson, questCommand, triageCommand, triageRevision, workitemCommand } from "../../application/camp-native.js";
import type { IntentRequest, NativeJson, QuestRequest, TriageRequest, WorkitemRequest } from "../../application/camp-native.js";
import type { ExecResult } from "../../ports.js";
import type { PiLike, ToolDeps } from "./tools.js";

interface CampContext {
  cwd: string;
  sessionManager?: { getSessionId?(): string };
  agent?: { kind?: string };
  ui?: { confirm?(title: string, message: string, options?: Record<string, unknown>): Promise<boolean> };
}
function output(value: unknown, isError = false) { return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) }; }
class NativeFailure extends Error {
  constructor(readonly result: ExecResult, readonly args: string[]) { super(`camp ${args.join(" ")} exited ${result.code}: ${result.stderr || result.stdout}`); }
}
async function rootOf(deps: ToolDeps, ctx: CampContext): Promise<string> {
  const location = await deps.detect.locate(ctx.cwd);
  if (!location.campRoot) throw new Error("This action requires a resolved camp root; initialize or attach a camp first.");
  return location.campRoot;
}
async function run(deps: ToolDeps, root: string, args: string[], json = true): Promise<NativeJson> {
  const result = await deps.camp.raw(root, args);
  if (result.code !== 0) throw new NativeFailure(result, args);
  return json ? parseNativeJson(result.stdout) : result.stdout;
}
function failure(error: unknown) {
  return output({ kind: "camp_native_failed", error: error instanceof Error ? error.message : String(error), ...(error instanceof NativeFailure ? { code: error.result.code, stdout: error.result.stdout, stderr: error.result.stderr, command: ["camp", ...error.args] } : {}) }, true);
}
function authority(ctx: CampContext, mutation: boolean): void {
  if (mutation && ctx.agent?.kind === "sub") throw new Error("Main-agent authority required. Workers may inspect native workitems, quests and triage queues/templates; return evidence and proposals to the main agent for recording.");
}
async function human(ctx: CampContext, title: string, details: string): Promise<boolean> {
  if (!ctx.ui?.confirm) throw new Error("Human approval requires the native confirmation UI. No verdict or mutation was recorded; reopen this action in an interactive main session.");
  return ctx.ui.confirm(title, details);
}
function runId(status: NativeJson): string {
  if (!isNativeObject(status) || !isNativeObject(status.run) || typeof status.run.run_id !== "string") throw new Error("No native triage run is available. Start one first.");
  return nativeArgument(status.run.run_id, "run id");
}
async function readCampDocument(root: string, path: NativeJson | undefined): Promise<string> {
  if (typeof path !== "string") throw new Error("Camp did not return the expected review path.");
  const resolved = await realpath(resolve(root, campRelativePath(root, path)));
  const rel = relative(await realpath(root), resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Native review document escapes the camp root.");
  return readFile(resolved, "utf8");
}
async function triage(deps: ToolDeps, root: string, p: TriageRequest, ctx: CampContext): Promise<unknown> {
  const readOnly = ["status", "queue", "template"].includes(p.action) || (p.action === "apply" && p.dryRun === true);
  authority(ctx, !readOnly);
  if (p.action === "start") {
    const native = await run(deps, root, triageCommand(p));
    return { kind: "camp_triage", native, next: "Read queue, gather real evidence, then record proposals. Evidence and proposals are advisory, not human verdicts." };
  }
  const status = await run(deps, root, triageCommand({ action: "status", run: p.run }));
  if (p.action === "status") return { kind: "camp_triage", native: status };
  const pinned = { ...p, run: runId(status) };
  if (p.action !== "approve" && p.action !== "apply") {
    const native = await run(deps, root, triageCommand(pinned));
    return { kind: "camp_triage", native, run: pinned.run, ...(p.action === "propose" || p.action === "evidence" ? { authority: "advisory; not a human verdict", next: "Render review; request an explicit human decision through approve before apply." } : {}), ...(p.action === "refresh" ? { next: "Changed/gone/new rows require new evidence/proposals and renewed human approval. Native freshness remains authoritative." } : {}) };
  }
  if (p.action === "apply" && p.dryRun) return { kind: "camp_triage_plan", native: await run(deps, root, triageCommand(pinned)), run: pinned.run, next: "An explicit human confirmation is required for non-dry-run apply." };
  // Validate selectors before refresh or document writes.
  const args = triageCommand(pinned);
  const refreshed = await run(deps, root, triageCommand({ action: "refresh", run: pinned.run }));
  if (p.action === "approve") {
    // First render may legitimately advance the native phase to reviewing.
    await run(deps, root, triageCommand({ action: "review", run: pinned.run }));
    const beforeRender = await triageRevision(root, pinned.run);
    const rendered = await run(deps, root, triageCommand({ action: "review", run: pinned.run }));
    if (!isNativeObject(rendered) || !isNativeObject(rendered.render)) throw new Error("Invalid native triage review response.");
    const document = await readCampDocument(root, rendered.render.review_path);
    const revision = await triageRevision(root, pinned.run);
    if (beforeRender !== revision) throw new Error("Native triage state changed while rendering the review. No verdict recorded; review again.");
    const consent = await human(ctx, p.reject ? "Record human triage refusal?" : "Record human triage verdicts?", `Run: ${pinned.run}\nNative state digest: ${revision}\nExact command: camp ${args.join(" ")}\n${p.amend ? `AMEND disposition to ${p.amend}; this changes the proposal shown below.\n` : ""}Bulk lane/batch selectors skip terminal actions. Named terminal rows authorize their recorded dungeon/split actions. This records verdicts; applying them requires another human confirmation.\n\n${document}`);
    if (!consent) return { kind: "camp_triage_cancelled", run: pinned.run, rendered, refreshed, verdictRecorded: false };
    if (revision !== await triageRevision(root, pinned.run)) throw new Error("Native triage state changed while the human reviewed it. No verdict recorded; refresh and review again.");
    return { kind: "camp_triage_approved", humanConfirmed: true, native: await run(deps, root, args), refreshed, run: pinned.run, next: "Inspect apply dry-run, then obtain separate human confirmation for apply. Native apply refreshes again and refuses stale rows." };
  }
  const beforePlan = await triageRevision(root, pinned.run);
  const plan = await run(deps, root, triageCommand({ action: "apply", run: pinned.run, dryRun: true }));
  const revision = await triageRevision(root, pinned.run);
  if (beforePlan !== revision) throw new Error("Native triage state changed while preparing the apply plan. Nothing applied; review again.");
  const consent = await human(ctx, "Apply approved native triage decisions?", `Run: ${pinned.run}\nNative state digest: ${revision}\nOnly previously approved verdicts may apply. Native apply refreshes again and refuses stale rows; force is never used. Receipts include actual commands and reversals.\n\nRefresh:\n${JSON.stringify(refreshed, null, 2)}\n\nNative apply plan:\n${JSON.stringify(plan, null, 2)}`);
  if (!consent) return { kind: "camp_triage_cancelled", run: pinned.run, plan, verdictsApplied: false };
  if (revision !== await triageRevision(root, pinned.run)) throw new Error("Native triage state changed while the human reviewed the apply plan. Nothing applied; request a fresh review.");
  return { kind: "camp_triage_applied", humanConfirmed: true, native: await run(deps, root, args), run: pinned.run, next: "Run verify; its native exit status and verification artifacts are the proof, not this apply receipt." };
}

export function registerCampNativeTools(pi: PiLike, deps: ToolDeps): void {
  const z = pi.zod;
  pi.registerTool({
    name: "camp_workitem", label: "Camp Workitems",
    description: "Typed lightweight workitem/design entry, inventory, project/festival/worktree links, and native promotion. Create returns tracking metadata and the native next content/scaffold action, not a finished design. Promotions use camp workitem promote with readiness checks and no auto-commit. Workers can list and read links only; mutations require main authority. Terminal promotion asks the human.",
    parameters: z.object({ action: z.enum(["list", "create", "links", "link", "unlink", "promote"]), selector: z.string().optional().describe("Exact native stable id/ref/path; omit only for list or all links"), slug: z.string().optional(), title: z.string().optional(), type: z.string().optional(), projects: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), quest: z.string().optional(), query: z.string().optional(), stages: z.array(z.string()).optional(), attentionStages: z.array(z.string()).optional(), showParked: z.boolean().optional(), path: z.string().optional(), project: z.string().optional(), festival: z.string().optional(), worktree: z.string().optional(), role: z.enum(["primary", "related", "blocked_by", "supersedes"]).optional(), linkId: z.string().optional(), target: z.enum(["ready", "active", "festival", "doc", "completed", "archived", "someday"]).optional(), destination: z.string().optional(), goal: z.string().optional(), keep: z.boolean().optional(), dryRun: z.boolean().optional() }),
    async execute(_id: string, p: WorkitemRequest, _signal: unknown, _update: unknown, ctx: CampContext) {
      try {
        authority(ctx, !["list", "links"].includes(p.action)); const root = await rootOf(deps, ctx); const args = workitemCommand(root, p);
        if (p.action === "promote" && !p.dryRun && ["completed", "archived", "someday"].includes(p.target ?? "")) {
          const preview = await run(deps, root, workitemCommand(root, { ...p, dryRun: true }));
          if (!await human(ctx, "Promote workitem into its dungeon?", JSON.stringify({ command: ["camp", ...args], preview }, null, 2))) return output({ kind: "camp_workitem_cancelled" });
        }
        return output({ kind: "camp_workitem", native: await run(deps, root, args), campRoot: root });
      } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: "camp_intent", label: "Camp Intents",
    description: "Capture, inspect and promote lightweight native intents/ideas with body, tags and project concept. Uses native JSON and universal promotion; no editor, force or auto-commit. Native ids, destination paths and next actions are retained. Workers may list/show; main records mutations.",
    parameters: z.object({ action: z.enum(["list", "show", "create", "promote"]), selector: z.string().optional(), title: z.string().optional(), body: z.string().optional(), type: z.enum(["idea", "feature", "bug", "research", "chore"]).optional(), concept: z.string().optional(), tags: z.array(z.string()).optional(), status: z.string().optional(), project: z.string().optional(), target: z.enum(["ready", "festival", "design"]).optional(), dryRun: z.boolean().optional() }),
    async execute(_id: string, p: IntentRequest, _signal: unknown, _update: unknown, ctx: CampContext) {
      try { authority(ctx, !["list", "show"].includes(p.action)); const root = await rootOf(deps, ctx); return output({ kind: "camp_intent", native: await run(deps, root, intentCommand(p)), campRoot: root }); } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: "camp_quest", label: "Camp Quests",
    description: "Manage native quest contexts, checklist items and workitem/artifact links across projects/festivals. Checklist actions accept native quest/item ids and preserve native results. context returns shell activation instructions only: subprocesses cannot change the current terminal environment, so pass quest explicitly when creating workitems. Workers may list/show/status/context/checklist/links; main owns changes. No automatic commits.",
    parameters: z.object({ action: z.enum(["list", "show", "status", "context", "create", "update", "checklist", "links", "link", "unlink", "item_add", "item_edit", "item_done", "item_reopen", "item_rank", "item_link", "item_unlink"]), quest: z.string().optional(), item: z.string().optional(), name: z.string().optional(), title: z.string().optional(), purpose: z.string().optional(), description: z.string().optional(), notes: z.string().optional(), workitem: z.string().optional(), path: z.string().optional(), linkType: z.string().optional(), rank: z.number().optional(), status: z.enum(["open", "doing", "done", "dropped"]).optional(), openOnly: z.boolean().optional(), all: z.boolean().optional() }),
    async execute(_id: string, p: QuestRequest, _signal: unknown, _update: unknown, ctx: CampContext) {
      try {
        authority(ctx, !["list", "show", "status", "context", "checklist", "links"].includes(p.action)); const root = await rootOf(deps, ctx); const command = questCommand(root, p);
        const native = await run(deps, root, command.args, command.json);
        return output({ kind: "camp_quest", native, campRoot: root, ...(p.action === "context" ? { activated: false, next: "Run the returned shell code in your terminal to activate CAMP_QUEST; tool subprocesses cannot update that shell. Pass quest explicitly to camp_workitem create." } : {}) });
      } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: "camp_triage", label: "Camp Triage",
    description: "Complete native recorded triage: start/status/queue/template/evidence/propose/review/refresh/approve/apply/verify. Native snapshots, ids, vocabulary, stale refresh, receipts and verification remain authoritative. Evidence/proposals are advisory, never human verdicts. approve and non-dry-run apply ALWAYS open separate human confirmations with pinned native run/state. No force; changed state requires renewed review. Workers can only status/queue/template/apply dryRun. Files are existing JSON record/rationale paths; noEvidence honestly records no gathered evidence.",
    parameters: z.object({ action: z.enum(["start", "status", "queue", "template", "evidence", "propose", "review", "approve", "apply", "refresh", "verify"]), run: z.string().optional().describe("Exact native run id; otherwise latest is resolved and pinned before use"), scopes: z.array(z.string()).optional().describe("Native key:value filters, e.g. type:design or project:projects/camp"), profile: z.enum(["default", "sweep", "deep"]).optional(), full: z.boolean().optional(), role: z.enum(["evidence", "synthesis"]).optional(), stableId: z.string().optional(), file: z.string().optional().describe("Existing evidence/rationale JSON file; no stdin/editor"), noEvidence: z.boolean().optional(), disposition: z.string().optional(), summary: z.string().optional(), confidence: z.enum(["high", "medium", "low"]).optional(), ids: z.array(z.string()).optional(), lane: z.string().optional(), batch: z.number().optional(), amend: z.string().optional(), reject: z.boolean().optional(), note: z.string().optional(), dryRun: z.boolean().optional() }),
    async execute(_id: string, p: TriageRequest, _signal: unknown, _update: unknown, ctx: CampContext) {
      try { const root = await rootOf(deps, ctx); if (p.file !== undefined) nativeArgument(p.file, "file"); return output(await triage(deps, root, p, ctx)); } catch (error) { return failure(error); }
    },
  });
  pi.registerTool({
    name: "camp_workflow", label: "Camp Workflow Collections",
    description: "Inspect or create native workflow collections (not plugin .ompfest settings). Create registers native concepts/shortcuts and returns actual writes/paths; dryRun previews. Main owns creation, workers may list/show. Shortcut replacement is intentionally not exposed.",
    parameters: z.object({ action: z.enum(["list", "show", "create"]), type: z.string().optional(), shortcut: z.string().optional(), title: z.string().optional(), category: z.string().optional(), dryRun: z.boolean().optional() }),
    async execute(_id: string, p: { action: "list" | "show" | "create"; type?: string; shortcut?: string; title?: string; category?: string; dryRun?: boolean }, _signal: unknown, _update: unknown, ctx: CampContext) {
      try {
        authority(ctx, p.action === "create"); const root = await rootOf(deps, ctx); const args = ["workflow", p.action];
        if (p.action !== "list") args.push(nativeArgument(p.type, "type"));
        if (p.action === "create") { args.push("--shortcut", nativeArgument(p.shortcut, "shortcut")); if (p.title !== undefined) args.push("--title", p.title); if (p.category !== undefined) args.push("--category", p.category); if (p.dryRun) args.push("--dry-run"); }
        return output({ kind: "camp_workflow", native: await run(deps, root, [...args, "--json"]), campRoot: root });
      } catch (error) { return failure(error); }
    },
  });
}
