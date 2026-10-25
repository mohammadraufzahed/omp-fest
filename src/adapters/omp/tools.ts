/**
 * Model-callable fest_* / camp_* tools. Each is a thin mapping from a zod
 * schema to a port call — the agent gets typed results, never raw prose.
 *
 * The wiring is intentionally table-driven: TOOL_SPECS describes the tools
 * once, registerTools() adapts them onto whatever ExtensionAPI shape the
 * runtime hands us (kept loose-typed here so the module compiles without the
 * coding-agent package installed).
 */
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstat, readFile, writeFile } from "node:fs/promises";
import type { CampCli, CampDetect, ExecRunner, FestCli } from "../../ports.js";
import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { festivalOwner, festivalOwnerIsDead, releaseFestivalOwnership } from "../../application/festival-ownership.js";
import { createFestivalWorktrees, mergeFestivalWorktrees, readFestivalWorktrees } from "../../application/festival-worktrees.js";
import { listProjectReservations } from "../../application/project-conflicts.js";
import { summarizeProgress } from "../../domain/progress.js";
import { LoopTracker } from "../../application/loop-tracker.js";
import { FESTIVAL_CLAIM_ENTRY } from "../../application/session-claim.js";
import { sessionIdOf } from "../../application/session-id.js";
import { resolveWorkingDir, stampWorkingDir } from "../../application/sequence-goals.js";
import { campRules, campRulesCount, CAMP_RULES_FILE, CAMP_RULES_SKELETON, festivalConstraints, seedFestivalRules, stampGateRules, syncCampRules } from "../../application/festival-rules.js";
import { writeAtomically } from "../../application/fs-atomic.js";
import { inspectTaskVisualEvidence, recordVisualEvidence, visualEvidenceStatus, type VisualEvidence } from "../../application/visual-evidence.js";
import { applyReferenceRevision, findReuseCandidates, inspectReferenceRevision, renderPlanPreview } from "../../application/visual-plan-review.js";
import { installVisualReferences, prepareVisualReferences, referencesForTask, taskChecks, validateVisualReferences } from "../../application/visual-references.js";
import { createWireframe, WireframeInputError, type WireframeSpec } from "../../application/visual-wireframe.js";
import { structuredPlanSchema, type StructuredPlan } from "../../application/structured-plan.js";
import { normalizePlanInput } from "../../application/plan-input.js";
import { abandonPlanPreview, approvedPlan, listPlanPreviews, markPlanApproved, markPlanScaffolded, previewPlan, type ApprovedPlan } from "../../application/plan-artifacts.js";
import { finalizeApprovedScaffold, materializePlanWorkflows } from "../../application/plan-scaffold.js";
import { createPlanDraft, deletePlanDraft, deletePlanDraftsForPlan, readPlanDraft, updatePlanDraft, listPlanDrafts, type PlanDraftFields } from "../../application/plan-drafts.js";
import { findPlanningConflicts } from "../../application/planning-conflicts.js";
import { classifyAttachment, type AttachmentRole } from "../../domain/reference-classification.js";
import { DEFAULT_CONFIG, type Conventions, type NextUnit, type OmpFestConfig } from "../../domain/types.js";
import { loadConfig, saveConfig } from "../../domain/config.js";
import { checkCommitMessage, COMMIT_STYLE_DESC, conventionsEcho, festivalNameOk, parseConventionWords } from "../../application/conventions.js";
import { showCard, type OverlayUiLike } from "./overlay.js";
import { BROWSER_VERIFICATION_POLICY } from "../../domain/orientation.js";
import type { ZodLike } from "./zod-types.js";
import { Supervisor, SUPERVISOR_POLICY } from "../../application/supervisor.js";
import { registerFestivalTeamTools } from "./team-tools.js";
import { beginFestivalCreation, classifyCreationOrphan, clearCreationJournal, completeFestivalCreation, creationJournalMayBeLive, festivalCreationIsScaffolded, festivalTargetMatchesName, listFestivalCreationOrphans, listQuarantinedFestivals, recordFestivalCreation, restoreQuarantinedFestival, rollbackFestivalCreation } from "../../application/festival-creation.js";
import { readFestivalTeam, joinFestivalTeam } from "../../application/festival-team.js";
import { INTEGRATION_GUIDE, integrationReviewStatus } from "../../application/integration-review.js";
import { planningDiagnostic, PlanningValidationError } from "../../application/planning-errors.js";
import { registerFlowTools, type FlowHost } from "./flow-tools.js";
import { registerSupervisorTools } from "./supervisor-tools.js";
import { registerQualityTools } from "./quality-tools.js";
import { registerVerificationTools } from "./verification-tools.js";
import { registerCampNativeTools } from "./camp-native-tools.js";
import { registerFestNativeTools } from "./fest-native-tools.js";
import { verificationResultStatus } from "../../application/verification-results.js";
import { classifyNativeCommand } from "../../application/native-command-policy.js";
import { isCompletedFestivalPath, lifecycleStatus, festivalCampRoot } from "../../domain/festival-lifecycle.js";

export interface ToolDeps {
  fest: FestCli;
  camp: CampCli;
  detect: CampDetect;
  tracker: LoopTracker;
  exec?: ExecRunner;
  supervisor?: Supervisor;
  /** Per-project .ompfest.json — gate behavior honors pauseAtGates/evidenceRequiredOnGates. */
  config?: () => Promise<OmpFestConfig>;
  host?: Pick<FlowHost, "getAllTools" | "getActiveTools">;
}

export interface PiLike {
  zod: ZodLike;
  registerTool(tool: Record<string, unknown>): void;
  /** Persists a custom session entry — the claim survives resume/branch/tree. */
  appendEntry?(customType: string, data: unknown): void;
}
interface NativeJobSnapshot { running?: { id: string; type: string; status: string; label: string; agentId?: string }[]; recent?: { id: string; type: string; status: string; label: string; agentId?: string }[] }
interface ToolContextLike {
  cwd: string;
  sessionManager?: { getSessionId?(): string };
  agent?: { kind?: string };
  getAsyncJobSnapshot?(): NativeJobSnapshot | null;
  ui?: OverlayUiLike & {
    notify?(message: string, type?: string): void;
    select?(title: string, options: (string | { label: string; description?: string })[], opts?: Record<string, unknown>): Promise<string | undefined>;
    confirm?(title: string, message: string, opts?: Record<string, unknown>): Promise<boolean>;
    input?(title: string, placeholder?: string, opts?: Record<string, unknown>): Promise<string | undefined>;
  };
}

interface ToolResult {
  content: { type: string; text: string }[];
}

interface ScaffoldPlanResult {
  ok?: boolean;
  error?: string;
  festival_dir?: string;
  phases_created?: number;
  sequences_created?: number;
  tasks_created?: number;
  dry_run?: boolean;
}

function parseScaffoldPlanResult(output: string): ScaffoldPlanResult | undefined {
  try {
    return JSON.parse(output) as ScaffoldPlanResult;
  } catch {
    return undefined;
  }
}

function textResult(payload: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
}
function supervisorOnly(ctx: ToolContextLike, operation: string): ToolResult | undefined {
  return ctx.agent?.kind === "sub"
    ? textResult({ kind: "supervisor_authority_required", operation, hint: "Native task workers return evidence and blockers to the main supervisor; only the main agent changes festival state, plans, approvals, or commits." })
    : undefined;
}

function compactBlockedUnit(unit: Extract<NextUnit, { kind: "blocked" }>): ToolResult {
  const issues = unit.errors.slice(0, 12).map((issue) => ({
    file: issue.file,
    markers: issue.markers.slice(0, 6),
    ...(issue.error ? { error: issue.error } : {}),
  }));
  return textResult({
    kind: "blocked",
    issueCount: unit.errors.length,
    issues,
    ...(unit.errors.length > issues.length ? { truncated: unit.errors.length - issues.length } : {}),
    hint: "Fix the listed files only, then call fest_next again. Use fest_markers for marker details; do not paste raw validation output into the plan.",
  });
}
function planFailure(error: unknown, extra: Record<string, unknown> = {}): ToolResult {
  const diagnostic = planningDiagnostic(error, typeof extra.field === "string" ? extra.field : undefined);
  return textResult({
    kind: "plan_failed",
    code: diagnostic.code,
    ...(diagnostic.field ? { field: diagnostic.field } : {}),
    ...(diagnostic.expected ? { expected: diagnostic.expected } : {}),
    received: diagnostic.received ?? diagnostic.message,
    error: diagnostic.message,
    diagnostics: error instanceof PlanningValidationError ? error.diagnostics : [diagnostic],
    nextAction: diagnostic.nextAction,
    ...extra,
  });
}



async function interactivePlanReview(
  ctx: ToolContextLike,
  payload: Record<string, unknown>,
  approval: { root: string; plan: string; name: string; references: { path: string; content: string }[] },
): Promise<ToolResult> {
  const ui = ctx.ui;
  if (!ui || typeof ui.confirm !== "function") {
    return textResult({
      ...payload,
      approval: "awaiting_human",
      nextSteps: "Present this proposal to the human and wait for approval. Paths shown are anchored to the camp root: workingDir is the selected project; inspection, task files, and verification paths are relative to that project. Then call action:'scaffold' with approvedRevision; do not supply spec.",
    });
  }
  const preview = typeof payload.preview === "string" ? payload.preview : JSON.stringify(payload.preview, null, 2);
  const lines = [
    "Review the proposed festival before any implementation begins.",
    "",
    ...preview.split("\n"),
    "",
    `Plan revision: ${typeof payload.planRevision === "string" ? payload.planRevision : "unknown"}`,
    `Tasks: ${String((payload.counts as { tasks?: number } | undefined)?.tasks ?? "unknown")}`,
    "",
    "Path check: workingDir resolves from the camp root and must be inside the camp or reachable via projects/<link>. Inspection, task-file, verification cwd, and evidence paths resolve from that project. The generated festival stores workingDir as a camp-relative path.",
  ];
  const floated = await showCard(ui, {
    title: "✦ Plan proposal review",
    lines,
    footer: "esc/q close — then choose approve or request revision",
  });
  const approved = await ui.confirm(
    "✦ Approve plan proposal",
    floated ? "Approve this proposal for scaffolding?" : lines.join("\n") + "\n\nApprove this proposal?",
  );
  if (approved) {
    const revision = typeof payload.planRevision === "string" ? payload.planRevision : "";
    if (!revision) return textResult({ ...payload, approval: "awaiting_human", error: "Missing planRevision; approval was not recorded." });
    await markPlanApproved(approval.root, approval.plan, approval.name, revision, approval.references);
    return textResult({ ...payload, approval: "approved", nextSteps: "Plan approved. Call action:'scaffold' with this planRevision and omit spec. Keep workingDir and all project-relative paths exactly as approved." });
  }
  const revision = typeof payload.planRevision === "string" ? payload.planRevision : "";
  if (revision) await abandonPlanPreview(approval.root, approval.plan, approval.name, revision, "rejected");
  const reason = typeof ui.input === "function"
    ? (await ui.input("Request plan revision", "What should change?")) ?? "no reason given"
    : "no reason given";
  return textResult({
    ...payload,
    approval: "revision_requested",
    reason: reason.trim() || "no reason given",
    nextSteps: "Revise the proposal and call fest_plan action:'preview' again. Do not scaffold this revision.",
  });
}

interface FestDirResolution {
  dir?: string;
  campRoot?: string;
  error?: unknown;
}

/**
 * Resolve which festival a tool call targets. A selector matches the full id
 * exactly, then by substring — but an ambiguous or unknown selector errors
 * instead of silently targeting the wrong festival.
 */
async function festivalDirOf(
  deps: ToolDeps,
  ctx: ToolContextLike,
  selector?: string,
): Promise<FestDirResolution> {
  const location = await deps.detect.locate(ctx.cwd);
  if (selector) {
    if (!location.campRoot) {
      return { error: { kind: "no_camp", selector, hint: "Not inside a camp — cannot resolve a festival by name." } };
    }
    const all = await deps.detect.listFestivals(location.campRoot);
    const match = matchFestival(all, selector);
    if (match.kind === "match") {
      return { dir: match.festival.path, campRoot: location.campRoot };
    }
    if (match.kind === "ambiguous") {
      return {
        error: {
          kind: "ambiguous_festival",
          selector,
          matches: match.matches.map((f) => `${f.id} (${f.status})`),
          hint: "Pass the full festival id to disambiguate.",
        },
      };
    }
    return {
      error: {
        kind: "unknown_festival",
        selector,
        festivals: match.festivals.map((f) => `${f.id} (${f.status})`),
        hint: "Pick one of the listed festival ids.",
      },
    };
  }
  // New sessions are intentionally unselected. The active festival is only a
  // candidate shown by idleResult; it must never be claimed implicitly.
  const dir = location.campRoot
    ? await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), location.campRoot)
    : undefined;
  return { dir, campRoot: location.campRoot };
}

/** Persist a fresh claim into the session transcript so resume/branch/tree restore it. */
function persistClaim(pi: PiLike, dir: string, campRoot: string | undefined): void {
  pi.appendEntry?.(FESTIVAL_CLAIM_ENTRY, {
    festivalId: basename(dir),
    festivalDir: dir,
    ...(campRoot ? { campRoot } : {}),
  });
}

