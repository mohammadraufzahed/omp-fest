/**
 * Model-callable fest_* / camp_* tools. Each is a thin mapping from a zod
 * schema to a port call — the agent gets typed results, never raw prose.
 *
 * The wiring is intentionally table-driven: TOOL_SPECS describes the tools
 * once, registerTools() adapts them onto whatever ExtensionAPI shape the
 * runtime hands us (kept loose-typed here so the module compiles without the
 * coding-agent package installed).
 */
import { basename, join } from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import type { CampCli, CampDetect, FestCli } from "../../ports.js";
import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { LoopTracker } from "../../application/loop-tracker.js";
import { FESTIVAL_CLAIM_ENTRY } from "../../application/session-claim.js";
import { sessionIdOf } from "../../application/session-id.js";
import { resolveWorkingDir, stampWorkingDir } from "../../application/sequence-goals.js";
import { festivalConstraints, seedFestivalRules, stampGateRules } from "../../application/festival-rules.js";
import { recordVisualEvidence, visualEvidenceStatus, type VisualEvidence } from "../../application/visual-evidence.js";
import { applyReferenceRevision, findReuseCandidates, inspectReferenceRevision, renderPlanPreview } from "../../application/visual-plan-review.js";
import { installVisualReferences, prepareVisualReferences, referencesForTask, taskChecks, validateVisualReferences } from "../../application/visual-references.js";
import { createWireframe, type WireframeSpec } from "../../application/visual-wireframe.js";
import { DEFAULT_CONFIG, type NextUnit, type OmpFestConfig } from "../../domain/types.js";
import { showCard, type OverlayUiLike } from "./overlay.js";
import type { ZodLike } from "./zod-types.js";

export interface ToolDeps {
  fest: FestCli;
  camp: CampCli;
  detect: CampDetect;
  tracker: LoopTracker;
  /** Per-project .ompfest.json — gate behavior honors pauseAtGates/evidenceRequiredOnGates. */
  config?: () => Promise<OmpFestConfig>;
}

export interface PiLike {
  zod: ZodLike;
  registerTool(tool: Record<string, unknown>): void;
  /** Persists a custom session entry — the claim survives resume/branch/tree. */
  appendEntry?(customType: string, data: unknown): void;
}

interface ToolContextLike {
  cwd: string;
  sessionManager?: { getSessionId?(): string };
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

function textResult(payload: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) },
    ],
  };
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
  // cwd inside a festival > this session's claimed festival > the camp-wide
  // active pick. The claim is what lets two agents in one camp work two
  // different festivals without stealing each other's target.
  const dir =
    location.festivalDir ??
    (location.campRoot
      ? await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), location.campRoot)
      : undefined) ??
    (location.campRoot ? await deps.detect.activeFestival(location.campRoot) : undefined);
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
      ? "Choose one of the listed festivals (/fest next <id> or pass festival:<id> to the fest_* tools) or, for brand-new work, the planning flow (/fest idea → /fest plan). Never run `fest`/`camp` via shell — use the fest_*/camp_* tools."
      : "No festival exists in this camp yet — brand-new work starts with the planning flow (/fest idea → /fest plan <goal>). Never run `fest`/`camp` via shell — use the fest_*/camp_* tools.",
  });
}

