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
import { readFile } from "node:fs/promises";
import type { CampCli, CampDetect, FestCli } from "../../ports.js";
import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { claimFestivalOwnership } from "../../application/festival-ownership.js";
import { LoopTracker } from "../../application/loop-tracker.js";
import { FESTIVAL_CLAIM_ENTRY } from "../../application/session-claim.js";
import { sessionIdOf } from "../../application/session-id.js";
import { resolveWorkingDir, stampWorkingDir } from "../../application/sequence-goals.js";
import { festivalConstraints, seedFestivalRules, stampGateRules } from "../../application/festival-rules.js";
import { recordVisualEvidence, visualEvidenceStatus, type VisualEvidence } from "../../application/visual-evidence.js";
import { applyReferenceRevision, findReuseCandidates, inspectReferenceRevision, renderPlanPreview } from "../../application/visual-plan-review.js";
import { installVisualReferences, prepareVisualReferences, referencesForTask, taskChecks, validateVisualReferences } from "../../application/visual-references.js";
import { createWireframe, WireframeInputError, type WireframeSpec } from "../../application/visual-wireframe.js";
import { structuredPlanSchema, type StructuredPlan } from "../../application/structured-plan.js";
import { normalizePlanInput } from "../../application/plan-input.js";
import { approvedPlan, markPlanScaffolded, previewPlan, type ApprovedPlan } from "../../application/plan-artifacts.js";
import { finalizeApprovedScaffold } from "../../application/plan-scaffold.js";
import { createPlanDraft, readPlanDraft, updatePlanDraft, listPlanDrafts, type PlanDraftFields } from "../../application/plan-drafts.js";
import { findPlanningConflicts } from "../../application/planning-conflicts.js";
import { classifyAttachment, type AttachmentRole } from "../../domain/reference-classification.js";
import { DEFAULT_CONFIG, type NextUnit, type OmpFestConfig } from "../../domain/types.js";
import { showCard, type OverlayUiLike } from "./overlay.js";
import { BROWSER_VERIFICATION_POLICY } from "../../domain/orientation.js";
import type { ZodLike } from "./zod-types.js";
import { Supervisor, SUPERVISOR_POLICY } from "../../application/supervisor.js";
import { registerSupervisorTools } from "./supervisor-tools.js";
import { registerQualityTools } from "./quality-tools.js";
import { INTEGRATION_GUIDE, integrationReviewStatus } from "../../application/integration-review.js";
import { planningDiagnostic } from "../../application/planning-errors.js";
import { registerFlowTools, type FlowHost } from "./flow-tools.js";

export interface ToolDeps {
  fest: FestCli;
  camp: CampCli;
  detect: CampDetect;
  tracker: LoopTracker;
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
    received: diagnostic.message,
    error: diagnostic.message,
    diagnostics: [diagnostic],
    nextAction: diagnostic.nextAction,
    ...extra,
  });
}