/** Unwrap a FestDirResolution into either a ToolResult to return or the dir. */
async function dirOrResult(
  pi: PiLike,
  deps: ToolDeps,
  ctx: ToolContextLike,
  selector?: string,
): Promise<{ dir: string; coordinator: boolean } | { result: ToolResult }> {
  const resolved = await festivalDirOf(deps, ctx, selector);
  if (resolved.error) {
    return { result: textResult(resolved.error) };
  }
  if (!resolved.dir) {
    return { result: await idleResult(deps, ctx) };
  }
  if (resolved.campRoot) {
    const festivalDir = resolved.dir;
    const pending = (await listFestivalCreationOrphans(resolved.campRoot)).find((item) => item.receipt.name === basename(festivalDir) || item.festivalDir === festivalDir);
    if (pending) return { result: textResult({ kind: "creation_in_progress", festival: basename(resolved.dir), transaction: pending.receipt.id, nextAction: "Review and resolve this scaffold through /fest orphans before selecting or working on it." }) };
  }
  const sid = sessionIdOf(ctx);
  const owner = await festivalOwner(resolved.dir);
  if (!owner) {
    return { result: textResult({ kind: "festival_unselected", festival: basename(resolved.dir), hint: `Use /fest select ${basename(resolved.dir)} to explicitly claim coordinator ownership; /fest join requires an existing coordinator.` }) };
  }
  if (owner.sessionId !== sid) {
    const team = resolved.campRoot ? await readFestivalTeam(resolved.campRoot, resolved.dir) : undefined;
    if (!team?.participants.some((participant) => participant.sessionId === sid)) {
      const hint = festivalOwnerIsDead(owner)
        ? `The recorded owner ${owner.sessionId} is gone (process exited). /fest select ${basename(resolved.dir)} transfers ownership immediately — no confirmation needed.`
        : `Use /fest join ${basename(resolved.dir)} to collaborate without transferring coordinator ownership.`;
      return { result: textResult({ kind: "festival_owned", festival: basename(resolved.dir), owner: owner.sessionId, ownerDead: festivalOwnerIsDead(owner) || undefined, hint }) };
    }
  } else if (resolved.campRoot) {
    await joinFestivalTeam(resolved.campRoot, resolved.dir, sid, sid);
  }
  if (deps.tracker.claimFestival(sid, resolved.dir)) persistClaim(pi, resolved.dir, resolved.campRoot);
  return { dir: resolved.dir, coordinator: owner.sessionId === sid };
}
async function coordinatorRequired(dir: string, sessionId: string): Promise<ToolResult | undefined> {
  const owner = await festivalOwner(dir);
  return owner?.sessionId === sessionId
    ? undefined
    : textResult({ kind: "coordinator_required", festival: basename(dir), coordinator: owner?.sessionId, hint: "Joined sessions may implement and submit claimed tasks. Only the coordinator integrates, changes task state, completes tasks, advances gates, promotes, or commits." });
}


/** Approved active festivals execute only in their declared, validated project worktrees. */
async function maybeCreateFestivalWorktrees(deps: ToolDeps, campRoot: string, festivalDir: string, festivalName: string) {
  if (!deps.exec || lifecycleStatus(festivalDir) !== "active") return [];
  if (!(await lstat(join(festivalDir, "APPROVED_PLAN.json")).catch(() => undefined))) return [];
  try {
    const conventions = (await loadConfig(campRoot)).conventions;
    return await createFestivalWorktrees(deps.exec, campRoot, festivalDir, festivalName, await deps.camp.projects(campRoot), conventions);
  } catch (error) {
    return { error: String(error) };
  }
}

async function campRootOf(deps: ToolDeps, ctx: ToolContextLike): Promise<string | undefined> {
  const location = await deps.detect.locate(ctx.cwd);
  return location.campRoot;
}

async function idleResult(deps: ToolDeps, ctx: ToolContextLike) {
  const location = await deps.detect.locate(ctx.cwd);
  const festivals = location.campRoot ? await deps.detect.listFestivals(location.campRoot) : [];
  return textResult({
    kind: "idle",
    reason: "not inside a camp festival",
    ...(location.campRoot ? { campRoot: location.campRoot } : {}),
    festivals: festivals.map((f) => ({ id: f.id, status: f.status, path: f.path })),
    hint: festivals.length > 0
      ? "This session is explicitly unselected. Use /fest select <id> to coordinate or /fest join <id> to collaborate without transferring ownership. Explicit festival:<id> operations do not join or transfer a session. For brand-new work, use /fest idea → /fest plan. Never run `fest`/`camp` via shell — use the fest_*/camp_* tools."
      : "No festival exists in this camp yet — brand-new work starts with the planning flow (/fest idea → /fest plan <goal>). Never run `fest`/`camp` via shell — use the fest_*/camp_* tools.",
  });
}

function festivalRelativeTaskPath(festivalDir: string, taskPath: string): string | undefined {
  const root = resolve(festivalDir);
  const target = resolve(root, taskPath);
  const normalized = relative(root, target);
  if (!normalized || normalized === ".." || normalized.startsWith(`..${sep}`) || isAbsolute(normalized)) {
    return undefined;
  }
  return normalized.split(sep).join("/");
}