export function registerTools(pi: PiLike, deps: ToolDeps): void {
  const z = pi.zod;

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
            ...(visualReferences.length > 0 ? { visualReferences } : {}),
            warning: `Previous unit ${stale} was opened but never completed+committed — the work record is stale. Finish its fest_task_complete/fest_commit before starting this one.`,
          });
        }
        return textResult({ ...unit, ...(visualReferences.length > 0 ? { visualReferences } : {}) });
      }
      return textResult(unit);
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
      const taskPath = params.task ?? opened ?? (current?.kind === "task" ? current.path : undefined);
      const task = taskPath ? (await deps.detect.pendingTasks(dir)).find((item) => item.path === taskPath) : undefined;
      if (visual.pages.length && !task) {
        return textResult({ kind: "completion_blocked", hint: "Use the exact festival-relative task path returned by fest_next so its visual checks can be verified." });
      }
      if (task) {
        const doc = await readFile(join(dir, task.path), "utf8");
        const checks = taskChecks(doc);
        if (checks.length > 0) {
          try {
            const proposed = params.visualEvidence ?? [];
            if (proposed.some((entry) => entry.status === "failed")) {
              return textResult({ kind: "completion_blocked", hint: "Fix failed visual checks before marking the task completed." });
            }
            await recordVisualEvidence(dir, task.path, doc, proposed);
          } catch (error) {
            return textResult({ kind: "completion_blocked", error: String(error), hint: "Provide evidence for each task acceptance check, or mark it untested for human review." });
          }
        }
      }
      const completion = await deps.fest.taskComplete(dir, task?.path ?? params.task ?? "", params.evidence);
      if (!completion.ok) {
        return textResult({
          status: "completion_blocked",
          task: params.task,
          output: completion.output,
          hint: "fest refused the completion — quality gates run first. Read the output, fix what it demands, then retry.",
        });
      }
      deps.tracker.taskCompleted(sid);
      return textResult({
        status: "completed",
        task: params.task,
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
      "Commit changes through fest (auto-tags the message with [camp:festival]). Use instead of git commit inside linked projects so the work record stays truthful.",
    parameters: z.object({
      message: z.string().describe("Commit message (task reference is added automatically)"),
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { message: string; festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
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
      "Generate a festival from a STRUCTURE.md plan doc the model wrote after interviewing the human. " +
      "Runs `fest scaffold from-plan --dest planning`, stamps fest_working_dir into every sequence " +
      "(the scaffold omits it and fest_next refuses without it), seeds FESTIVAL_RULES.md from the " +
      "camp template plus any constraints the human stated (pass rules:), and applies quality gates. " +
      "Optional referencesDir installs the matching .references directory beside the STRUCTURE.md as festival references. " +
      "Pass workingDir (camp-relative project path) — ask the human during the interview when the " +
      "camp has multiple projects. Fails loudly when the plan doc scaffolded zero sequences.",
    parameters: z.object({
      name: z.string().describe("Festival name/slug, e.g. 'prenatal-form-groups'"),
      plan: z.string().describe("Absolute path to the STRUCTURE.md plan document"),
      workingDir: z.string().optional().describe("Camp-relative project dir the festival targets, e.g. 'projects/api' — required when the camp has multiple projects"),
      rules: z.string().optional().describe("Constraints/rules the human agreed to during planning, as bullet lines — written verbatim into FESTIVAL_RULES.md so fest rules shows them"),
      referencesDir: z.string().optional().describe("Absolute <camp>/.ompfest/plans/<name>.references directory containing pages/<slug>/PAGE.md and wireframe.svg"),
      dryRun: z.boolean().optional().describe("Preview without creating files"),
      referenceAction: z.enum(["preview", "revise"]).optional().describe("preview renders the approved wireframe/notes and revision impact without scaffolding; revise updates an existing festival's references only after human approval"),
      festival: z.string().optional().describe("Existing festival selector for reference previews/revisions; omit for an initial plan preview"),
      baseRevision: z.string().optional().describe("Original reference digest from the approved revision preview"),
      proposalRevision: z.string().optional().describe("Proposed reference digest from the approved revision preview"),
    }),
    async execute(_id: string, params: { name: string; plan: string; workingDir?: string; rules?: string; referencesDir?: string; dryRun?: boolean; referenceAction?: "preview" | "revise"; festival?: string; baseRevision?: string; proposalRevision?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const root = await campRootOf(deps, ctx);
      if (!root) {
        return await idleResult(deps, ctx);
      }
      let bundle;
      if (params.referencesDir) {
        try {
          bundle = await prepareVisualReferences(root, params.plan, params.referencesDir);
        } catch (error) {
          return textResult({ kind: "plan_failed", error: String(error), hint: "Fix the visual bundle before scaffolding." });
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
            const preview = await renderPlanPreview(params.plan, bundle);
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
      const output = await deps.fest.scaffoldFromPlan(root, params);
      deps.detect.bustCache?.();
      let parsed: { ok?: boolean; error?: string; festival_dir?: string } | undefined;
      try {
        parsed = JSON.parse(output) as typeof parsed;
      } catch {
        parsed = undefined;
      }
      if (parsed?.ok === false) {
        return textResult({
          kind: "plan_failed",
          error: parsed.error ?? output,
          hint:
            "The STRUCTURE.md didn't parse. Rewrite it to the exact shape — '# Festival Structure' / " +
            "'## Festival Goal' / '## Hierarchy' headers, then list items: '- **Festival:** name', " +
            "'  - **Phase 1:** name (type)', '    - Sequence 1: name', '      - Task 1: title' — then call fest_plan again.",
        });
      }
      const festId = parsed?.festival_dir ? basename(parsed.festival_dir) : params.name;
      const festivalDir = parsed?.festival_dir;
      if (bundle && !festivalDir && params.dryRun !== true) {
        return textResult({ kind: "plan_failed", error: "Scaffold did not report a festival directory; visual references were not installed", output });
      }
      if (festivalDir && params.dryRun !== true) {
        const sequences = await readdir(festivalDir).catch(() => [] as string[]);
        const hasWork = sequences.some((phase) => /^\d{3}_/.test(phase));
        if (!hasWork) {
          // The doc didn't match the STRUCTURE.md grammar — fest scaffolds an
          // empty festival but still reports ok. Remove the stub so retries
          // don't leave ghost festivals behind.
          await rm(festivalDir, { recursive: true, force: true });
          deps.detect.bustCache?.();
          return textResult({
            kind: "plan_failed",
            error: `scaffold produced an empty festival at ${festivalDir} — the STRUCTURE.md parsed but yielded no phases/sequences`,
            hint:
              "Rewrite the doc to the exact shape — '# Festival Structure' / " +
              "'## Festival Goal' / '## Hierarchy' headers, then list items: '- **Festival:** name', " +
              "'  - **Phase 1:** name (type)', '    - Sequence 1: name', '      - Task 1: title' — then call fest_plan again. The empty stub was deleted.",
          });
        }
      }
      const { dir: workingDir, candidates: projectCandidates } = await resolveWorkingDir(
        root,
        deps.camp,
        params.workingDir,
      );
      let stamped = 0;
      let rulesSeed: { file: string; seeded: boolean; constraints: boolean } | undefined;
      let gates: { created: number; output: string } | undefined;
      let gateRules = 0;
      if (festivalDir && params.dryRun !== true) {
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
        rulesSeed = await seedFestivalRules(root, festivalDir, params.rules);
        gates = await deps.fest
          .gatesApply(root, festivalDir)
          .catch((err: unknown) => ({ created: 0, output: `gates apply failed: ${String(err)}` }));
        // Stamp the human's constraints into every generated gate task so the
        // checklists enforce plan-time rules, not just template boilerplate.
        if (rulesSeed.constraints) {
          gateRules = await stampGateRules(festivalDir);
        }
      }
      const skipped = gates?.output.match(/Skipping sequence "[^"]+"/g) ?? [];
      const needsWorkingDir = festivalDir !== undefined && !workingDir;
      return textResult({
        kind: "plan_scaffolded",
        dryRun: params.dryRun === true,
        output,
        ...(festivalDir ? { festivalDir } : {}),
        ...(bundle ? { visualReferences: bundle.pages.map((page) => `references/pages/${page}/PAGE.md`) } : {}),
        ...(rulesSeed ? { rules: { ...rulesSeed, gateFilesStamped: gateRules } } : {}),
        ...(workingDir ? { workingDir, sequencesStamped: stamped } : {}),
        ...(gates ? { qualityGates: gates } : {}),
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
          `Fill unfilled markers: fest_markers {list:true, festival:"${festId}"}`,
          `Run fest_validate {festival:"${festId}"} — it should report only unfilled markers, no missing fest_working_dir`,
          "Present the plan to the human and wait for approval",
          `fest_promote {festival:"${festId}"} twice: planning -> ready -> active`,
        ],
      });
    },
  });
  pi.registerTool({
    name: "fest_wireframe_create",
    label: "Create Screenshot Wireframe",
    description:
      "Deterministically create a categorized wireframe.svg and AI-ready PAGE.md for one page from structured screenshot observations. " +
      "Call once per page into a unique page-slug directory; components use open-ended semantic kinds and categories, with renderAs reserved for safe SVG primitives. " +
      "Inspect reusable project UI and styles first; include source paths and matched/no-match evidence, all node bounds and repeated instances, confidence-tagged styles, states, measurements, and unresolved questions. " +
      "The overview stays compact while PAGE.md contains the full categorized hierarchy and implementation evidence; source copy and sensitive values are not reproduced.",
    parameters: z.object({
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
          renderAs: z.enum(["rectangle", "text-bar", "line", "circle", "ellipse", "chevron", "checkbox"]).optional().describe("Canonical SVG drawing primitive for this node; omit to infer common legacy primitives or default to rectangle"),
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
          notes: z.string().describe("What was found or what existing project paths were checked"),
        })).describe("Project component discovery results; never invent candidate paths. Missing paths fail with instructions to search the project and retry using existing inspected paths"),
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
    async execute(_id: string, params: { outputDirectory: string; spec: WireframeSpec }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      try {
        const result = await createWireframe(params.outputDirectory, ctx.cwd, params.spec);
        return textResult({ kind: "wireframe_created", ...result });
      } catch (error) {
        return textResult({ kind: "wireframe_failed", error: String(error) });
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
        return textResult({ kind: "promoted", output });
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
      return textResult({ kind: "promoted", output });
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
      "List pending festival tasks grouped by sequence so you can fan out subagents — tasks in different sequences are parallel-safe, tasks in the same sequence run in order. Spawn one subagent per sequence and let them work concurrently.",
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
        hint: "Each sequence is an independent lane — spawn one subagent per sequence to work tasks in parallel; same-sequence tasks stay ordered.",
        lanes: [...groups.entries()].map(([sequence, files]) => ({
          sequence, tasks: files, visualReferences: laneReferences.get(sequence) ?? [],
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
}