async function interactivePlanReview(
  ctx: ToolContextLike,
  payload: Record<string, unknown>,
): Promise<ToolResult> {
  const ui = ctx.ui;
  if (!ui || typeof ui.confirm !== "function") {
    return textResult({
      ...payload,
      approval: "awaiting_human",
      nextSteps: "Present this proposal to the human and wait for approval. Then call action:'scaffold' with approvedRevision; do not supply spec.",
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
    "Approve creates an immutable revision for scaffolding. Reject keeps the repository unchanged.",
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
    return textResult({
      ...payload,
      approval: "approved",
      nextSteps: "Plan approved. Call action:'scaffold' with this planRevision and omit spec.",
    });
  }
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
): Promise<{ dir: string } | { result: ToolResult }> {
  const resolved = await festivalDirOf(deps, ctx, selector);
  if (resolved.error) {
    return { result: textResult(resolved.error) };
  }
  if (!resolved.dir) {
    return { result: await idleResult(deps, ctx) };
  }
  const ownership = await claimFestivalOwnership(resolved.dir, sessionIdOf(ctx));
  if (ownership.kind !== "claimed") {
    return {
      result: textResult({
        kind: "festival_owned",
        festival: basename(resolved.dir),
        owner: ownership.owner?.sessionId,
        hint: "This festival belongs to another omp session. Use /fest select <id> and confirm ownership transfer; no work was started.",
      }),
    };
  }
  // This session touched this festival — later digests/tracking key off it so
  // parallel agents on different festivals don't see each other's pick.
  if (deps.tracker.claimFestival(sessionIdOf(ctx), resolved.dir)) {
    persistClaim(pi, resolved.dir, resolved.campRoot);
  }
  return { dir: resolved.dir };
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
      ? "Select a festival first with /fest select <id> (ownership transfer requires confirmation), or use festival:<id> explicitly. For brand-new work, use /fest idea → /fest plan. Never run `fest`/`camp` via shell — use the fest_*/camp_* tools."
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
  registerSupervisorTools(pi, deps, supervisor);
  registerQualityTools(pi, { ...deps, supervisor });


  pi.registerTool({
    name: "fest_next",
    label: "Fest Next",
    description:
      "Get the next unit of work in the current festival (task, workflow step, gate step, blocked, or complete), including linked visual reference notes and wireframe paths for page tasks. This is the engine of the festival loop — call it, do what it returns, then call it again.",
    parameters: z.object({ festival: z.string().optional().describe("Festival name/id override") }),
    async execute(_id: string, params: { festival?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      const dir = r.dir;
      const unit: NextUnit = await deps.fest.next(dir);
      if (unit.kind === "task") {
        const visual = await validateVisualReferences(dir, deps.detect);
        if (visual.issues.length > 0) {
          return textResult({ kind: "blocked", errors: visual.issues, hint: "Fix the visual references and task links, then call fest_next again." });
        }
        const visualReferences = await referencesForTask(dir, unit.doc);
        const sid = sessionIdOf(ctx);
        const stale = deps.tracker.unfinishedFor(sid) ? deps.tracker.openTaskPathFor(sid) : undefined;
        deps.tracker.taskOpened(sid, unit.path);
        if (stale) {
          return textResult({
            ...unit,
            browserVerification: BROWSER_VERIFICATION_POLICY,
            supervisor: SUPERVISOR_POLICY,
            ...(visualReferences.length > 0 ? { visualReferences } : {}),
            warning: `Previous unit ${stale} was opened but never completed+committed — the work record is stale. Finish its fest_task_complete/fest_commit before starting this one.`,
          });
        }
        return textResult({
          ...unit,
          browserVerification: BROWSER_VERIFICATION_POLICY,
          supervisor: SUPERVISOR_POLICY,
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
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      const dir = r.dir;
      const sid = sessionIdOf(ctx);
      const opened = deps.tracker.openTaskPathFor(sid);
      const visual = await validateVisualReferences(dir, deps.detect);
      if (visual.issues.length) {
        return textResult({ kind: "completion_blocked", issues: visual.issues });
      }
      const current = !params.task && !opened && visual.pages.length ? await deps.fest.next(dir) : undefined;
      const requestedTaskPath = params.task ?? opened ?? (current?.kind === "task" ? current.path : undefined);
      const taskPath = requestedTaskPath ? festivalRelativeTaskPath(dir, requestedTaskPath) : undefined;
      if (requestedTaskPath && !taskPath) {
        return textResult({ kind: "completion_blocked", task: requestedTaskPath, hint: "Task path must resolve inside the selected festival." });
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
        return textResult({ kind: "completion_blocked", hint: "Use a valid task path returned by fest_next so its visual checks can be verified." });
      }
      if (taskDoc && completionPath) {
        const checks = taskChecks(taskDoc);
        if (checks.length > 0) {
          try {
            const proposed = params.visualEvidence ?? [];
            if (proposed.some((entry) => entry.status === "failed")) {
              return textResult({ kind: "completion_blocked", hint: "Fix failed visual checks before marking the task completed." });
            }
            await recordVisualEvidence(dir, completionPath, taskDoc, proposed);
          } catch (error) {
            return textResult({ kind: "completion_blocked", error: String(error), hint: "Provide evidence for each task acceptance check, or mark it untested for human review." });
          }
        }
      }
      const assignments = supervisor.state(sessionIdOf(ctx)).workers.filter((worker) =>
        worker.festival === basename(dir) && worker.task === (task?.path ?? taskPath));
      if (assignments.some((worker) => worker.status !== "accepted")) {
        return textResult({ kind: "completion_blocked", hint: "Worker submission requires independent supervisor review and acceptance before festival completion." });
      }
      const completion = await deps.fest.taskComplete(dir, task?.path ?? taskPath ?? "", params.evidence);
      if (!completion.ok) {
        return textResult({
          status: "completion_blocked",
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
    description: "Update task progress or state: percent, blocked, defer, unblock, or reset.",
    parameters: z.object({
      action: z.enum(["blocked", "defer", "unblock", "reset", "update"]),
      task: z.string().optional(),
      reason: z.string().optional(),
      percent: z.string().optional(),
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { action: "blocked" | "defer" | "unblock" | "reset" | "update"; task?: string; reason?: string; percent?: string; festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
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
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      if (supervisor.state(sessionIdOf(ctx)).workers.some((worker) => worker.status !== "accepted")) {
        return textResult({ kind: "commit_blocked", hint: "Outstanding workers may have unfinished shared-checkout changes. Review and settle all assignments before committing." });
      }
      const hash = await deps.fest.commit(r.dir, params.message);
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
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      const structure = await deps.fest.validate(r.dir, params.fix);
      const visual = await validateVisualReferences(r.dir, deps.detect);
      const verification = visual.issues.length ? undefined : await visualEvidenceStatus(r.dir, deps.detect);
      return textResult({ ...structure, visualReferences: visual, ...(verification ? { visualVerification: verification } : {}),
        ...(visual.issues.length > 0 || (verification?.issues.length ?? 0) > 0 ? { kind: "validation_failed" } : {}) });
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
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
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
        if (currentReferences.issues.length || currentEvidence?.issues.length || JSON.stringify(currentEvidence) !== JSON.stringify(verification)) {
          return textResult({ kind: "gate_blocked", issues: [...currentReferences.issues, ...(currentEvidence?.issues ?? [])],
            hint: "References or evidence changed during review; verify them again." });
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
      return textResult({ status: "rejected", reason, output });
    },
  });


  pi.registerTool({
    name: "fest_plan",
    label: "Fest Plan (Scaffold From Plan)",
    description:
      "Single stateful planning API. Use action create/update/read/list for persisted incremental drafts, preview for review, and scaffold only after the human approves planRevision. Draft fields stay server-side; update only changed fields. Creation is independent of existing festival ownership. Attachment role must be explicit; only ui_design can supply visual references.",
    parameters: z.object({
      action: z.enum(["create", "read", "update", "list", "preview", "scaffold"]).optional(),
      name: z.string().optional(), plan: z.string().optional(), draftId: z.string().optional(), draftRevision: z.string().optional(),
      goal: z.string().optional(), scope: z.array(z.string()).optional(), exclusions: z.array(z.string()).optional(),
      acceptance: z.array(z.string()).optional(), inspection: z.array(z.object({ path: z.string(), reason: z.string() })).optional(),
      workingDir: z.string().optional(), files: z.array(z.string()).optional(), rules: z.string().optional(),
      verification: z.object({ command: z.string(), cwd: z.string().optional(), evidencePath: z.string(), expected: z.string() }).optional(),
      attachments: z.array(z.object({ name: z.string(), description: z.string(), role: z.enum(["ui_design", "error_screenshot", "document_pdf", "context", "unknown"]).optional() })).optional(),
      spec: structuredPlanSchema(z).optional(), approvedRevision: z.string().optional(), referencesDir: z.string().optional(),
      visualIntent: z.enum(["ui_visual", "document_or_pdf", "backend_or_api", "bug_diagnostic", "mixed", "unknown"]).optional(),
      referenceAction: z.enum(["preview", "revise"]).optional(), festival: z.string().optional(),
      baseRevision: z.string().optional(), proposalRevision: z.string().optional(),
      conflictChoice: z.enum(["sequence", "narrow", "worktree"]).optional().describe("Human-selected resolution after planning_conflict: sequence overlapping tasks, narrow one scope, or use a separate worktree"),
    }),
    async execute(_id: string, params: { action?: "create" | "read" | "update" | "list" | "preview" | "scaffold"; name?: string; plan?: string; draftId?: string; draftRevision?: string; goal?: string; scope?: string[]; exclusions?: string[]; acceptance?: string[]; inspection?: { path: string; reason: string }[]; workingDir?: string; files?: string[]; rules?: string; verification?: PlanDraftFields["verification"]; attachments?: { name: string; description: string; role?: AttachmentRole }[]; spec?: StructuredPlan; approvedRevision?: string; referencesDir?: string; visualIntent?: PlanDraftFields["visualIntent"]; referenceAction?: "preview" | "revise"; festival?: string; baseRevision?: string; proposalRevision?: string; conflictChoice?: "sequence" | "narrow" | "worktree" }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const root = await campRootOf(deps, ctx);
      if (!root) {
        return await idleResult(deps, ctx);
      }
      const draftAction = params.action;
      if (draftAction === "list") {
        return textResult({ kind: "plan_drafts", drafts: (await listPlanDrafts(root)).map(({ draftId, revision, fields, missing }) => ({ draftId, revision, name: fields.name, goal: fields.goal, missing })) });
      }
      if (draftAction === "read") {
        try { return textResult({ kind: "plan_draft", ...await readPlanDraft(root, params.draftId ?? "") }); }
        catch (error) { return planFailure(error, { field: "draftId" }); }
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
            ...(attachments ? { attachments } : {}),
          } satisfies Partial<PlanDraftFields>;
          const project = patch.workingDir || draftAction === "create" ? await resolveWorkingDir(root, deps.camp, patch.workingDir) : undefined;
          if (project?.dir) patch = { ...patch, workingDir: project.dir };
          const draft = draftAction === "create"
            ? await createPlanDraft(root, { ...patch, name: params.name ?? "" })
            : await updatePlanDraft(root, params.draftId ?? "", params.draftRevision ?? "", patch);
          return textResult({ kind: draft.missing.length ? "plan_draft_incomplete" : "plan_draft", draftId: draft.draftId, revision: draft.revision, name: draft.fields.name, goal: draft.spec.goal, missing: draft.missing, attachments: draft.fields.attachments, nextAction: draft.missing.length ? "Ask only for listed missing decisions, then update this draft with its current revision." : `Call fest_plan {action:"preview",draftId:"${draft.draftId}",draftRevision:"${draft.revision}"}.` });
        } catch (error) { return planFailure(error); }
      }
      if (params.draftId) {
        try {
          if (params.action !== "preview" || params.spec) throw new Error("draftId is for persisted preview; omit spec");
          const draft = await readPlanDraft(root, params.draftId);
          if (draft.revision !== params.draftRevision) throw new Error("Draft changed; read current draft and approve the new revision");
          if (draft.missing.length) throw new Error(`Draft is incomplete: ${draft.missing.join(", ")}`);
          params = { ...params, name: draft.fields.name, plan: draft.plan, spec: draft.spec, workingDir: draft.fields.workingDir, rules: draft.fields.rules, referencesDir: draft.fields.referencesDir ? resolve(root, draft.fields.referencesDir) : undefined, visualIntent: draft.fields.visualIntent, attachments: draft.fields.attachments?.map((item) => ({ name: item.name, description: item.reason, role: item.role })) };
        } catch (error) { return planFailure(error); }
      }
      if (!params.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(params.name)) return planFailure("name must be a lowercase festival slug", { field: "name" });
      params.plan ??= join(root, ".ompfest", "plans", `${params.name}.STRUCTURE.md`);
      const canonicalPlan = join(root, ".ompfest", "plans", `${params.name}.STRUCTURE.md`);
      const planPath = resolve(params.plan) === resolve(canonicalPlan) ? params.plan : canonicalPlan;
      const planWarnings = params.plan === planPath ? [] : [`plan was normalized to ${planPath}`];
      if (params.action && params.referenceAction) return planFailure("Use action for the full plan preview/scaffold flow, or referenceAction for an existing reference revision—not both.");
      if (!params.action && !params.referenceAction) return planFailure("Choose action:'preview' with a structured spec, then action:'scaffold' with the human-approved planRevision.");
      if (params.action === "preview" && !params.spec) return planFailure("Plan preview requires a structured spec.", { code: "MISSING_SPEC", field: "spec" });
      if (params.action === "scaffold" && (!params.approvedRevision || params.spec)) return planFailure("Scaffolding requires the human-approved planRevision and must omit spec.", { code: "INVALID_SCAFFOLD_INPUT" });
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
          let conflictChoice = params.conflictChoice;
          if (conflicts.length && !conflictChoice && ctx.ui?.select) {
            const answer = await ctx.ui.select("Overlapping festival plans", [
              "sequence — keep both plans; execute overlapping files one at a time",
              "narrow — revise file scope, then preview again",
              "worktree — target an isolated project worktree and preview again",
            ]);
            conflictChoice = answer?.startsWith("sequence") ? "sequence" : answer?.startsWith("narrow") ? "narrow" : answer?.startsWith("worktree") ? "worktree" : undefined;
          }
          if (conflicts.length && !conflictChoice) return textResult({ kind: "planning_conflict", conflicts, choices: ["sequence", "narrow", "worktree"], nextAction: "Ask the human to choose; no plan artifact was written and no existing plan was changed or cancelled. Retry preview with conflictChoice." });
          if (conflicts.length && conflictChoice === "narrow") return textResult({ kind: "planning_conflict", conflicts, resolution: "narrow", nextAction: "Revise the draft/spec to remove overlapping files, then preview again. Existing plans remain unchanged." });
          if (conflicts.length && conflictChoice === "worktree") return textResult({ kind: "planning_conflict", conflicts, resolution: "worktree", nextAction: "Choose an isolated worktree as workingDir, then preview again. This tool does not create or transfer a worktree." });
          const rules = conflicts.length ? [params.rules?.trim(), `Planning conflict decision: sequence overlapping files ${conflicts.map((conflict) => `${conflict.name} (${conflict.files.join(", ")})`).join("; ")} one at a time. Keep all plans; never cancel another plan.`].filter(Boolean).join("\n") : params.rules ?? "";
          const prepared = await previewPlan(root, planPath, {
            name: params.name, workingDir: project.dir, rules,
            ...(params.referencesDir ? { referencesDir: params.referencesDir } : {}), spec: normalized.spec,
          }, bundle?.files);
          const visual = bundle ? await renderPlanPreview(prepared.plan, bundle) : undefined;
          const reuseCandidates = bundle ? await findReuseCandidates(root, project.dir, bundle) : [];
          return await interactivePlanReview(ctx, {
            kind: "plan_preview", plan: prepared.plan, preview: prepared.preview, previewFile: prepared.previewFile,
            counts: prepared.counts, planRevision: prepared.planRevision, reuseCandidates,
            ...(planWarnings.length || normalized.warnings.length ? { warnings: [...planWarnings, ...normalized.warnings] } : {}),
            ...(visual ? { visualPreview: visual } : {}),
          });
        } catch (error) {
          return planFailure(error);
        }
      }
      if (params.action === "scaffold") {
        try {
          const revision = params.approvedRevision;
          if (!revision) throw new Error("Scaffolding requires the human-approved planRevision.");
          const normalizedWorkingDir = params.workingDir
            ? (await resolveWorkingDir(root, deps.camp, params.workingDir)).dir
            : undefined;
          approved = await approvedPlan(root, planPath, params.name, revision, bundle?.files);
          if (approved.artifact.name !== params.name ||
              approved.artifact.referencesDir !== params.referencesDir ||
              (normalizedWorkingDir !== undefined && approved.artifact.workingDir !== normalizedWorkingDir) ||
              (params.rules !== undefined && approved.artifact.rules !== params.rules)) {
            throw new Error("Scaffold options differ from the approved preview. Preview the changes before scaffolding.");
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
      const output = await deps.fest.scaffoldFromPlan(root, { plan: planPath, name: params.name, dest: "planning" });
      deps.detect.bustCache?.();
      const parsed = parseScaffoldPlanResult(output);
      if (parsed?.ok !== true || !hasCounts(parsed) || !matchesApproved(parsed)) {
        return textResult({ kind: "plan_failed", error: parsed?.error ?? "Scaffold differs from the approved plan. Files retained; do not promote.", expected: approved.counts, output });
      }
      const festId = parsed.festival_dir ? basename(parsed.festival_dir) : params.name;
      const festivalDir = parsed.festival_dir;
      if (!festivalDir) {
        return textResult({ kind: "plan_failed", error: "Scaffold did not report a festival directory; generated files were retained.", output });
      }
      const { dir: workingDir, candidates: projectCandidates } = await resolveWorkingDir(
        root,
        deps.camp,
        targetWorkingDir,
      );
      let stamped = 0;
      let gateRules = 0;
      try {
        await finalizeApprovedScaffold(root, festivalDir, approved.artifact);
      } catch (error) {
        return textResult({ kind: "plan_failed", error: String(error), festivalDir, hint: "Scaffold differs from the approved structure. Files retained; repair before promotion." });
      }
      if (bundle) {
        try {
          await installVisualReferences(festivalDir, bundle);
        } catch (error) {
          return textResult({ kind: "plan_failed", festivalDir, error: String(error), hint: "The festival was scaffolded but references were not installed. Repair its references before validation or promotion." });
        }
      }
      if (workingDir) {
        stamped = await stampWorkingDir(festivalDir, workingDir);
      }
      // FESTIVAL_RULES.md: `fest rules` reads it, validate recommends it,
      // and scaffold never writes it — the human's constraints live here.
      const rulesSeed = await seedFestivalRules(root, festivalDir, agreedRules);
      const gates = await deps.fest
        .gatesApply(root, festivalDir)
        .catch((err: unknown) => ({ created: 0, output: `gates apply failed: ${String(err)}` }));
      if (rulesSeed.constraints) {
        gateRules = await stampGateRules(festivalDir);
      }
      const scaffoldValidation = await deps.fest.validate(festivalDir);
      if (scaffoldValidation.score !== 100) {
        return planFailure("Generated scaffold did not pass validation; retained for repair, not activation", { festivalDir, score: scaffoldValidation.score, validation: scaffoldValidation.output.slice(0, 2000) });
      }
      try {
        await markPlanScaffolded(root, planPath, params.name, approved.planRevision, festivalDir, bundle?.files);
      } catch (error) {
        return textResult({ kind: "plan_failed", error: `Festival scaffold passed validation, but plan lifecycle state could not be recorded: ${String(error)}`, festivalDir, hint: "The festival exists. Preserve it and inspect .ompfest/plans status before retrying." });
      }
      const skipped = gates.output.match(/Skipping sequence "[^"]+"/g) ?? [];
      const needsWorkingDir = !workingDir;
      return textResult({
        kind: "plan_scaffolded",
        planRevision: approved.planRevision,
        counts: {
          phases: parsed.phases_created,
          sequences: parsed.sequences_created,
          tasks: parsed.tasks_created,
        },
        festivalDir,
        ...(bundle ? { visualReferences: bundle.pages.map((page) => `references/pages/${page}/PAGE.md`) } : {}),
        rules: { ...rulesSeed, gateFilesStamped: gateRules },
        ...(workingDir ? { workingDir, sequencesStamped: stamped } : {}),
        qualityGates: gates,
        validation: { score: scaffoldValidation.score },
        ...(skipped.length > 0
          ? {
              gateSkippedSequences: skipped,
              gateSkippedHint:
                "fest excludes sequences named *_planning/*_research/*_requirements/*_docs from quality gates. If these sequences do real implementation work, rename the sequence dirs (and their fest_id/fest_name frontmatter) — otherwise the skip is intentional.",
            }
          : {}),
        ...(needsWorkingDir
          ? {
              needsWorkingDir: true,
              projects: projectCandidates,
              hint: "Multiple projects in this camp — no workingDir given, so sequences have NO fest_working_dir and fest_next will fail validation. Ask the human which project this festival targets, then run fest_raw {args:['scaffold'], festival:<id>} — or write fest_working_dir: \"projects/<name>\" into each sequence's SEQUENCE_GOAL.md frontmatter.",
            }
          : {}),
        nextSteps: [
          ...(bundle ? ["Link each relevant task doc with 'Visual reference: references/pages/<page>/PAGE.md' and component-level Done-When checks; fest_validate will reject unlinked pages."] : []),
          `Run fest_validate {festival:"${festId}"} — generated contract documents must contain zero template markers and valid camp-relative working directories`,
          "Generated documents have already been validated. If scope or acceptance changes, obtain new approval before promotion.",
          `fest_promote {festival:"${festId}"} twice: planning -> ready -> active`,
        ],
      });
    },
  });
  pi.registerTool({
    name: "fest_wireframe_create",
    label: "Create Screenshot Wireframe",
    description:
      "Create a categorized wireframe.svg and PAGE.md only for an explicitly classified UI design reference. " +
      "Never use error screenshots, PDFs/documents, backend evidence, context, or unknown-role images as wireframe input. " +
      "If the attachment role is ambiguous, ask the user before calling this tool.",
    parameters: z.object({
      attachmentRole: z.enum(["ui_design", "error_screenshot", "document_pdf", "context", "unknown"]).describe("Role explicitly classified from the user's request; only ui_design may generate a wireframe"),
      outputDirectory: z.string().describe("Path inside the current project working directory; do not use ../ traversal, e.g. .ompfest/plans/page.references/pages/results"),
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
    async execute(_id: string, params: { outputDirectory: string; attachmentRole: "ui_design" | "error_screenshot" | "document_pdf" | "context" | "unknown"; spec: WireframeSpec }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      if (params.attachmentRole !== "ui_design") return textResult({ kind: "wireframe_blocked", code: "NOT_UI_DESIGN", field: "attachmentRole", expected: "ui_design", received: params.attachmentRole, nextAction: "Keep this attachment as evidence; ask the user if the attachment role is ambiguous. Do not produce a wireframe." });
      try {
        const result = await createWireframe(params.outputDirectory, ctx.cwd, params.spec);
        return textResult({ kind: "wireframe_created", ...result });
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
      const location = await deps.detect.locate(ctx.cwd);
      const sid = sessionIdOf(ctx);
      if (params.festival) {
        if (!location.campRoot) {
          return await idleResult(deps, ctx);
        }
        const candidate = matchFestival(await deps.detect.listFestivals(location.campRoot), params.festival);
        if (candidate.kind === "match") {
          const ownership = await claimFestivalOwnership(candidate.festival.path, sid);
          if (ownership.kind !== "claimed") {
            return textResult({ kind: "festival_owned", festival: candidate.festival.id, owner: ownership.owner?.sessionId, hint: "Select and explicitly transfer this festival before promoting it." });
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
        return textResult({ kind: "promoted", output, nextSteps: SUPERVISOR_POLICY });
      }
      const dir =
        location.festivalDir ??
        (location.campRoot
          ? await claimedFestivalDir(deps.tracker, deps.detect, sid, location.campRoot)
          : undefined) ??
        (location.campRoot ? await deps.detect.activeFestival(location.campRoot) : undefined);
      if (!dir) {
        return await idleResult(deps, ctx);
      }
      const ownership = await claimFestivalOwnership(dir, sid);
      if (ownership.kind !== "claimed") {
        return textResult({ kind: "festival_owned", festival: basename(dir), owner: ownership.owner?.sessionId, hint: "Select and explicitly transfer this festival before promoting it." });
      }
      const visual = await validateVisualReferences(dir, deps.detect);
      if (visual.issues.length > 0) {
        return textResult({ kind: "promotion_blocked", issues: visual.issues });
      }
      const promotedId = basename(dir);
      const output = await deps.fest.promote(dir);
      deps.detect.bustCache?.();
      // The promote renamed festivals/<status>/<id> — re-point the claim at the new dir.
      if (location.campRoot && deps.tracker.claimedFestivalIdFor(sid) === promotedId) {
        const moved = (await deps.detect.listFestivals(location.campRoot)).find((f) => f.id === promotedId);
        if (moved && deps.tracker.claimFestival(sid, moved.path)) {
          persistClaim(pi, moved.path, location.campRoot);
        }
      }
      return textResult({ kind: "promoted", output, nextSteps: SUPERVISOR_POLICY });
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
      "List candidate pending tasks grouped by sequence. Different sequences are not automatically parallel-safe: check dependency eligibility and file overlap through fest_supervisor before bounded subagent dispatch.",
    parameters: z.object({ festival: z.string().optional().describe("Festival name/id override") }),
    async execute(_id: string, params: { festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      const tasks = await deps.detect.pendingTasks(r.dir);
      const visual = await validateVisualReferences(r.dir, deps.detect);
      if (visual.issues.length > 0) {
        return textResult({ kind: "parallel_blocked", issues: visual.issues });
      }
      const pending = tasks.filter((t) => !t.done);
      const groups = new Map<string, string[]>();
      const laneReferences = new Map<string, Awaited<ReturnType<typeof referencesForTask>>>();
      for (const task of pending) {
        const list = groups.get(task.sequence) ?? [];
        list.push(task.path);
        groups.set(task.sequence, list);
        const doc = await readFile(join(r.dir, task.path), "utf8");
        const refs = await referencesForTask(r.dir, doc);
        const existing = laneReferences.get(task.sequence) ?? [];
        laneReferences.set(task.sequence, [...existing, ...refs.filter((ref) => !existing.some((item) => item.page === ref.page))]);
      }
      return textResult({
        hint: SUPERVISOR_POLICY,
        lanes: [...groups.entries()].map(([sequence, files]) => ({
          sequence, tasks: files, visualReferences: laneReferences.get(sequence) ?? [],
          browserVerification: BROWSER_VERIFICATION_POLICY,
        })),
        pendingCount: pending.length,
        totalCount: tasks.length,
      });
    },
  });

  pi.registerTool({
    name: "fest_raw",
    label: "Fest Raw",
    description:
      "Run ANY `fest` subcommand not covered by the typed tools (list, rules, context, show, markers, " +
      "workflow, chain, feedback, promote, types, watch, deps, parse, tokens, links, ...) at the resolved " +
      "festival or camp directory. task mutations get --yes auto-injected. Returns {code, stdout, stderr} " +
      "and never throws — check code before trusting output.",
    parameters: z.object({
      args: z.array(z.string()).describe("fest args, e.g. ['list','--json'] or ['workflow','status']"),
      festival: z.string().optional().describe("Festival dir/name override when at camp root"),
    }),
    async execute(_id: string, params: { args: string[]; festival?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
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
      cwd ??= location.campRoot ? await deps.detect.activeFestival(location.campRoot) : undefined;
      cwd ??= location.campRoot;
      if (!cwd) {
        return await idleResult(deps, ctx);
      }
      const result = await deps.fest.raw(cwd, params.args);
      return textResult(result);
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
  registerFlowTools(pi, { detect: deps.detect, host: deps.host });
}