export function registerTools(pi: PiLike, deps: ToolDeps): void {
  const z = pi.zod;
  const supervisor = deps.supervisor ?? new Supervisor();
  // A raw exception can never reach the model — every tool returns a
  // structured failure envelope so the next action is always recoverable.
  const raw = pi;
  const guarded: PiLike = {
    ...raw,
    registerTool(tool: Record<string, unknown>): void {
      if (typeof tool.execute === "function" && typeof tool.name === "string") {
        const execute = tool.execute as (...args: unknown[]) => Promise<unknown>;
        const name = tool.name;
        tool.execute = async (...args: unknown[]) => {
          try {
            return await execute(...args);
          } catch (error) {
            return textResult({
              kind: `${name}_failed`, code: "UNHANDLED_ERROR", error: String(error),
              nextAction: "Inspect the error output; retry the tool with corrected input or resolve the underlying state it reports.",
            });
          }
        };
      }
      raw.registerTool(tool);
    },
  };
  pi = guarded;
  registerSupervisorTools(pi, deps, supervisor, { isMainSession: (ctx) => ctx.agent?.kind !== "sub" });
  registerQualityTools(pi, { ...deps, supervisor });
  registerFestivalTeamTools(pi, deps, supervisor);


  pi.registerTool({
    name: "fest_next",
    label: "Fest Next",
    description:
      "Get the next unit of work in the current festival (task, workflow step, gate step, blocked, or complete), including linked visual reference notes and wireframe paths for page tasks. This is the engine of the festival loop — call it, do what it returns, then call it again.",
    parameters: z.object({ festival: z.string().optional().describe("Festival name/id override") }),
    async execute(_id: string, params: { festival?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const blocked = supervisorOnly(ctx, "task selection");
      if (blocked) return blocked;
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      if (!r.coordinator) return textResult({ kind: "team_assignment_required", festival: basename(r.dir), nextAction: "Use fest_team action queue, then claim one exact eligible task. Do not start an unclaimed task from fest_next." });
      const dir = r.dir;
      const campRoot = festivalCampRoot(dir);
      if (campRoot) {
        const binding = await maybeCreateFestivalWorktrees(deps, campRoot, dir, basename(dir));
        if (!Array.isArray(binding)) return textResult({ kind: "execution_blocked", code: "WORKTREE_BINDING_FAILED", error: binding.error, hint: "Repair project/worktree identity and retry; execution must not fall back to the original checkout." });
      }
      const unit: NextUnit = await deps.fest.next(dir);
      if (unit.kind === "task") {
        const visual = await validateVisualReferences(dir, deps.detect);
        if (visual.issues.length > 0) {
          return textResult({ kind: "blocked", errors: visual.issues, hint: "Fix the visual references and task links, then call fest_next again." });
        }
        const visualReferences = await referencesForTask(dir, unit.doc);
        const checks = taskChecks(unit.doc);
        const completionRequirements = {
          plannedChecks: await verificationResultStatus(dir, /^Task ID:[ \t]*(.+)$/m.exec(unit.doc)?.[1]?.trim()),
          visualChecks: checks.map(({ page, id }) => ({
            page, check: id, description: visualReferences.find((reference) => reference.page === page)?.checks.find((check) => check.id === id)?.description,
            requiredFields: ["status", "proof"], verifiedFields: ["route", "viewport", "state"],
          })),
          ...(checks.length ? { visualEvidence: await inspectTaskVisualEvidence(dir, festivalRelativeTaskPath(dir, unit.path) ?? unit.path, unit.doc) } : {}),
          evidence: "Summarize the task's Done When checklist verification. Existing valid visual evidence is reused when visualEvidence is omitted; untested checks remain subject to human review.",
          prerequisites: ["No project reservation conflict", "Independent acceptance of submitted worker/team work", "Festival CLI quality gates"],
        };
        const sid = sessionIdOf(ctx);
        const stale = deps.tracker.unfinishedFor(sid) ? deps.tracker.openTaskPathFor(sid) : undefined;
        deps.tracker.taskOpened(sid, festivalRelativeTaskPath(dir, unit.path) ?? unit.path);
        if (stale) {
          return textResult({
            ...unit,
            browserVerification: BROWSER_VERIFICATION_POLICY,
            supervisor: SUPERVISOR_POLICY,
            completionRequirements,
            ...(visualReferences.length > 0 ? { visualReferences } : {}),
            warning: `Previous unit ${stale} was opened but never completed+committed — the work record is stale. Finish its fest_task_complete/fest_commit before starting this one.`,
          });
        }
        return textResult({
          ...unit,
          browserVerification: BROWSER_VERIFICATION_POLICY,
          supervisor: SUPERVISOR_POLICY,
          completionRequirements,
          ...(visualReferences.length > 0 ? { visualReferences } : {}),
        });
      }
      if (unit.kind === "complete" || unit.kind === "gate_step") {
        return textResult({ ...unit, integration: await integrationReviewStatus(dir, deps.detect), nextSteps: INTEGRATION_GUIDE });
      }
      return unit.kind === "blocked" ? compactBlockedUnit(unit) : textResult(unit);
    },
  });

  pi.registerTool({
    name: "fest_task_complete",
    label: "Complete Fest Task",
    description:
      "Mark a festival task completed after verifying its 'Done When' checklist. Always pass evidence summarizing what was verified.",
    parameters: z.object({
      task: z.string().optional().describe("Festival-relative task path; omit for the current task"),
      evidence: z.string().describe("What was verified: tests run, files changed, checks passed"),
      visualEvidence: z.array(z.object({
        page: z.string(), check: z.string(), status: z.enum(["verified", "failed", "untested"]),
        proof: z.string(), route: z.string().optional(), viewport: z.string().optional(), state: z.string().optional(),
      })).optional().describe("For each page acceptance check in this task, give a truthful status and evidence; verified requires route, viewport, state"),
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { task?: string; evidence: string; festival?: string; visualEvidence?: VisualEvidence[] }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const blocked = supervisorOnly(ctx, "task completion");
      if (blocked) return blocked;
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      if (!r.coordinator) return await coordinatorRequired(r.dir, sessionIdOf(ctx));
      const dir = r.dir;
      const sid = sessionIdOf(ctx);
      const opened = deps.tracker.openTaskPathFor(sid);
      const pausedTask = params.task ? festivalRelativeTaskPath(dir, params.task) : opened;
      const pausedReason = deps.tracker.pausedReasonFor(sid, pausedTask);
      if (pausedReason) return textResult({
        kind: "completion_blocked", task: pausedTask, blocker: pausedReason,
        reasonCode: "project_reservation_conflict", missingRequirements: [{ requirement: "project_reservation_clear", details: pausedReason }],
        nextAction: { tool: "fest_supervisor", action: "queue", instruction: "Wait for the conflicting reservation to clear before completing or committing this task." },
        hint: "This task is paused by a project reservation conflict. Do not mark it complete or commit; wait until the supervisor queue clears the reservation.",
      });
      const visual = await validateVisualReferences(dir, deps.detect);
      if (visual.issues.length) {
        return textResult({
          kind: "completion_blocked", issues: visual.issues, reasonCode: "visual_references_invalid",
          missingRequirements: visual.issues.map((details) => ({ requirement: "valid_visual_reference", details })),
          nextAction: { action: "repair_visual_references", instruction: "Repair the listed reference or task-link issues, then retry completion. Do not rerun unrelated checks." },
        });
      }
      const current = !params.task && !opened && visual.pages.length ? await deps.fest.next(dir) : undefined;
      const requestedTaskPath = params.task ?? opened ?? (current?.kind === "task" ? current.path : undefined);
      const taskPath = requestedTaskPath ? festivalRelativeTaskPath(dir, requestedTaskPath) : undefined;
      if (requestedTaskPath && !taskPath) {
        return textResult({ kind: "completion_blocked", task: requestedTaskPath, reasonCode: "invalid_task_path",
          missingRequirements: [{ requirement: "festival_relative_task_path" }],
          nextAction: { tool: "fest_next", instruction: "Use the exact task path returned for this festival." },
          hint: "Task path must resolve inside the selected festival." });
      }
      const task = taskPath
        ? (await deps.detect.pendingTasks(dir)).find((item) => festivalRelativeTaskPath(dir, item.path) === taskPath)
        : undefined;
      const completionPath = task?.path ?? taskPath;
      let taskDoc: string | undefined;
      if (completionPath) {
        taskDoc = await readFile(join(dir, completionPath), "utf8").catch(() => undefined);
      }
      if (visual.pages.length && !taskDoc) {
        return textResult({ kind: "completion_blocked", reasonCode: "task_document_missing",
          missingRequirements: [{ requirement: "readable_task_document", task: completionPath }],
          nextAction: { tool: "fest_next", instruction: "Use a valid task path returned for this festival so its visual checks can be inspected." },
          hint: "Use a valid task path returned by fest_next so its visual checks can be verified." });
      }
      const logicalTask = taskDoc ? /^Task ID:[ \t]*(.+)$/m.exec(taskDoc)?.[1]?.trim() : undefined;
      if (taskDoc && completionPath) {
        const checks = taskChecks(taskDoc);
        if (checks.length > 0) {
          const verification = await inspectTaskVisualEvidence(dir, completionPath, taskDoc, params.visualEvidence);
          if (!verification.valid) {
            return textResult({
              kind: "completion_blocked", task: completionPath, reasonCode: "visual_evidence_required",
              error: verification.issues.join("\n"), missingRequirements: verification.missingRequirements,
              expectedChecks: verification.checks, freshness: verification.freshness,
              nextAction: {
                tool: "fest_task_complete", task: completionPath, field: "visualEvidence",
                checks: verification.missingRequirements,
                instruction: "Repair failed visual checks and provide truthful evidence covering exactly the task's expected checks. Verified checks need proof, route, viewport and state; unavailable checks may be marked untested for human review. Reuse existing nonvisual verification; missing visual evidence alone does not require rerunning tests.",
              },
              hint: "Provide evidence for each task acceptance check, or mark it untested for human review.",
            });
          }
          if (params.visualEvidence !== undefined) {
            try {
              await recordVisualEvidence(dir, completionPath, taskDoc, params.visualEvidence);
            } catch (error) {
              return textResult({ kind: "completion_blocked", reasonCode: "visual_evidence_record_failed", error: String(error),
                missingRequirements: [{ requirement: "persisted_visual_evidence", details: String(error) }],
                nextAction: { action: "repair_evidence_store", instruction: "Resolve the reported evidence-store problem and retry with the same evidence; do not rerun unrelated checks." },
                hint: "Visual evidence could not be recorded." });
            }
          }
        }
      }
      if (logicalTask) {
        const verification = await verificationResultStatus(dir, logicalTask);
        if (!verification.valid) return textResult({ kind: "completion_blocked", reasonCode: "verification_results_required", missingRequirements: verification.missingRequirements,
          nextAction: { tool: "fest_verification", action: "requirements", task: logicalTask, instruction: "Exercise declared checks, store actual output with fest_evidence, then record observed results. Planned provenance is not completion evidence." } });
      }
      const assignments = supervisor.state(sessionIdOf(ctx)).workers.filter((worker) =>
        worker.festival === basename(dir) && worker.task === (task?.path ?? taskPath));
      if (assignments.some((worker) => worker.status !== "accepted" && worker.status !== "failed")) {
        return textResult({ kind: "completion_blocked", reasonCode: "worker_acceptance_required",
          missingRequirements: assignments.filter((worker) => worker.status !== "accepted" && worker.status !== "failed").map((worker) => ({ requirement: "independent_worker_acceptance", assignmentId: worker.id, status: worker.status })),
          nextAction: { tool: "fest_supervisor", action: "status", instruction: "Inspect pending workers, obtain independent review and accept each submitted worker before completing this task." },
          hint: "Worker submission requires independent supervisor review and acceptance before festival completion." });
      }
      const campRoot = await campRootOf(deps, ctx);
      const team = campRoot ? await readFestivalTeam(campRoot, dir) : undefined;
      if (team?.assignments.some((assignment) =>
        assignment.task === (task?.path ?? taskPath) && (assignment.status === "claimed" || assignment.status === "submitted"))) {
        return textResult({ kind: "completion_blocked", reasonCode: "team_assignment_unresolved",
          missingRequirements: [{ requirement: "team_assignment_review_or_release", task: completionPath }],
          nextAction: { tool: "fest_team", action: "status", instruction: "Inspect this task's assignment and independently review and accept submitted work, or release the claim, before completing it." },
          hint: "A joined session still owns or has submitted this task. Review or release its shared team assignment before completing it." });
      }
      const completion = await deps.fest.taskComplete(dir, task?.path ?? taskPath ?? "", params.evidence);
      if (!completion.ok) {
        return textResult({
          status: "completion_blocked",
          kind: "completion_blocked", reasonCode: "festival_quality_gate_failed",
          missingRequirements: [{ requirement: "festival_quality_gate", details: completion.output }],
          nextAction: { action: "resolve_quality_gate", instruction: "Resolve only the requirements reported in output before retrying completion.", output: completion.output },
          task: task?.path ?? taskPath ?? params.task,
          output: completion.output,
          hint: "fest refused the completion — quality gates run first. Read the output, fix what it demands, then retry.",
        });
      }
      deps.tracker.taskCompleted(sid);
      return textResult({
        status: "completed",
        task: task?.path ?? taskPath ?? params.task,
        ...(opened
          ? {}
          : {
              warning:
                "No unit was opened via fest_next this session — the festival only tracks work the loop hands out. Call fest_next before implementing next time.",
            }),
      });
    },
  });

  pi.registerTool({
    name: "fest_task_update",
    label: "Update Fest Task State",
    description: "Update task progress or state. Provide a reason for blocked/defer, a percentage for update, and an optional executor note for unblock.",
    parameters: z.object({
      action: z.enum(["blocked", "defer", "unblock", "reset", "update"]),
      task: z.string().optional(),
      reason: z.string().optional().describe("Reason for blocked/defer; on unblock, becomes the note to the executor."),
      percent: z.string().optional().describe("Required for update: progress percentage below 100."),
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { action: "blocked" | "defer" | "unblock" | "reset" | "update"; task?: string; reason?: string; percent?: string; festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const blocked = supervisorOnly(ctx, "task state update");
      if (blocked) return blocked;
      const unsupportedField = params.reason?.trim() && !["blocked", "defer", "unblock"].includes(params.action) ? "reason"
        : params.percent?.trim() && params.action !== "update" ? "percent"
          : undefined;
      const requiredField = params.action === "update" && !params.percent?.trim() ? "percent"
        : (params.action === "blocked" || params.action === "defer") && !params.reason?.trim() ? "reason"
          : undefined;
      const field = unsupportedField ?? requiredField;
      if (field) return textResult({
        kind: "task_update_invalid", action: params.action, field,
        error: unsupportedField
          ? `Action "${params.action}" does not accept ${field}. No festival state was changed.`
          : `Action "${params.action}" requires ${field}. No festival state was changed.`,
      });
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      if (!r.coordinator) return await coordinatorRequired(r.dir, sessionIdOf(ctx));
      await deps.fest.taskMutate(r.dir, params.action, params);
      return textResult({ status: "ok", action: params.action });
    },
  });

  pi.registerTool({
    name: "fest_commit",
    label: "Fest Commit",
    description:
      "Commit changes through fest (auto-tags the message with [camp:festival]). Use instead of git commit inside linked projects so the work record stays truthful. A task commit is not the end of the festival: immediately call fest_next and continue until kind 'complete', pausing only for human gates or real blockers.",
    parameters: z.object({
      message: z.string().describe("Commit message (task reference is added automatically)"),
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { message: string; festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const blocked = supervisorOnly(ctx, "commit");
      if (blocked) return blocked;
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      if (!r.coordinator) return await coordinatorRequired(r.dir, sessionIdOf(ctx));
      const campRoot = await campRootOf(deps, ctx);
      const team = campRoot ? await readFestivalTeam(campRoot, r.dir) : undefined;
      if (team?.assignments.some((assignment) => assignment.status !== "accepted")) {
        return textResult({ kind: "commit_blocked", hint: "Other omp sessions still own claimed or submitted work. Review or release every shared team assignment before committing." });
      }
      if (supervisor.state(sessionIdOf(ctx)).workers.some((worker) => worker.status !== "accepted" && worker.status !== "failed")) {
        return textResult({ kind: "commit_blocked", hint: "Outstanding workers may have unfinished shared-checkout changes. Review and settle all assignments before committing." });
      }
      const conventions = campRoot ? (await loadConfig(campRoot)).conventions : DEFAULT_CONFIG.conventions;
      const checked = checkCommitMessage(conventions, params.message, {
        camp: campRoot ? basename(campRoot) : "camp",
        festival: basename(r.dir),
      });
      if (!checked.ok) {
        return textResult({ kind: "commit_blocked", code: "COMMIT_STYLE", retryable: true, error: checked.error, hint: `Camp convention: ${COMMIT_STYLE_DESC} — set via /fest conventions or .ompfest.json conventions.commitStyle.` });
      }
      const hash = await deps.fest.commit(r.dir, checked.message);
      deps.tracker.committed(sessionIdOf(ctx));
      return textResult({ status: "committed", hash });
    },
  });

  pi.registerTool({
    name: "fest_validate",
    label: "Validate Festival",
    description: "Validate festival structure and visual references; returns the CLI /100 score plus visual-reference issues to fix. kind:validation_failed means reference checks failed regardless of the CLI score.",
    parameters: z.object({
      fix: z.boolean().optional().describe("Auto-fix common structure issues"),
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { fix?: boolean; festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      if (params.fix) {
        const blocked = supervisorOnly(ctx, "festival repair");
        if (blocked) return blocked;
      }
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      if (params.fix && !r.coordinator) return await coordinatorRequired(r.dir, sessionIdOf(ctx));
      const structure = await deps.fest.validate(r.dir, params.fix);
      const visual = await validateVisualReferences(r.dir, deps.detect);
      const verification = visual.issues.length ? undefined : await visualEvidenceStatus(r.dir, deps.detect);
      return textResult({ ...structure, visualReferences: visual, ...(verification ? { visualVerification: verification } : {}),
        ...(structure.valid === false || visual.issues.length > 0 || (verification?.issues.length ?? 0) > 0 ? { kind: "validation_failed" } : {}) });
    },
  });

  pi.registerTool({
    name: "fest_workflow",
    label: "Fest Workflow Step",
    description:
      "Advance or inspect a WORKFLOW.md phase: status shows the step list, advance marks the current step done. For gates, submit with 'submit' then STOP — never approve on your own.",
    parameters: z.object({
      action: z.enum(["status", "show", "advance"]),
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { action: "status" | "show" | "advance"; festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      if (params.action === "advance") {
        const blocked = supervisorOnly(ctx, "workflow advancement");
        if (blocked) return blocked;
      }
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      if (params.action === "advance" && !r.coordinator) return await coordinatorRequired(r.dir, sessionIdOf(ctx));
      const output =
        params.action === "advance"
          ? await deps.fest.workflowAdvance(r.dir)
          : await deps.fest.workflowStatus(r.dir);
      return textResult(output);
    },
  });

  pi.registerTool({
    name: "fest_gate_submit",
    label: "Submit Fest Gate",
    description:
      "Submit a gate/checkpoint for human review. In the TUI it OPENS AN APPROVAL DIALOG — the " +
      "human sees your evidence plus the festival's recorded constraints and picks approve/reject " +
      "inside the same call; a reject prompts for the reason and runs the real attestation. " +
      "Headless hosts (or pauseAtGates=false) get status:awaiting_human instead — STOP and wait " +
      "for /fest approve|reject. The model can never approve itself.",
    parameters: z.object({
      evidence: z.string().describe("Validate score, tasks done, test results, files changed — cite a check per recorded constraint"),
      visualEvidence: z.array(z.object({
        task: z.string(), page: z.string(), check: z.string(), status: z.enum(["verified", "failed", "untested"]),
        proof: z.string(), route: z.string().optional(), viewport: z.string().optional(), state: z.string().optional(),
      })).optional().describe("Reverify changed page checks for completed tasks. Never claim untested checks as verified."),
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { evidence: string; festival?: string; visualEvidence?: (VisualEvidence & { task: string })[] }, signal: { aborted?: boolean } | undefined, _u: unknown, ctx: ToolContextLike) {
      const blocked = supervisorOnly(ctx, "gate submission");
      if (blocked) return blocked;
      const config = deps.config ? await deps.config() : DEFAULT_CONFIG;
      if (config.evidenceRequiredOnGates && params.evidence.trim().length === 0) {
        return textResult({
          kind: "gate_evidence_required",
          hint: "This camp requires evidence on gates (evidenceRequiredOnGates). Re-call with evidence: validate score, tasks done, tests run, files changed — one line per recorded constraint.",
        });
      }
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      if (!r.coordinator) return await coordinatorRequired(r.dir, sessionIdOf(ctx));
      const dir = r.dir;
      const visual = await validateVisualReferences(dir, deps.detect);
      if (visual.issues.length > 0) {
        return textResult({ kind: "gate_blocked", issues: visual.issues, hint: "Repair visual references before submitting this gate." });
      }
      if (params.visualEvidence?.length) {
        const completed = (await deps.detect.pendingTasks(dir)).filter((task) => task.done);
        for (const taskPath of new Set(params.visualEvidence.map((entry) => entry.task))) {
          const task = completed.find((item) => item.path === taskPath);
          if (!task) {
            return textResult({ kind: "gate_blocked", issues: [`Not a completed task: ${taskPath}`] });
          }
          const doc = await readFile(join(dir, task.path), "utf8");
          try {
            await recordVisualEvidence(dir, task.path, doc, params.visualEvidence.filter((entry) => entry.task === task.path));
          } catch (error) {
            return textResult({ kind: "gate_blocked", issues: [String(error)] });
          }
        }
      }
      const verification = await visualEvidenceStatus(dir, deps.detect);
      if (verification.issues.length) {
        return textResult({ kind: "gate_blocked", issues: verification.issues, hint: "Reverify changed or missing checks before submitting this gate." });
      }
      const integration = await integrationReviewStatus(dir, deps.detect);
      if (integration.status === "failed" || integration.status === "stale") {
        return textResult({ kind: "gate_blocked", integration, hint: INTEGRATION_GUIDE });
      }
      const constraints = await festivalConstraints(dir);
      const ui = ctx.ui;
      if (!config.pauseAtGates || ui === undefined || typeof ui.confirm !== "function") {
        await deps.fest.workflowAdvance(dir);
        return textResult({
          status: "awaiting_human",
          evidence: params.evidence,
          ...(constraints ? { rulesEvidence: constraints } : {}),
          visualVerification: verification,
          instruction: "Present this evidence, including untested checks, to the user and wait. Do not approve the checkpoint yourself.",
        });
      }

      // Mark the checkpoint pending before asking — `fest workflow approve`
      // attests a submitted gate, and pending is what the digest/watch reads.
      await deps.fest.workflowAdvance(dir);
      // Evidence first: floating card when the host supports overlays, else
      // fold it into the confirm prompt itself.
      const lines = [
        `Festival: ${basename(dir)}`,
        "",
        "Evidence:",
        ...params.evidence.split("\n"),
        ...(verification.verified.length || verification.untested.length ? ["", "Visual checks (human must review evidence):",
          ...verification.verified.map((entry) => `VERIFIED ${entry.page}/${entry.check} at ${entry.route} (${entry.viewport}, ${entry.state}): ${entry.proof}`),
          ...verification.untested.map((entry) => `UNTESTED ${entry.page}/${entry.check}: ${entry.proof}`)] : []),
        ...(constraints ? ["", "Constraints agreed at plan time (a violated rule fails the gate):", ...constraints.split("\n")] : []),
      ];
      const floated = await showCard(ui, {
        title: "⛔ Gate review",
        lines,
        footer: "esc/q to close — then answer approve or reject",
      });
      const approved = await ui.confirm(
        "⛔ Gate review",
        floated
          ? `Approve this gate for ${basename(dir)}?`
          : `${lines.join("\n")}\n\nApprove this gate?`,
      );
      if (signal?.aborted === true) {
        return textResult({ status: "cancelled", hint: "Gate dialog aborted — the gate stays pending." });
      }
      if (approved) {
        const currentReferences = await validateVisualReferences(dir, deps.detect);
        const currentEvidence = currentReferences.issues.length ? undefined : await visualEvidenceStatus(dir, deps.detect);
        const currentIntegration = await integrationReviewStatus(dir, deps.detect);
        if (currentReferences.issues.length || currentEvidence?.issues.length || JSON.stringify(currentEvidence) !== JSON.stringify(verification) ||
            JSON.stringify(currentIntegration) !== JSON.stringify(integration) || currentIntegration.status === "failed" || currentIntegration.status === "stale") {
          return textResult({ kind: "gate_blocked", issues: [...currentReferences.issues, ...(currentEvidence?.issues ?? [])],
            integration: currentIntegration, hint: "References, evidence, or integration review changed during review; verify them again." });
        }
        const output = await deps.fest.workflowApprove(dir);
        return textResult({ status: "approved", output });
      }
      const reason =
        typeof ui.input === "function"
          ? (await ui.input("Reject gate", "Why is this gate rejected?")) ?? "no reason given"
          : "no reason given";
      const abortedNow = Boolean(signal?.aborted);
      if (abortedNow) {
        return textResult({ status: "cancelled", hint: "Gate dialog aborted — the gate stays pending." });
      }
      const output = await deps.fest.workflowReject(dir, reason.trim() || "no reason given");
      return textResult({ kind: "gate_rejected", code: "GATE_REJECTED", retryable: true, status: "rejected", reason, feedback: reason, output, nextAction: "Address the rejection feedback, update evidence, then resubmit fest_gate_submit." });
    },
  });


  pi.registerTool({
    name: "fest_plan",
    label: "Fest Plan (Scaffold From Plan)",
    description:
      "Stateful native planning with revision-bound human approval. Choose proportionate work: small work belongs in camp_workitem, repeated steps in fest_workflow_native, uncertain work in planning/research workflows, and requirements-ready implementation in structured task phases. Create/update persists a complete spec with native phase types, optional workflow/freeform/hybrid structure, cohesive sequences, task dependencies and verification kinds command/browser/manual/research. Command provenancePath substantiates a proposed command; actual output is recorded separately with fest_evidence and fest_verification. Draft diagnostics identify exact invalid fields before preview. Relative workingDir/plan/referencesDir resolve from camp root; task file/provenance/cwd paths resolve from workingDir. Template marker values are supplied explicitly. Preview then obtain human approval; scaffold consumes only that persisted revision and canonical paths. Native Festival owns hierarchy, state, dependencies and quality gates; do not hand-edit generated STRUCTURE.md or invent verification results.",
    parameters: z.object({
      action: z.enum(["create", "read", "update", "delete", "list", "preview", "scaffold", "cancel"]).optional(),
      name: z.string().optional(), plan: z.string().optional(), draftId: z.string().optional(), draftRevision: z.string().optional(),
      goal: z.string().optional(), scope: z.array(z.string()).optional(), exclusions: z.array(z.string()).optional(),
      acceptance: z.array(z.string()).optional(), inspection: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
      workingDir: z.string().optional(), files: z.array(z.string()).optional(), rules: z.string().optional(),
      templateMarkers: z.array(z.object({ hint: z.string(), value: z.string() })).optional(),
      verification: z.object({ id: z.string().optional(), kind: z.enum(["command", "browser", "manual", "research"]).optional(), command: z.string().optional(), cwd: z.string().optional(), provenancePath: z.string().optional(), procedure: z.string().optional(), expected: z.string().optional() }).optional(),
      attachments: z.array(z.object({ name: z.string(), description: z.string(), role: z.enum(["ui_design", "error_screenshot", "document_pdf", "context", "unknown"]).optional() })).optional(),
      spec: structuredPlanSchema(z).optional(), approvedRevision: z.string().optional(), referencesDir: z.string().optional(),
      visualIntent: z.enum(["ui_visual", "document_or_pdf", "backend_or_api", "bug_diagnostic", "mixed", "unknown"]).optional(),
      referenceAction: z.enum(["preview", "revise"]).optional(), festival: z.string().optional(),
      baseRevision: z.string().optional(), proposalRevision: z.string().optional(),
      conflictChoice: z.enum(["sequence", "narrow", "worktree"]).optional().describe("Human-selected resolution after returning planning_conflict options and asking conversationally; never open a blocking selection modal"),
    }),
    async execute(_id: string, params: { action?: "create" | "read" | "update" | "delete" | "list" | "preview" | "scaffold" | "cancel"; name?: string; plan?: string; draftId?: string; draftRevision?: string; goal?: string; scope?: string[]; exclusions?: string[]; acceptance?: string[]; inspection?: { path: string; reason: string }[]; workingDir?: string; files?: string[]; rules?: string; templateMarkers?: { hint: string; value: string }[]; verification?: PlanDraftFields["verification"]; attachments?: { name: string; description: string; role?: AttachmentRole }[]; spec?: StructuredPlan; approvedRevision?: string; referencesDir?: string; visualIntent?: PlanDraftFields["visualIntent"]; referenceAction?: "preview" | "revise"; festival?: string; baseRevision?: string; proposalRevision?: string; conflictChoice?: "sequence" | "narrow" | "worktree" }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const root = await campRootOf(deps, ctx);
      if (!root) {
        return await idleResult(deps, ctx);
      }
      const draftAction = params.action;
      if (draftAction !== "read" && draftAction !== "list") {
        const blocked = supervisorOnly(ctx, "plan mutation");
        if (blocked) return blocked;
      }
      if (draftAction === "list") {
        return textResult({
          kind: "plan_drafts",
          drafts: (await listPlanDrafts(root)).map(({ draftId, revision, fields, missing }) => ({ draftId, revision, name: fields.name, goal: fields.goal, missing })),
          previews: (await listPlanPreviews(root)).map(({ name, plan, state, planRevision, updatedAt }) => ({ name, plan, state, ...(planRevision ? { planRevision } : {}), ...(updatedAt ? { updatedAt } : {}) })),
        });
      }
      if (draftAction === "read") {
        try { return textResult({ kind: "plan_draft", ...await readPlanDraft(root, params.draftId ?? "") }); }
        catch (error) { return planFailure(error, { field: "draftId" }); }
      }
      if (draftAction === "delete") {
        try {
          if (!params.draftId) throw new Error("delete requires draftId");
          return textResult({ kind: "plan_draft_deleted", draftId: params.draftId, deleted: await deletePlanDraft(root, params.draftId, params.draftRevision ?? undefined) });
        } catch (error) { return planFailure(error, { field: "draftId" }); }
      }
      if (draftAction === "create" || draftAction === "update") {
        try {
          const attachments = params.attachments?.map((item) => classifyAttachment(item.name, item.description, item.role));
          let patch: Partial<PlanDraftFields> = {
            ...(params.name ? { name: params.name } : {}), ...(params.goal !== undefined ? { goal: params.goal } : {}),
            ...(params.scope ? { scope: params.scope } : {}), ...(params.exclusions ? { exclusions: params.exclusions } : {}),
            ...(params.acceptance ? { acceptance: params.acceptance } : {}), ...(params.inspection ? { inspection: params.inspection } : {}),
            ...(params.workingDir ? { workingDir: params.workingDir } : {}), ...(params.files ? { files: params.files } : {}),
            ...(params.verification ? { verification: params.verification } : {}), ...(params.rules !== undefined ? { rules: params.rules } : {}),
            ...(params.referencesDir ? { referencesDir: params.referencesDir } : {}), ...(params.visualIntent ? { visualIntent: params.visualIntent } : {}),
            ...(params.spec ? { spec: params.spec } : {}),
            ...(params.templateMarkers ? { templateMarkers: Object.fromEntries(params.templateMarkers.map(({ hint, value }) => [hint, value])) } : {}),
            ...(attachments ? { attachments } : {}),
          } satisfies Partial<PlanDraftFields>;
          const project = patch.workingDir || draftAction === "create" ? await resolveWorkingDir(root, deps.camp, patch.workingDir) : undefined;
          if (project?.dir) patch = { ...patch, workingDir: project.dir };
          const draft = draftAction === "create"
            ? await createPlanDraft(root, { ...patch, name: params.name ?? "" })
            : await updatePlanDraft(root, params.draftId ?? "", params.draftRevision ?? "", patch);
          return textResult({ kind: draft.missing.length || draft.diagnostics.length ? "plan_draft_incomplete" : "plan_draft", draftId: draft.draftId, revision: draft.revision, name: draft.fields.name, goal: draft.spec.goal, missing: draft.missing, diagnostics: draft.diagnostics, attachments: draft.fields.attachments,
            pathPolicy: "workingDir is camp-root-relative; inspection, task files, verification cwd and provenancePath are project-relative. Actual execution evidence is recorded separately.",
            nextAction: draft.missing.length || draft.diagnostics.length ? "Repair only the named fields or resolve listed material decisions; preserve all other draft content. Do not rerun preview unchanged." : `Call fest_plan {action:"preview",draftId:"${draft.draftId}",draftRevision:"${draft.revision}"}.` });
        } catch (error) { return planFailure(error); }
      }
      if (params.draftId) {
        try {
          if (params.action !== "preview" || params.spec) throw new Error("draftId only applies to action:'preview'. For scaffold, pass name alone — the latest approved revision is resolved automatically.");
          const draft = await readPlanDraft(root, params.draftId);
          if (draft.revision !== params.draftRevision) throw new Error("Draft changed; read current draft and approve the new revision");
          if (draft.missing.length) throw new Error(`Draft is incomplete: ${draft.missing.join(", ")}`);
          if (draft.diagnostics.length) throw new PlanningValidationError(draft.diagnostics);
          params = { ...params, name: draft.fields.name, plan: draft.plan, spec: draft.spec, workingDir: draft.fields.workingDir, rules: draft.fields.rules, templateMarkers: draft.fields.templateMarkers ? Object.entries(draft.fields.templateMarkers).map(([hint, value]) => ({ hint, value })) : undefined, referencesDir: draft.fields.referencesDir ? resolve(root, draft.fields.referencesDir) : undefined, visualIntent: draft.fields.visualIntent, attachments: draft.fields.attachments?.map((item) => ({ name: item.name, description: item.reason, role: item.role })) };
        } catch (error) { return planFailure(error); }
      }
      if (!params.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(params.name)) return planFailure("name must be a lowercase festival slug", { field: "name" });
      params.plan ??= join(root, ".ompfest", "plans", `${params.name}.STRUCTURE.md`);
      const canonicalPlan = join(root, ".ompfest", "plans", `${params.name}.STRUCTURE.md`);
      const suppliedPlan = resolve(root, params.plan);
      const planPath = canonicalPlan;
      const planWarnings = suppliedPlan === canonicalPlan ? [] : [`plan was normalized to the camp plan path ${canonicalPlan}`];
      if (params.referencesDir) params.referencesDir = resolve(root, params.referencesDir);
      if (params.action && params.referenceAction) return planFailure("Use action for the full plan preview/scaffold flow, or referenceAction for an existing reference revision—not both.");
      if (!params.action && !params.referenceAction) return planFailure("Choose action:'preview' with a structured spec, then action:'scaffold' with the human-approved planRevision.");
      if (params.action === "preview" && !params.spec) return planFailure("Plan preview requires a structured spec.", { code: "MISSING_SPEC", field: "spec" });
      if (params.action === "scaffold" && params.spec) return planFailure("Scaffolding uses the persisted approved preview — omit spec. Pass only name; the latest approved revision is used automatically.", { code: "INVALID_SCAFFOLD_INPUT" });
      if (params.action === "cancel") {
        try {
          if (!params.approvedRevision) throw new Error("Cancelling a preview requires its exact planRevision.");
          await abandonPlanPreview(root, planPath, params.name, params.approvedRevision, "cancelled");
          return textResult({ kind: "plan_cancelled", name: params.name, planRevision: params.approvedRevision, artifactsPreserved: true });
        } catch (error) { return planFailure(error); }
      }
      if (params.action && params.referencesDir && (params.visualIntent !== "ui_visual" || !params.attachments?.some((item) => item.role === "ui_design"))) {
        return textResult({
          kind: "plan_failed", code: "VISUAL_REFERENCE_NOT_CONFIRMED", field: "attachments",
          expected: "explicit ui_visual intent and at least one attachment classified ui_design",
          received: params.attachments?.map((item) => item.role) ?? [],
          nextAction: "Keep error screenshots, PDFs, documents, and ambiguous attachments as evidence. Ask one focused role question before creating visual references.",
        });
      }
      let approved: ApprovedPlan | undefined;
      let targetWorkingDir = params.workingDir;
      let agreedRules = params.rules;
      let bundle;
      if (params.referencesDir) {
        try {
          bundle = await prepareVisualReferences(root, planPath, params.referencesDir);
        } catch (error) {
          return planFailure(error, { hint: "Fix the visual bundle before scaffolding." });
        }
      }
      if (params.action === "preview") {
        try {
          const project = await resolveWorkingDir(root, deps.camp, params.workingDir);
          if (!project.dir) return planFailure("Choose a target project before preview", { projects: project.candidates });
          const spec = params.spec;
          if (!spec) return planFailure("Plan preview requires a structured spec.", { code: "MISSING_SPEC", field: "spec" });
          const normalized = normalizePlanInput(spec, resolve(root, project.dir));
          const conflicts = await findPlanningConflicts(root, params.name, project.dir, normalized.spec);
          const conflictChoice = params.conflictChoice;
          if (conflicts.length && !conflictChoice) return textResult({ kind: "planning_conflict", conflicts, choices: ["sequence", "narrow", "worktree"], nextAction: "Ask the human to choose; no plan artifact was written and no existing plan was changed or cancelled. Retry preview with conflictChoice." });
          if (conflicts.length && conflictChoice === "narrow") return textResult({ kind: "planning_conflict", conflicts, resolution: "narrow", nextAction: "Revise the draft/spec to remove overlapping files, then preview again. Existing plans remain unchanged." });
          if (conflicts.length && conflictChoice === "worktree") return textResult({ kind: "planning_conflict", conflicts, resolution: "worktree", nextAction: "Choose an isolated worktree as workingDir, then preview again. This tool does not create or transfer a worktree." });
          const rules = conflicts.length ? [params.rules?.trim(), `Planning conflict decision: sequence overlapping files ${conflicts.map((conflict) => `${conflict.name} (${conflict.files.join(", ")})`).join("; ")} one at a time. Keep all plans; never cancel another plan.`].filter(Boolean).join("\n") : params.rules ?? "";
          const prepared = await previewPlan(root, planPath, {
            name: params.name, workingDir: project.dir, rules,
            ...(params.templateMarkers ? { templateMarkers: Object.fromEntries(params.templateMarkers.map(({ hint, value }) => [hint, value])) } : {}),
            ...(params.referencesDir ? { referencesDir: params.referencesDir } : {}), spec: normalized.spec,
          }, bundle?.files);
          const visual = bundle ? await renderPlanPreview(prepared.plan, bundle) : undefined;
          const reuseCandidates = bundle ? await findReuseCandidates(root, project.dir, bundle) : [];
          return await interactivePlanReview(ctx, {
            kind: "plan_preview", plan: prepared.plan, preview: prepared.preview, previewFile: prepared.previewFile,
            counts: prepared.counts, planRevision: prepared.planRevision, reuseCandidates,
            pathPolicy: { campRoot: root, workingDir: project.dir, projectPaths: "inspection, task files, verification cwd, and provenancePath are relative to workingDir; command provenance is not actual evidence" },
            ...(planWarnings.length || normalized.warnings.length ? { warnings: [...planWarnings, ...normalized.warnings] } : {}),
            ...(visual ? { visualPreview: visual } : {}),
          }, { root, plan: planPath, name: params.name, references: bundle?.files ?? [] });
        } catch (error) {
          return planFailure(error);
        }
      }
      if (params.action === "scaffold") {
        try {
          const nameCheck = params.name ? festivalNameOk((await loadConfig(root)).conventions, params.name) : { ok: true };
          if (!nameCheck.ok) throw new Error(`Festival name "${params.name}" violates conventions.festivalName: /${nameCheck.pattern}/`);
          const revision = params.approvedRevision ?? (await listPlanPreviews(root))
            .filter((preview) => preview.name === params.name && preview.state === "approved" && preview.planRevision)
            .map((preview) => preview.planRevision ?? "")
            .filter((rev) => rev.length > 0)
            .at(-1);
          if (!revision) throw new Error(`No approved preview for ${params.name}; run action:"preview" and get human approval first.`);
          const normalizedWorkingDir = params.workingDir
            ? (await resolveWorkingDir(root, deps.camp, params.workingDir)).dir
            : undefined;
          approved = await approvedPlan(root, planPath, params.name, revision, bundle?.files);
          if (approved.artifact.name !== params.name ||
              (params.referencesDir !== undefined && approved.artifact.referencesDir !== params.referencesDir) ||
              (normalizedWorkingDir !== undefined && approved.artifact.workingDir !== normalizedWorkingDir) ||
              (params.rules !== undefined && approved.artifact.rules !== params.rules)) {
            throw new Error("Scaffold options differ from the approved preview. Preview the changes before scaffolding.");
          }
          if (!bundle && approved.artifact.referencesDir) {
            bundle = await prepareVisualReferences(root, planPath, approved.artifact.referencesDir);
          }
          targetWorkingDir = approved.artifact.workingDir;
          agreedRules = approved.artifact.rules;
        } catch (error) {
          return textResult({ kind: "plan_failed", error: String(error) });
        }
      }
      if (params.referenceAction) {
        if (!bundle || (params.referenceAction === "revise" && !params.festival)) {
          return textResult({ kind: "plan_failed", error: "Reference previews require referencesDir; revisions also require an existing festival." });
        }
        try {
          const resolved = params.festival ? await festivalDirOf(deps, ctx, params.festival) : undefined;
          if (resolved?.error || (params.festival && !resolved?.dir)) {
            return textResult({ kind: "plan_failed", error: resolved?.error ?? "Festival not found" });
          }
          if (params.referenceAction === "preview") {
            const preview = await renderPlanPreview(planPath, bundle);
            const project = await resolveWorkingDir(root, deps.camp, params.workingDir);
            const reuseCandidates = await findReuseCandidates(root, project.dir, bundle);
            const impact = resolved?.dir ? await inspectReferenceRevision(resolved.dir, bundle, deps.detect) : undefined;
            return textResult({ kind: "plan_preview", preview, reuseCandidates,
              ...(impact ? { revisionImpact: impact } : {}),
              nextSteps: impact
                ? "Review affected tasks and stale checks with the human; after approval call fest_plan with referenceAction:'revise', festival and both revision digests. This does not change STRUCTURE.md or tasks."
                : "Review the rendered wireframe, page notes, task structure, states and reuse candidates with the human before scaffolding." });
          }
          if (!resolved?.dir) {
            return textResult({ kind: "plan_failed", error: "Festival not found" });
          }
          const impact = await applyReferenceRevision(resolved.dir, bundle, deps.detect,
            params.baseRevision ?? "", params.proposalRevision ?? "");
          return textResult({ kind: "references_revised", impact,
            nextSteps: "Update affected tasks, reverify stale completed checks and run fest_validate before the next gate. No tasks were silently reopened." });
        } catch (error) {
          return textResult({ kind: "plan_failed", error: String(error) });
        }
      }
      if (!approved) return textResult({ kind: "plan_failed", error: "No approved structured plan is available to scaffold." });
      const previewOutput = await deps.fest.scaffoldFromPlan(root, { plan: planPath, name: params.name, dest: "planning", dryRun: true });
      const previewResult = parseScaffoldPlanResult(previewOutput);
      const hasCounts = (
        result: ScaffoldPlanResult | undefined,
      ): result is ScaffoldPlanResult & {
        phases_created: number;
        sequences_created: number;
        tasks_created: number;
      } =>
        result !== undefined &&
        Number.isSafeInteger(result.phases_created) &&
        Number.isSafeInteger(result.sequences_created) &&
        Number.isSafeInteger(result.tasks_created);
      if (previewResult?.ok !== true || !hasCounts(previewResult)) {
        return textResult({ kind: "plan_failed", error: previewResult?.error ?? "Plan parser dry-run returned no counts; no festival was created.", output: previewOutput });
      }
      const matchesApproved = (result: ScaffoldPlanResult): boolean =>
        result.phases_created === approved.counts.phases &&
        result.sequences_created === approved.counts.sequences &&
        result.tasks_created === approved.counts.tasks;
      if (!matchesApproved(previewResult)) {
        return textResult({ kind: "plan_failed", error: "Parser output differs from the approved plan; no festival was created.", expected: approved.counts, actual: { phases: previewResult.phases_created, sequences: previewResult.sequences_created, tasks: previewResult.tasks_created }, output: previewOutput });
      }
      const beforeFestivals = await deps.detect.listFestivals(root);
      const approvedName = approved.artifact.name;
      if (beforeFestivals.some((festival) => festivalTargetMatchesName(approvedName, festival.id) || festivalTargetMatchesName(approvedName, basename(festival.path)))) {
        return textResult({ kind: "plan_failed", code: "FESTIVAL_ALREADY_EXISTS", error: `Festival ${params.name} or its generated Festival ID already exists. Choose a new plan name; existing festivals are never overwritten.` });
      }
      // Resume or clear a leftover creation journal instead of dead-stopping the retry.
      const pending = (await listFestivalCreationOrphans(root)).find((item) => item.receipt.name === params.name);
      if (pending) {
        const classification = classifyCreationOrphan(pending);
        const mayBeLive = creationJournalMayBeLive(pending, sessionIdOf(ctx));
        if (classification === "in_flight") {
          if (mayBeLive) {
            return textResult({ kind: "plan_failed", code: "CREATION_IN_FLIGHT", error: `A scaffold transaction for ${params.name} started recently in another session and may still be running.`, hint: `Once it is dead, fest_orphans {action:"rollback",transaction:"${pending.receipt.id}"} resolves it — or retry scaffold; dead/own journals self-heal.` });
          }
          // Own or dead journal with no festival dir — safe to clear and proceed.
          await clearCreationJournal(root, pending).catch(() => undefined);
        }
        if (classification === "resume") {
          if (await festivalCreationIsScaffolded(pending.receipt)) {
            try {
              await completeFestivalCreation(pending.receipt);
              return textResult({
                kind: "plan_scaffolded", planRevision: approved.planRevision, counts: approved.counts,
                festivalDir: pending.festivalDir, validation: { score: 100 }, resumedTransaction: true,
                nextSteps: [`The earlier scaffold was already validated; its transaction is finalized. Run fest_validate before promotion, then fest_promote {festival:"${pending.receipt.name}"} twice.`],
              });
            } catch (cleanupError) {
              return textResult({ kind: "plan_failed", error: `Prior scaffold cleanup failed: ${String(cleanupError)}`, hint: `Resolve the transaction with /fest orphans rollback ${pending.receipt.id}.` });
            }
          }
          if (mayBeLive) {
            return textResult({ kind: "plan_failed", code: "CREATION_ORPHANED", error: `Festival ${params.name} has an incomplete scaffold that was never validated and may still be running in another session.`, orphanedCreation: pending, hint: `Once it is dead, fest_orphans {action:"rollback",transaction:"${pending.receipt.id}"} quarantines the partial festival so you can retry.` });
          }
          // Dead or own incomplete scaffold — quarantine (reversible) and continue.
          const unresolved = await rollbackFestivalCreation(pending.receipt, pending.festivalDir);
          if (unresolved) {
            return textResult({ kind: "plan_failed", code: "CREATION_ORPHANED", error: `Festival ${params.name} has an incomplete scaffold whose ownership marker could not be proven.`, orphanedCreation: unresolved, hint: `Inspect /fest orphans before retrying; the partial festival was left in place.` });
          }
        }
        // stale journals are cleared inside beginFestivalCreation
      }
      const creation = await beginFestivalCreation(root, params.name, planPath, sessionIdOf(ctx));
      let festivalDir: string | undefined;
      let planMarked = false;
      try {
        const output = await deps.fest.scaffoldFromPlan(root, { plan: planPath, name: params.name, dest: "planning" });
        deps.detect.bustCache?.();
        const parsed = parseScaffoldPlanResult(output);
        if (parsed?.ok !== true || !hasCounts(parsed) || !matchesApproved(parsed)) {
          throw new Error(parsed?.error ?? "Scaffold differs from the approved plan.");
        }
        if (!parsed.festival_dir) throw new Error("Scaffold did not report a festival directory.");
        festivalDir = isAbsolute(parsed.festival_dir) ? parsed.festival_dir : resolve(root, parsed.festival_dir);
        await recordFestivalCreation(creation, festivalDir);
        const festId = basename(festivalDir);
        const { dir: workingDir, candidates: projectCandidates } = await resolveWorkingDir(root, deps.camp, targetWorkingDir);
        await finalizeApprovedScaffold(root, festivalDir, approved.artifact);
        await materializePlanWorkflows(root, festivalDir, approved.artifact, deps.fest);
        if (bundle) await installVisualReferences(festivalDir, bundle);
        const stamped = workingDir ? await stampWorkingDir(festivalDir, workingDir) : 0;
        const rulesSeed = await seedFestivalRules(root, festivalDir, agreedRules);
        const gates = await deps.fest.gatesApply(root, festivalDir);
        const gateRules = rulesSeed.constraints ? await stampGateRules(festivalDir) : 0;
        const scaffoldValidation = await deps.fest.validate(festivalDir);
        if (scaffoldValidation.valid === false || scaffoldValidation.markersPending || (scaffoldValidation.valid === undefined && scaffoldValidation.score !== 100)) {
          throw new Error(`Generated scaffold did not pass validation (${scaffoldValidation.score}/100): ${scaffoldValidation.output.slice(0, 2000)}`);
        }
        await markPlanScaffolded(root, planPath, params.name, approved.planRevision, festivalDir, bundle?.files);
        planMarked = true;
        await completeFestivalCreation(creation);
        const removedDrafts = await deletePlanDraftsForPlan(root, params.name).catch(() => [] as string[]);
        const skipped = gates.output.match(/Skipping sequence "[^"]+"/g) ?? [];
        const needsWorkingDir = !workingDir;
        return textResult({
          kind: "plan_scaffolded",
          planRevision: approved.planRevision,
          counts: { phases: parsed.phases_created, sequences: parsed.sequences_created, tasks: parsed.tasks_created },
          festivalDir,
          ...(removedDrafts.length ? { draftsRemoved: removedDrafts } : {}),
          ...(bundle ? { visualReferences: bundle.pages.map((page) => `references/pages/${page}/PAGE.md`) } : {}),
          rules: { ...rulesSeed, gateFilesStamped: gateRules },
          ...(workingDir ? { workingDir, sequencesStamped: stamped } : {}),
          pathPolicy: { festivalDir, workingDir: workingDir ?? null, workingDirBase: "camp root", projectPathBase: "workingDir" },
          qualityGates: gates,
          validation: { score: scaffoldValidation.score },
          ...(skipped.length > 0 ? {
            gateSkippedSequences: skipped,
            gateSkippedHint: "fest excludes sequences named *_planning/*_research/*_requirements/*_docs from quality gates. If these sequences do real implementation work, rename the sequence dirs (and their fest_id/fest_name frontmatter) — otherwise the skip is intentional.",
          } : {}),
          ...(needsWorkingDir ? {
            needsWorkingDir: true, projects: projectCandidates,
            hint: "Multiple projects in this camp — no workingDir given, so sequences have NO fest_working_dir and fest_next will fail validation. Ask the human which project this festival targets, then set fest_working_dir before activation.",
          } : {}),
          nextSteps: [
            `Select the created festival explicitly with /fest select ${festId} before tool-based validation or promotion; scaffolding does not transfer session ownership.`,
            ...(bundle ? ["Link each relevant task doc with 'Visual reference: references/pages/<page>/PAGE.md' and component-level Done-When checks; fest_validate will reject unlinked pages."] : []),
            `Run fest_validate {festival:"${festId}"} — generated contract documents must contain zero template markers and valid camp-relative working directories`,
            "Generated documents have already been validated. If scope or acceptance changes, obtain new approval before promotion.",
            `fest_promote {festival:"${festId}"} twice: planning -> ready -> active`,
          ],
        });
      } catch (error) {
        deps.detect.bustCache?.();
        let candidate = festivalDir;
        if (!candidate) {
          const after = await deps.detect.listFestivals(root).catch(() => []);
          const previous = new Set(beforeFestivals.map((festival) => resolve(festival.path)));
          const created = after.filter((festival) => !previous.has(resolve(festival.path)));
          if (created.length === 1) candidate = created[0]?.path;
        }
        if (planMarked) {
          try {
            await completeFestivalCreation(creation);
            return textResult({
              kind: "plan_scaffolded", planRevision: approved.planRevision, counts: approved.counts,
              festivalDir, validation: { score: 100 }, cleanupRecovered: true,
              nextSteps: ["The validated festival and approved plan are intact; transaction cleanup succeeded on retry.", "Run fest_validate before promotion."],
            });
          } catch (cleanupError) {
            return textResult({
              kind: "plan_failed", error: `Scaffold validated but transaction cleanup failed: ${String(cleanupError)}`,
              festivalDir, orphanedCreation: { receipt: creation, festivalDir },
              hint: `The validated festival remains in place. Run /fest orphans rollback ${creation.id} to finish marker/journal cleanup; this will not quarantine or recreate it.`,
            });
          }
        }
        const orphan = candidate
          ? await rollbackFestivalCreation(creation, candidate).catch(() => ({ receipt: creation, festivalDir: candidate }))
          : { receipt: creation };
        return textResult({
          kind: "plan_failed",
          error: String(error),
          ...(orphan ? { orphanedCreation: orphan, hint: "The target and transaction journal remain because safe rollback could not be proven. Review /fest orphans before retrying." } : {}),
          ...(!orphan ? { cleanup: "The partial festival was moved to reversible .ompfest/orphans. Run /fest orphans to inspect its restore ID; the approved plan remains available to retry." } : {}),
        });
      }
    },
  });
  pi.registerTool({
    name: "fest_wireframe_create",
    label: "Create Screenshot Wireframe",
    description:
      "Create a categorized wireframe.svg and PAGE.md only for an explicitly classified UI design reference. " +
      "Never use error screenshots, PDFs/documents, backend evidence, context, or unknown-role images as wireframe input. " +
      "Choose the final festival slug before generation; outputDirectory must be .ompfest/plans/<name>.references/pages/<slug>, " +
      "matching fest_plan name and referencesDir exactly. If the name changes, regenerate under the new canonical path. " +
      "outputDirectory is camp-root-relative; sourcePaths are relative to the selected project workingDir. " +
      "Supply workingDir (for example projects/web) when the camp has multiple projects or the current camp context is ambiguous. " +
      "If the attachment role is ambiguous, ask the user before calling this tool.",
    parameters: z.object({
      attachmentRole: z.enum(["ui_design", "error_screenshot", "document_pdf", "context", "unknown"]).describe("Role explicitly classified from the user's request; only ui_design may generate a wireframe"),
      outputDirectory: z.string().describe("Camp-root-relative output path under .ompfest/plans/<name>.references/pages/<slug>; no absolute path or traversal"),
      workingDir: z.string().optional().describe("Camp-root-relative project path, e.g. projects/web; required when camp project resolution is ambiguous"),
      spec: z.object({
        title: z.string().describe("Short page or screen title"),
        slug: z.string().describe("Lowercase kebab-case page slug"),
        direction: z.enum(["ltr", "rtl"]).describe("Reading direction observed in the reference"),
        source: z.object({
          width: z.number().describe("Intrinsic source image width in pixels"),
          height: z.number().describe("Intrinsic source image height in pixels"),
          displayWidth: z.number().describe("Displayed screenshot width in pixels"),
          displayHeight: z.number().describe("Displayed screenshot height in pixels"),
        }),
        components: z.array(z.object({
          id: z.string().describe("Stable lowercase ID, max 80 characters; independent of text/copy"),
          parent: z.string().optional().describe("Parent component ID; omit for direct screen children"),
          role: z.string().describe("Semantic role, never source copy or personal data"),
          category: z.string().optional().describe("Open-ended semantic section/category, e.g. header, billing filters, results table, or chart legend"),
          kind: z.string().describe("Open-ended semantic component kind; do not constrain this to a fixed component list"),
          renderAs: z.enum(["rectangle", "text-bar", "line", "circle", "ellipse", "chevron", "checkbox"]).optional().describe("Canonical SVG primitive; text-bar preserves measured width and centers an ink bar at about 20% of the text-box height"),
          x: z.number().describe("Left coordinate in source-image pixels"),
          y: z.number().describe("Top coordinate in source-image pixels"),
          width: z.number().describe("Width in source-image pixels"),
          height: z.number().describe("Height in source-image pixels"),
          radius: z.number().optional().describe("Observed/estimated corner radius in source pixels"),
          fill: z.string().optional().describe("Hex color only"),
          stroke: z.string().optional().describe("Hex color only"),
          strokeWidth: z.number().optional().describe("Border/icon stroke width in source pixels"),
          state: z.string().optional().describe("Observed state, e.g. checked or unchecked"),
          styles: z.array(z.object({
            property: z.string(),
            value: z.string(),
            status: z.enum(["observed", "estimated", "unknown", "agreed", "n/a"]),
          })).optional().describe("Component-level style evidence and confidence"),
        })).describe("All visible primitives in screen order, including every text bar and repeated instance"),
        componentAudit: z.array(z.object({
          component: z.string().describe("Semantic component name/role inspected in the target project"),
          status: z.enum(["matched", "no_match"]),
          sourcePaths: z.array(z.string()).describe("Existing relative project paths actually inspected; matched entries cite implementation sources, no_match entries cite only existing files/directories searched"),
          notes: z.string().describe("Nonempty inspection summary, maximum 300 characters. Longer notes must be shortened, not moved into alias fields."),
        })).describe("Project component discovery results; never invent candidate paths. Missing source paths are reported in auditWarnings, excluded from verified evidence, and marked unverified in PAGE.md"),
        measurements: z.array(z.object({
          label: z.string().describe("Measured gap or dimension name"),
          from: z.string().describe("First stable component ID"),
          to: z.string().describe("Second stable component ID"),
          value: z.number().describe("Source-pixel distance or dimension"),
          status: z.enum(["observed", "estimated", "unknown", "agreed", "n/a"]),
        })).describe("Explicit component sizes and gaps, with measurement confidence"),
        states: z.array(z.object({
          viewport: z.string(),
          state: z.string(),
          status: z.enum(["observed", "unknown", "agreed", "n/a"]),
          expected: z.string(),
        })).describe("Observed states and explicit unknown coverage; do not invent unseen states"),
        openQuestions: z.array(z.string()).describe("Focused unresolved questions that could change structure or styling; empty when none"),
      }),
    }),
    async execute(_id: string, params: { outputDirectory: string; workingDir?: string; attachmentRole: "ui_design" | "error_screenshot" | "document_pdf" | "context" | "unknown"; spec: WireframeSpec }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      if (params.attachmentRole !== "ui_design") return textResult({ kind: "wireframe_blocked", code: "NOT_UI_DESIGN", field: "attachmentRole", expected: "ui_design", received: params.attachmentRole, nextAction: "Keep this attachment as evidence; ask the user if the attachment role is ambiguous. Do not produce a wireframe." });
      const blocked = supervisorOnly(ctx, "wireframe creation");
      if (blocked) return blocked;
      try {
        const location = await deps.detect.locate(ctx.cwd);
        const campRoot = location.campRoot ?? ctx.cwd;
        const workingDir = params.workingDir ?? (location.kind === "project" ? ctx.cwd : undefined);
        const target = await resolveWorkingDir(campRoot, deps.camp, workingDir);
        if (!target.dir) {
          return textResult({ kind: "wireframe_failed", code: "WORKING_DIR_REQUIRED", candidates: target.candidates, nextAction: "Choose the inspected project and retry with its camp-root-relative workingDir; audit sourcePaths resolve from that project, while outputDirectory resolves from the camp root." });
        }
        const result = await createWireframe(params.outputDirectory, resolve(campRoot, target.dir), params.spec, campRoot);
        return textResult({ kind: "wireframe_created", ...result, pathPolicy: { outputDirectoryBase: "camp root", sourcePathsBase: target.dir, workingDir: target.dir } });
      } catch (error) {
        return textResult({
          kind: "wireframe_failed",
          ...(error instanceof WireframeInputError
            ? { diagnostics: error.diagnostics, hint: "Fix only the named fields. Use the tool schema; do not search binaries or add compatibility aliases." }
            : { error: String(error) }),
        });
      }
    },
  });


  pi.registerTool({
    name: "fest_promote",
    label: "Fest Promote",
    description:
      "Advance a festival one lifecycle step (planning -> ready -> active). " +
      "Call only after the human has approved the plan — never self-promote an unreviewed plan.",
    parameters: z.object({
      festival: z.string().optional().describe("Festival name/id; omit to promote the current festival"),
    }),
    async execute(_id: string, params: { festival?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const blocked = supervisorOnly(ctx, "festival promotion");
      if (blocked) return blocked;
      const location = await deps.detect.locate(ctx.cwd);
      const sid = sessionIdOf(ctx);
      if (params.festival) {
        if (!location.campRoot) {
          return await idleResult(deps, ctx);
        }
        const candidate = matchFestival(await deps.detect.listFestivals(location.campRoot), params.festival);
        if (candidate.kind === "match") {
          const ownership = await festivalOwner(candidate.festival.path);
          if (ownership?.sessionId !== sid) {
            return textResult({ kind: "coordinator_required", festival: candidate.festival.id, coordinator: ownership?.sessionId, hint: `Use /fest select ${candidate.festival.id} to explicitly claim it before promoting.` });
          }
          const visual = await validateVisualReferences(candidate.festival.path, deps.detect);
          if (visual.issues.length > 0) {
            return textResult({ kind: "promotion_blocked", issues: visual.issues });
          }
        }
        const output = await deps.fest.promote(location.campRoot, params.festival);
        deps.detect.bustCache?.();
        // An explicit promote claims that festival for this session.
        const match = matchFestival(await deps.detect.listFestivals(location.campRoot), params.festival);
        if (match.kind === "match" && deps.tracker.claimFestival(sid, match.festival.path)) {
          persistClaim(pi, match.festival.path, location.campRoot);
        }
        const worktrees = match.kind === "match" ? await maybeCreateFestivalWorktrees(deps, location.campRoot, match.festival.path, match.festival.id) : undefined;
        if (worktrees && !Array.isArray(worktrees)) return textResult({ kind: "promotion_incomplete", code: "WORKTREE_BINDING_FAILED", output, error: worktrees.error, hint: "Native promotion succeeded but execution setup failed. Repair the binding and retry fest_next; do not promote again or execute in the original checkout." });
        return textResult({ kind: "promoted", output, ...(Array.isArray(worktrees) && worktrees.length ? { worktrees: worktrees.map((row) => row.worktreePath) } : {}), nextSteps: SUPERVISOR_POLICY });
      }
      const dir = location.festivalDir ??
        (location.campRoot ? await claimedFestivalDir(deps.tracker, deps.detect, sid, location.campRoot) : undefined);
      if (!dir) return await idleResult(deps, ctx);
      const owner = await festivalOwner(dir);
      if (owner?.sessionId !== sid) {
        return textResult({ kind: "festival_owned", festival: basename(dir), owner: owner?.sessionId, hint: "Promotion is coordinator-only; join with /fest join to contribute without ownership transfer." });
      }
      const visual = await validateVisualReferences(dir, deps.detect);
      if (visual.issues.length > 0) {
        return textResult({ kind: "promotion_blocked", issues: visual.issues });
      }
      const promotedId = basename(dir);
      const output = await deps.fest.promote(dir);
      deps.detect.bustCache?.();
      // The promote renamed festivals/<status>/<id> — re-point the claim at the new dir.
      let worktreeNote: Awaited<ReturnType<typeof maybeCreateFestivalWorktrees>> | undefined;
      if (location.campRoot && deps.tracker.claimedFestivalIdFor(sid) === promotedId) {
        const moved = (await deps.detect.listFestivals(location.campRoot)).find((f) => f.id === promotedId);
        if (moved && deps.tracker.claimFestival(sid, moved.path)) {
          persistClaim(pi, moved.path, location.campRoot);
        }
        worktreeNote = moved ? await maybeCreateFestivalWorktrees(deps, location.campRoot, moved.path, moved.id) : undefined;
      }
      if (worktreeNote && !Array.isArray(worktreeNote)) return textResult({ kind: "promotion_incomplete", code: "WORKTREE_BINDING_FAILED", output, error: worktreeNote.error, hint: "Native promotion succeeded but execution setup failed. Repair the binding and retry fest_next; do not promote again or execute in the original checkout." });
      return textResult({ kind: "promoted", output, ...(Array.isArray(worktreeNote) && worktreeNote.length ? { worktrees: worktreeNote.map((row) => row.worktreePath) } : {}), nextSteps: SUPERVISOR_POLICY });
    },
  });

  pi.registerTool({
    name: "camp_init",
    label: "Camp Init",
    description:
      "Initialize a new camp in the current directory (camp init + .ompfest.json defaults). " +
      "Use when the agent starts in a non-camp directory; after init, start new work with /fest idea -> /fest plan.",
    parameters: z.object({}),
    async execute(_id: string, _params: Record<string, never>, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const location = await deps.detect.locate(ctx.cwd);
      if (location.campRoot) {
        return textResult({ kind: "camp_initialized", campRoot: location.campRoot, already: true, nextAction: "Camp exists — start work with /fest idea -> /fest plan <goal>." });
      }
      const result = await deps.camp.raw(ctx.cwd, ["init"]);
      if (result.code !== 0) {
        return textResult({ kind: "camp_init_failed", code: "CAMP_INIT_FAILED", retryable: true, error: result.stderr.trim() || result.stdout.trim() });
      }
      const configPath = join(ctx.cwd, ".ompfest.json");
      if (!(await lstat(configPath).catch(() => undefined))) {
        await writeFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
      }
      const rulesPath = join(ctx.cwd, CAMP_RULES_FILE);
      let rulesSeeded = false;
      if (!(await lstat(rulesPath).catch(() => undefined))) {
        await writeFile(rulesPath, CAMP_RULES_SKELETON);
        rulesSeeded = true;
      }
      const festOk = await deps.fest.available();
      deps.detect.bustCache?.();
      return textResult({
        kind: "camp_initialized",
        campRoot: ctx.cwd,
        ...(rulesSeeded ? { rulesFile: CAMP_RULES_FILE } : {}),
        output: result.stdout.trim() || undefined,
        ...(festOk ? {} : { warning: "fest CLI not found — install it with: npm i -g @obedience-corp/festival" }),
        nextAction: "Camp ready — edit RULES.md for camp-wide rules, then /fest idea <text> -> /fest plan <goal>.",
      });
    },
  });

  pi.registerTool({
    name: "camp_status",
    label: "Camp Status",
    description:
      "Whole-camp coordination view: every festival with its status, owner session, open unit, " +
      "progress, recorded worktrees, pending gates, plus orphan transactions and active write reservations.",
    parameters: z.object({}),
    async execute(_id: string, _params: Record<string, never>, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const location = await deps.detect.locate(ctx.cwd);
      const root = location.campRoot;
      if (!root) return await idleResult(deps, ctx);
      const sid = sessionIdOf(ctx);
      const syncedRules = await syncCampRules(root).catch(() => 0);
      const rules = await campRules(root).catch(() => undefined);
      const festivals = await deps.detect.listFestivals(root);
      const orphans = await listFestivalCreationOrphans(root);
      const projects = await deps.camp.projects(root).catch(() => []);
      const reservations = (await Promise.all(projects.map((project) =>
        listProjectReservations(isAbsolute(project.path) ? project.path : resolve(root, project.path)).catch(() => []),
      ))).flat();
      const campConfig = await loadConfig(root);
      const rows = await Promise.all(festivals.map(async (festival) => {
        const owner = await festivalOwner(festival.path).catch(() => undefined);
        const worktrees = await readFestivalWorktrees(festival.path).catch(() => []);
        const tasks = await deps.detect.pendingTasks(festival.path).catch(() => []);
        const progress = summarizeProgress(await deps.detect.readProgress(festival.path).catch(() => []), tasks);
        const openTasks = tasks.filter((task) => !task.done).length;
        return {
          id: festival.id,
          status: festival.status,
          ...(owner ? { owner: owner.sessionId, stale: festivalOwnerIsDead(owner) || undefined } : {}),
          progress: `${progress.completed}/${progress.total}`,
          ...(progress.currentLabel ? { current: progress.currentLabel } : {}),
          ...(progress.gatePending ? { gatePending: true } : {}),
          ...(openTasks ? { openTasks } : {}),
          ...(worktrees.length ? { worktrees: worktrees.map((row) => row.worktreePath) } : {}),
        };
      }));
      return textResult({
        kind: "camp_status",
        camp: location.campName,
        sessionId: sid,
        ...(rules ? { rules: { file: CAMP_RULES_FILE, count: campRulesCount(rules), ...(syncedRules ? { synced: syncedRules } : {}) } } : {}),
        festivals: rows,
        orphans: orphans.map((orphan) => ({ transaction: orphan.receipt.id, name: orphan.receipt.name, state: classifyCreationOrphan(orphan) })),
        reservations: reservations.map((row) => ({ worker: row.worker ?? row.sessionId, files: row.files, project: basename(row.projectDir) })),
        conventions: conventionsEcho(campConfig.conventions),
        ...(campConfig.configWarnings?.length ? { configWarnings: campConfig.configWarnings } : {}),
      });
    },
  });

  pi.registerTool({
    name: "camp_rules",
    label: "Camp Rules",
    description:
      "Read or edit the camp's RULES.md — the rulebook enforced in every festival (seeded into " +
      "FESTIVAL_RULES.md and gate tasks). add/remove/sync are supervisor-only; workers may list/show.",
    parameters: z.object({
      action: z.enum(["show", "list", "add", "remove", "sync"]).describe("show = full file; list = numbered rules; add = append a bullet; remove = delete by 1-based index or exact text; sync = propagate camp RULES.md into all festivals now"),
      rule: z.string().optional().describe("Rule text (add) or text/index to remove"),
    }),
    async execute(_id: string, params: { action: string; rule?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const location = await deps.detect.locate(ctx.cwd);
      const root = location.campRoot;
      if (!root) return await idleResult(deps, ctx);
      const rulesPath = join(root, CAMP_RULES_FILE);
      const read = async () => (await readFile(rulesPath, "utf8").catch(() => "")).trimEnd();
      if (params.action === "show" || params.action === "list") {
        const text = await read();
        if (!text) {
          return textResult({ kind: "camp_rules", rules: [], hint: `No ${CAMP_RULES_FILE} yet — create with camp_rules{action:"add", rule:"..."} or /fest rules add.` });
        }
        const items = text.split("\n").map((line) => line.trim()).filter((line) => /^[-*]\s+\S/.test(line)).map((line) => line.replace(/^[-*]\s+/, ""));
        return textResult({ kind: "camp_rules", file: rulesPath, rules: items, ...(params.action === "show" ? { text } : {}) });
      }
      const blocked = supervisorOnly(ctx, "camp rules mutation");
      if (blocked) return blocked;
      if (params.action === "sync") {
        const synced = await syncCampRules(root);
        return textResult({ kind: "camp_rules_synced", synced });
      }
      if (params.action === "add") {
        const rule = params.rule?.trim();
        if (!rule) return textResult({ kind: "camp_rules_failed", code: "MISSING_RULE", retryable: true, nextAction: "Pass rule: the rule text to append." });
        const text = await read();
        const bullet = `- ${rule.replace(/^[-*]\s+/, "")}`;
        const next = text ? `${text}\n${bullet}\n` : `${CAMP_RULES_SKELETON.trimEnd()}\n\n${bullet}\n`;
        await writeAtomically(rulesPath, next);
        const synced = await syncCampRules(root);
        return textResult({ kind: "camp_rules_updated", added: bullet, file: rulesPath, synced });
      }
      if (params.action === "remove") {
        const selector = params.rule?.trim();
        if (!selector) return textResult({ kind: "camp_rules_failed", code: "MISSING_RULE", retryable: true, nextAction: "Pass rule: the 1-based index or exact rule text to remove." });
        const text = await read();
        if (!text) return textResult({ kind: "camp_rules", rules: [], hint: "No rules file." });
        const lines = text.split("\n");
        const bullets = lines.map((line, i) => ({ line, i })).filter((row) => /^\s*[-*]\s+\S/.test(row.line));
        const index = /^\d+$/.test(selector) ? Number.parseInt(selector, 10) : undefined;
        const target = index !== undefined
          ? bullets[index - 1]
          : bullets.find((row) => row.line.replace(/^\s*[-*]\s+/, "") === selector || row.line.includes(selector));
        if (!target) return textResult({ kind: "camp_rules_failed", code: "RULE_NOT_FOUND", retryable: true, nextAction: "Run camp_rules{action:\"list\"} to see numbered rules." });
        lines.splice(target.i, 1);
        await writeAtomically(rulesPath, `${lines.join("\n").trimEnd()}\n`);
        const synced = await syncCampRules(root);
        return textResult({ kind: "camp_rules_updated", removed: target.line.trim(), file: rulesPath, synced });
      }
      return textResult({ kind: "camp_rules_failed", code: "UNKNOWN_ACTION", retryable: false });
    },
  });

  pi.registerTool({
    name: "camp_conventions",
    label: "Camp Conventions",
    description:
      "Machine-checked camp conventions from .ompfest.json (branch/worktreeDir templates, commitStyle, " +
      "festivalName regex, finishMerge). show lists the effective conventions; set changes one key " +
      "(supervisor-only); prompt parses plain words like 'conventional commits, feature branches, squash' " +
      "and applies what it understands; reset restores defaults.",
    parameters: z.object({
      action: z.enum(["show", "set", "reset", "prompt"]).optional(),
      key: z.string().optional().describe("conventions key: festivalName | branch | worktreeDir | commitStyle | commitPrefix | finishMerge"),
      value: z.string().optional().describe("new value for set (commitStyle: free|conventional|prefix; finishMerge: merge|squash)"),
      words: z.string().optional().describe("plain-language conventions request for action prompt"),
    }),
    async execute(_id: string, params: { action?: "show" | "set" | "reset" | "prompt"; key?: string; value?: string; words?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const location = await deps.detect.locate(ctx.cwd);
      const root = location.campRoot;
      if (!root) return textResult({ kind: "conventions_failed", code: "NO_CAMP", retryable: false, error: "Not inside a camp." });
      const action = params.action ?? "show";
      if (action === "show") {
        const config = await loadConfig(root);
        return textResult({ kind: "conventions", file: join(root, ".ompfest.json"), conventions: config.conventions, echo: conventionsEcho(config.conventions), warnings: config.configWarnings ?? [] });
      }
      const blocked = supervisorOnly(ctx, "conventions mutation");
      if (blocked) return blocked;
      if (action === "reset") {
        const config = await saveConfig(root, { conventions: DEFAULT_CONFIG.conventions });
        return textResult({ kind: "conventions", reset: true, conventions: config.conventions, echo: conventionsEcho(config.conventions) });
      }
      if (action === "set") {
        const key = params.key as keyof Conventions | undefined;
        const allowed: (keyof Conventions)[] = ["festivalName", "branch", "worktreeDir", "commitStyle", "commitPrefix", "finishMerge"];
        if (!key || !allowed.includes(key) || params.value === undefined) {
          return textResult({ kind: "conventions_failed", code: "BAD_INPUT", retryable: true, error: `set requires key (${allowed.join(" | ")}) and value.` });
        }
        if (key === "commitStyle" && !["free", "conventional", "prefix"].includes(params.value)) {
          return textResult({ kind: "conventions_failed", code: "BAD_VALUE", retryable: true, error: "commitStyle must be free | conventional | prefix." });
        }
        if (key === "finishMerge" && !["merge", "squash"].includes(params.value)) {
          return textResult({ kind: "conventions_failed", code: "BAD_VALUE", retryable: true, error: "finishMerge must be merge | squash." });
        }
        if (key === "festivalName" && params.value) {
          try { new RegExp(params.value); } catch {
            return textResult({ kind: "conventions_failed", code: "BAD_VALUE", retryable: true, error: `festivalName must be a valid regex — got ${JSON.stringify(params.value)}` });
          }
        }
        const config = await saveConfig(root, { conventions: { [key]: params.value } as Partial<Conventions> as Conventions });
        return textResult({ kind: "conventions", set: { [key]: params.value }, conventions: config.conventions, echo: conventionsEcho(config.conventions), warnings: config.configWarnings ?? [] });
      }
      // action === "prompt" (the only remaining enum value)
      {
        if (!params.words?.trim()) {
          return textResult({ kind: "conventions_failed", code: "BAD_INPUT", retryable: true, error: "prompt requires words — e.g. 'conventional commits, feature branches, squash merges'." });
        }
        const { patch, unparsed } = parseConventionWords(params.words);
        if (!Object.keys(patch).length) {
          return textResult({ kind: "conventions_failed", code: "NOT_UNDERSTOOD", retryable: true, unparsed, error: "Could not map any of that to a convention key. Set keys directly, or phrase it like 'conventional commits, feature/* branches, worktrees in .wt/{festival}'." });
        }
        const config = await saveConfig(root, { conventions: patch as Conventions });
        return textResult({ kind: "conventions", applied: patch, ...(unparsed.length ? { unparsed, hint: "Unparsed clauses — apply them yourself via camp_conventions set." } : {}), conventions: config.conventions, echo: conventionsEcho(config.conventions), warnings: config.configWarnings ?? [] });
      }
      return textResult({ kind: "conventions_failed", code: "UNKNOWN_ACTION", retryable: true, error: `Unknown action ${params.action}.` });
    },
  });

  pi.registerTool({
    name: "fest_advance",
    label: "Fest Advance",
    description:
      "Single-stepping helper: inspects camp + festival state and returns the ONE legal next " +
      "action for the supervisor — the tool to call, its params, and why. Use when unsure what " +
      "comes next instead of guessing the lifecycle.",
    parameters: z.object({}),
    async execute(_id: string, _params: Record<string, never>, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const location = await deps.detect.locate(ctx.cwd);
      const root = location.campRoot;
      if (!root) {
        return textResult({
          kind: "advance", code: "NO_CAMP", retryable: false,
          nextAction: { tool: "camp_init", params: {}, why: "No camp found — initialize one." },
        });
      }
      const festivals = await deps.detect.listFestivals(root);
      const claimed = await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), root);
      const dir = claimed ?? location.festivalDir;
      if (!dir) {
        if (festivals.some((festival) => festival.status === "ready")) {
          const ready = festivals.find((festival) => festival.status === "ready");
          return textResult({
            kind: "advance", code: "READY_TO_START", retryable: true,
            nextAction: { tool: "fest_promote", params: { festival: ready?.id }, why: `Festival ${ready?.id ?? "?"} is ready — promote it to active.` },
          });
        }
        if (festivals.some((festival) => festival.status === "planning")) {
          return textResult({
            kind: "advance", code: "PLANNING_IN_PROGRESS", retryable: true,
            nextAction: { tool: "camp_status", params: {}, why: "Festival(s) still planning — check status; drive planning via fest_plan/scaffold." },
          });
        }
        const orphans = await listFestivalCreationOrphans(root);
        if (orphans.length > 0) {
          return textResult({
            kind: "advance", code: "ORPHANS_PRESENT", retryable: true,
            nextAction: { tool: "fest_orphans", params: {}, why: `${orphans.length} orphan transaction(s) — inspect and rollback/restore.` },
          });
        }
        return textResult({
          kind: "advance", code: "NO_FESTIVAL", retryable: false,
          nextAction: { tool: "fest_plan", params: {}, why: "No active festival — plan one (or camp ideas via /fest ideas)." },
        });
      }
      const festivalName = basename(dir);
      const next = await deps.fest.next(dir).catch(() => undefined);
      const status = dir.includes(`${sep}completed${sep}`) ? "completed" : dir.split(sep).at(-2) ?? "active";
      if (status !== "active") {
        return textResult({
          kind: "advance", code: `STATUS_${status.toUpperCase()}`, retryable: true, festival: festivalName, status,
          nextAction: status === "ready"
            ? { tool: "fest_promote", params: { festival: festivalName }, why: "Festival is ready — promote to active." }
            : { tool: "camp_status", params: {}, why: `Festival is ${status} — inspect state.` },
        });
      }
      if (!next) {
        return textResult({ kind: "advance", code: "NEXT_UNKNOWN", retryable: true, festival: festivalName,
          nextAction: { tool: "camp_status", params: {}, why: "Could not read fest next — inspect status." } });
      }
      const nextActions: Record<string, { tool: string; params?: Record<string, unknown>; why: string }> = {
        task: { tool: "fest_next", why: "A task is next — claim and implement it (or delegate per delegateMode)." },
        wf_step: { tool: "fest_next", why: "A workflow step is next — run it." },
        gate_step: { tool: "fest_gate_submit", params: { evidence: "<one line per recorded constraint>" }, why: "A gate is pending — submit evidence; the human decides." },
        complete: { tool: "fest_complete", params: {}, why: "All tasks done — finish: merge worktrees, promote to completed." },
        blocked: { tool: "camp_status", params: {}, why: "Festival blocked — inspect status to unblock." },
        idle: { tool: "camp_status", params: {}, why: "Nothing pending — inspect camp state." },
      };
      const action = nextActions[next.kind] ?? nextActions.idle;
      return textResult({
        kind: "advance", code: `NEXT_${next.kind.toUpperCase()}`, retryable: true,
        festival: festivalName, status, unit: next,
        nextAction: action,
      });
    },
  });

  pi.registerTool({
    name: "fest_complete",
    label: "Fest Complete",
    description:
      "Finish a festival end-to-end: verify all tasks done -> merge each festival worktree into its " +
      "project base branch -> remove worktrees -> promote active -> completed -> release the claim. " +
      "Idempotent: a merge conflict or dirty worktree is reported and the rest stays resumable — fix and rerun.",
    parameters: z.object({
      festival: z.string().optional().describe("Festival name/id; omit for the claimed festival"),
      force: z.boolean().optional().describe("Skip the verified final integration review requirement"),
    }),
    async execute(_id: string, params: { festival?: string; force?: boolean }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const blocked = supervisorOnly(ctx, "festival completion");
      if (blocked) return blocked;
      const location = await deps.detect.locate(ctx.cwd);
      const root = location.campRoot;
      if (!root) return await idleResult(deps, ctx);
      const sid = sessionIdOf(ctx);
      let dir: string | undefined;
      if (params.festival) {
        const match = matchFestival(await deps.detect.listFestivals(root), params.festival);
        if (match.kind !== "match") {
          return textResult({ kind: "complete_failed", code: "FESTIVAL_NOT_FOUND", retryable: false, selector: params.festival, hint: "No festival matched; run fest_status or /fest status to list festivals." });
        }
        dir = match.festival.path;
      } else {
        dir = location.festivalDir ?? await claimedFestivalDir(deps.tracker, deps.detect, sid, root);
      }
      if (!dir) return await idleResult(deps, ctx);
      const owner = await festivalOwner(dir);
      if (owner && owner.sessionId !== sid && !festivalOwnerIsDead(owner)) {
        return textResult({ kind: "festival_owned", code: "FESTIVAL_OWNED", retryable: false, festival: basename(dir), owner: owner.sessionId, hint: "Completion is coordinator-only; use /fest select to take ownership first." });
      }
      if (lifecycleStatus(dir) !== "active" && !isCompletedFestivalPath(dir)) {
        return textResult({ kind: "complete_blocked", code: "NOT_ACTIVE", retryable: false, festival: basename(dir), hint: "Only an active festival can be completed — promote it first." });
      }
      if (isCompletedFestivalPath(dir)) {
        return textResult({ kind: "festival_completed", festival: basename(dir), already: true });
      }
      const unit = await deps.fest.next(dir);
      if (unit.kind === "gate_step") {
        return textResult({ kind: "complete_blocked", code: "GATE_PENDING", retryable: false, unit, hint: "A gate is pending human approval — /fest approve or /fest reject first." });
      }
      if (unit.kind !== "complete") {
        return textResult({ kind: "complete_blocked", code: "TASKS_OPEN", retryable: false, unit, hint: "All tasks must be completed before finish — continue fest_next until it returns complete." });
      }
      const finalVerification = await verificationResultStatus(dir);
      if (!finalVerification.valid) return textResult({ kind: "complete_blocked", code: "VERIFICATION_RESULTS_REQUIRED", missingRequirements: finalVerification.missingRequirements, hint: "Record actual current results for every approved check; a native completed task is not evidence that the check passed." });
      const review = await integrationReviewStatus(dir, deps.detect);
      if (!params.force && review.status !== "verified") {
        return textResult({ kind: "complete_blocked", code: "REVIEW_NOT_VERIFIED", retryable: true, review, hint: "Run the final integration pass (/fest finish) and record results with fest_integration — or pass force to skip." });
      }
      if (params.force && !await ctx.ui?.confirm?.("Override final integration review?", "This bypasses only the omp final integration review, not native gates, task verification, ownership, or Git safety checks. Confirm this explicit operator override.")) return textResult({ kind: "awaiting_human", nextAction: "Explicit human confirmation is required for the integration-review override." });
      let mergedWorktrees: string[] = [];
      let retainedBranches: string[] = [];
      const finishConfig = await loadConfig(root);
      if (deps.exec) {
        const merge = await mergeFestivalWorktrees(deps.exec, dir, finishConfig.conventions.finishMerge);
        if (merge.dirty.length) {
          return textResult({ kind: "complete_blocked", code: "WORKTREE_DIRTY", retryable: true, dirty: merge.dirty, hint: "Uncommitted changes in the worktree — commit them (fest_commit) or discard before finishing." });
        }
        if (merge.conflicts.length) {
          return textResult({ kind: "complete_blocked", code: "MERGE_CONFLICT", retryable: true, conflicts: merge.conflicts, hint: "Merge conflicts in the project repo — merge the base branch into the worktree branch, resolve, rerun fest_complete." });
        }
        if (merge.blocked.length || merge.pending) return textResult({ kind: "complete_blocked", code: "WORKTREE_INTEGRATION_PENDING", blocked: merge.blocked, pending: merge.pending,
          hint: "Resolve recorded repository/branch identity or cleanup issues before completion; no unsafe branch switch or reset is performed." });
        mergedWorktrees = merge.removed;
        retainedBranches = merge.retainedBranches;
      }
      const output = await deps.fest.promote(root, basename(dir));
      deps.detect.bustCache?.();
      const completed = (await deps.detect.listFestivals(root)).find((festival) => festival.id === basename(dir) && isCompletedFestivalPath(festival.path));
      if (!completed) return textResult({ kind: "complete_blocked", code: "COMPLETION_PATH_UNRESOLVED", output, hint: "Native promotion returned but its completed target was not discovered. Inspect native status before retrying; do not recreate the festival." });
      await releaseFestivalOwnership(completed.path, sid);
      deps.tracker.clearFestival(sid);
      // Finish notification: camp notify channel + optional configured webhook.
      const summary = `festival ${basename(dir)} completed${mergedWorktrees.length ? ` — merged worktrees: ${mergedWorktrees.join(", ")}` : ""}`;
      await deps.camp.notify(root, summary).catch(() => undefined);
      const config = deps.config ? await deps.config() : DEFAULT_CONFIG;
      const webhookUrl = finishConfig.webhookUrl ?? config.webhookUrl;
      if (webhookUrl) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ event: "festival_completed", festival: basename(dir), mergedWorktrees, camp: location.campName }),
        }).catch(() => undefined);
      }
      return textResult({
        kind: "festival_completed",
        festival: basename(dir),
        output,
        ...(mergedWorktrees.length ? { mergedWorktrees } : {}),
        ...(retainedBranches.length ? { retainedBranches, branchCleanup: "Squash-integrated branches are retained when Git cannot prove safe deletion." } : {}),
        nextSteps: "Festival completed and worktrees merged — the project base branch has the work.",
      });
    },
  });

  pi.registerTool({
    name: "fest_status",
    label: "Festival Status",
    description: "Current festival progress summary (phases, sequences, tasks, percent).",
    parameters: z.object({ festival: z.string().optional().describe("Festival name/id override") }),
    async execute(_id: string, params: { festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      return textResult(await deps.fest.status(r.dir));
    },
  });

  pi.registerTool({
    name: "fest_markers",
    label: "Fest Markers",
    description: "List/count unfilled [REPLACE:] and [FILL:] template markers that block fest next.",
    parameters: z.object({
      list: z.boolean().optional(),
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { list?: boolean; festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      const dir = r.dir;
      const count = await deps.fest.markersCount(dir);
      const listing = params.list ? await deps.fest.markersList(dir) : undefined;
      return textResult({ unfilled: count, ...(listing ? { listing } : {}) });
    },
  });

  pi.registerTool({
    name: "fest_parallel",
    label: "Fest Parallel",
    description:
      "Deprecated candidate listing. Use fest_supervisor action:'queue' for dependency-eligible tasks, reservations and file-overlap filtering; this tool never supplies dispatch candidates.",
    parameters: z.object({ festival: z.string().optional().describe("Festival name/id override") }),
    execute() {
      return textResult({
        kind: "parallel_queue_deprecated",
        nextAction: "Call fest_supervisor action:'queue' (or action:'portfolio') and dispatch only the supervisor-filtered candidates.",
      });
    },
  });

  pi.registerTool({
    name: "fest_raw",
    label: "Fest Raw",
    description:
      "Run supported `fest` subcommands not covered by typed tools (list, rules, context, show, markers, " +
      "workflow, chain, feedback, promote, types, watch, deps, parse, tokens, links, ...). `scaffold` is blocked; " +
      "use fest_plan with the approved planRevision. task mutations get --yes auto-injected. Returns " +
      "{code, stdout, stderr} and never throws — check code before trusting output.",
    parameters: z.object({
      args: z.array(z.string()).describe("fest args, e.g. ['list','--json'] or ['workflow','status']"),
      festival: z.string().optional().describe("Festival dir/name override when at camp root"),
    }),
    async execute(_id: string, params: { args: string[]; festival?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const policy = classifyNativeCommand("fest", params.args);
      if (policy.blocked) return textResult({ kind: "typed_tool_required", code: "NATIVE_OPERATION_REQUIRES_TYPED_TOOL", nextAction: policy.blocked });
      if (policy.access !== "read") {
        const blocked = supervisorOnly(ctx, `raw fest ${params.args.join(" ")}`);
        if (blocked) return blocked;
      }
      if (policy.access === "human" && !await ctx.ui?.confirm?.("Native Festival operation", `${policy.reason}\n\nfest ${params.args.join(" ")}`)) return textResult({ kind: "awaiting_human", nextAction: "Confirm this exact native operation before mutation." });
      const location = await deps.detect.locate(ctx.cwd);
      let cwd = location.festivalDir;
      if (!cwd && params.festival && location.campRoot) {
        const all = await deps.detect.listFestivals(location.campRoot);
        const match = matchFestival(all, params.festival ?? "");
        if (match.kind === "ambiguous") {
          return textResult({
            kind: "ambiguous_festival",
            selector: params.festival,
            matches: match.matches.map((f) => `${f.id} (${f.status})`),
          });
        }
        cwd = match.kind === "match" ? match.festival.path : undefined;
        if (!cwd) {
          return textResult({ kind: "unknown_festival", selector: params.festival, festivals: all.map((f) => f.id) });
        }
      }
      cwd ??= location.campRoot
        ? await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), location.campRoot)
        : undefined;
      cwd ??= location.campRoot;
      if (!cwd) {
        return await idleResult(deps, ctx);
      }
      if (policy.access !== "read" && location.campRoot && resolve(cwd) !== resolve(location.campRoot)) {
        const blocked = await coordinatorRequired(cwd, sessionIdOf(ctx));
        if (blocked) return blocked;
      } else if (policy.access !== "read") {
        return textResult({ kind: "coordinator_required", hint: "Mutating raw fest commands require an explicitly selected festival. Use /fest select <festival> first." });
      }
      const result = await deps.fest.raw(cwd, params.args);
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "fest_orphans",
    label: "Fest Orphans",
    description:
      "List and resolve incomplete festival creation transactions (crashed scaffolds). " +
      "action 'list' shows journals and quarantined partials; 'rollback' quarantines the partial " +
      "festival and removes the journal (allowed automatically when the journal is yours, stale, or " +
      "its process is dead — a live foreign scaffold still requires /fest select); 'restore' moves a " +
      "quarantined festival back into planning. Orphaned same-name scaffolds also self-heal on retry.",
    parameters: z.object({
      action: z.enum(["list", "rollback", "restore"]).describe("Orphan inspection or recovery"),
      transaction: z.string().optional().describe("Creation transaction id for rollback (from list)"),
      quarantine: z.string().optional().describe("Quarantine folder id for restore (from list)"),
    }),
    async execute(_id: string, params: { action: "list" | "rollback" | "restore"; transaction?: string; quarantine?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const root = await campRootOf(deps, ctx);
      if (!root) {
        return await idleResult(deps, ctx);
      }
      if (params.action === "list") {
        const orphans = await listFestivalCreationOrphans(root);
        const quarantined = await listQuarantinedFestivals(root);
        return textResult({
          kind: "orphans",
          journals: orphans.map((orphan) => ({
            transaction: orphan.receipt.id,
            name: orphan.receipt.name,
            sessionId: orphan.receipt.sessionId,
            festivalDir: orphan.festivalDir,
            state: classifyCreationOrphan(orphan),
            live: creationJournalMayBeLive(orphan, sessionIdOf(ctx)),
          })),
          quarantined,
          nextAction: "rollback <transaction> quarantines the partial festival so scaffold can retry; restore <quarantine> brings it back.",
        });
      }
      const blocked = supervisorOnly(ctx, "orphan recovery");
      if (blocked) return blocked;
      if (params.action === "rollback") {
        if (!params.transaction) return textResult({ kind: "orphan_failed", error: "rollback requires the exact transaction id from action:'list'." });
        const orphan = (await listFestivalCreationOrphans(root)).find((item) => item.receipt.id === params.transaction);
        if (!orphan) return textResult({ kind: "orphan_failed", error: `No creation transaction ${params.transaction}; rerun action:'list'.` });
        if (creationJournalMayBeLive(orphan, sessionIdOf(ctx))) {
          return textResult({ kind: "coordinator_required", error: `Transaction ${params.transaction} may still be running in another session — it is not safe to roll back automatically.`, orphan, hint: "Use /fest select then /fest orphans rollback once the other session is confirmed dead." });
        }
        if (!orphan.festivalDir) {
          await clearCreationJournal(root, orphan);
          return textResult({ kind: "orphan_cleared", transaction: orphan.receipt.id, cleared: "journal", nextSteps: "No festival directory was created; retry fest_plan action:'scaffold'." });
        }
        const unresolved = await rollbackFestivalCreation(orphan.receipt, orphan.festivalDir);
        if (unresolved) {
          return textResult({ kind: "orphan_failed", error: "Ownership marker did not match — the partial festival was left in place for human review.", orphan: unresolved });
        }
        return textResult({ kind: "orphan_cleared", transaction: orphan.receipt.id, cleared: "quarantined+journal", nextSteps: "The partial festival moved to .ompfest/orphans (reversible with action:'restore'); retry fest_plan action:'scaffold'." });
      }
      if (!params.quarantine) return textResult({ kind: "orphan_failed", error: "restore requires the quarantine folder id from action:'list'." });
      const restored = await restoreQuarantinedFestival(root, params.quarantine);
      return textResult({ kind: "orphan_restored", festivalDir: restored });
    },
  });

  pi.registerTool({
    name: "camp_raw",
    label: "Camp Raw",
    description:
      "Run ANY `camp` subcommand not covered by the typed tools (idea list/show/claim/sync, project, " +
      "machine, notify, jobs, worktree, fresh, triage, wi, ...) at the resolved camp root. Returns " +
      "{code, stdout, stderr} and never throws.",
    parameters: z.object({
      args: z.array(z.string()).describe("camp args, e.g. ['idea','list','--json']"),
    }),
    async execute(_id: string, params: { args: string[] }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const policy = classifyNativeCommand("camp", params.args);
      if (policy.blocked) return textResult({ kind: "typed_tool_required", code: "NATIVE_OPERATION_REQUIRES_TYPED_TOOL", nextAction: policy.blocked });
      if (policy.access !== "read") {
        const blocked = supervisorOnly(ctx, `raw camp ${params.args.join(" ")}`);
        if (blocked) return blocked;
      }
      if (policy.access === "human" && !await ctx.ui?.confirm?.("Native Camp operation", `${policy.reason}\n\ncamp ${params.args.join(" ")}`)) return textResult({ kind: "awaiting_human", nextAction: "Confirm this exact native operation before mutation." });
      const root = await campRootOf(deps, ctx);
      if (!root) {
        return await idleResult(deps, ctx);
      }
      const result = await deps.camp.raw(root, params.args);
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "camp_idea_add",
    label: "Capture Camp Idea",
    description: "Quick-capture an idea into the camp inbox (camp idea add).",
    parameters: z.object({ text: z.string() }),
    async execute(_id: string, params: { text: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const root = await campRootOf(deps, ctx);
      if (!root) {
        return textResult({ kind: "idle", reason: "not inside a camp" });
      }
      return textResult(await deps.camp.ideaAdd(root, params.text));
    },
  });
  registerFlowTools(pi, { detect: deps.detect, exec: deps.exec, host: deps.host });
  registerVerificationTools(pi, deps);
  registerCampNativeTools(pi, deps);
  registerFestNativeTools(pi, deps);
}
