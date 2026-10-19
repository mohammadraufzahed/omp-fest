/**
 * Model-callable fest_* / camp_* tools. Each is a thin mapping from a zod
 * schema to a port call — the agent gets typed results, never raw prose.
 *
 * The wiring is intentionally table-driven: TOOL_SPECS describes the tools
 * once, registerTools() adapts them onto whatever ExtensionAPI shape the
 * runtime hands us (kept loose-typed here so the module compiles without the
 * coding-agent package installed).
 */
import type { CampCli, CampDetect, FestCli } from "@/ports.js";
import { LoopTracker } from "@/application/loop-tracker.js";
import type { NextUnit, OmpFestConfig } from "@/domain/types.js";
import type { ZodLike } from "./zod-types.js";

export interface ToolDeps {
  fest: FestCli;
  camp: CampCli;
  detect: CampDetect;
  tracker: LoopTracker;
  config: OmpFestConfig;
}

export interface PiLike {
  zod: ZodLike;
  registerTool(tool: Record<string, unknown>): void;
}

interface ToolContextLike {
  cwd: string;
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

async function festivalDirOf(deps: ToolDeps, ctx: ToolContextLike): Promise<string> {
  const location = await deps.detect.locate(ctx.cwd);
  const dir = location.festivalDir ?? (location.campRoot ? await deps.detect.activeFestival(location.campRoot) : undefined);
  if (!dir) {
    throw new Error("No festival found — not inside a camp festival and no active festival in this camp");
  }
  return dir;
}

async function campRootOf(deps: ToolDeps, ctx: ToolContextLike): Promise<string> {
  const location = await deps.detect.locate(ctx.cwd);
  if (!location.campRoot) {
    throw new Error("Not inside a camp");
  }
  return location.campRoot;
}

export function registerTools(pi: PiLike, deps: ToolDeps): void {
  const z = pi.zod;

  pi.registerTool({
    name: "fest_next",
    label: "Fest Next",
    description:
      "Get the next unit of work in the current festival (task, workflow step, gate step, blocked, or complete). This is the engine of the festival loop — call it, do what it returns, then call it again.",
    parameters: z.object({}),
    async execute(_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const dir = await festivalDirOf(deps, ctx);
      const unit: NextUnit = await deps.fest.next(dir);
      if (unit.kind === "task") {
        deps.tracker.taskOpened(unit.path);
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
    }),
    async execute(_id: string, params: { task?: string; evidence: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const dir = await festivalDirOf(deps, ctx);
      await deps.fest.taskComplete(dir, params.task ?? "", params.evidence);
      deps.tracker.taskCompleted();
      return textResult({ status: "completed", task: params.task });
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
    }),
    async execute(_id: string, params: { action: "blocked" | "defer" | "unblock" | "reset" | "update"; task?: string; reason?: string; percent?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const dir = await festivalDirOf(deps, ctx);
      await deps.fest.taskMutate(dir, params.action, params);
      return textResult({ status: "ok", action: params.action });
    },
  });

  pi.registerTool({
    name: "fest_commit",
    label: "Fest Commit",
    description:
      "Commit changes through fest (auto-tags the message with [camp:festival]). Use instead of git commit inside linked projects so the work record stays truthful.",
    parameters: z.object({ message: z.string().describe("Commit message (task reference is added automatically)") }),
    async execute(_id: string, params: { message: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const dir = await festivalDirOf(deps, ctx);
      const hash = await deps.fest.commit(dir, params.message);
      deps.tracker.committed();
      return textResult({ status: "committed", hash });
    },
  });

  pi.registerTool({
    name: "fest_validate",
    label: "Validate Festival",
    description: "Validate festival structure; returns the /100 score plus issues to fix.",
    parameters: z.object({ fix: z.boolean().optional().describe("Auto-fix common structure issues") }),
    async execute(_id: string, params: { fix?: boolean }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const dir = await festivalDirOf(deps, ctx);
      return textResult(await deps.fest.validate(dir, params.fix));
    },
  });

  pi.registerTool({
    name: "fest_workflow",
    label: "Fest Workflow Step",
    description:
      "Advance or inspect a WORKFLOW.md phase: status shows the step list, advance marks the current step done. For gates, submit with 'submit' then STOP — never approve on your own.",
    parameters: z.object({
      action: z.enum(["status", "show", "advance"]),
    }),
    async execute(_id: string, params: { action: "status" | "show" | "advance" }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const dir = await festivalDirOf(deps, ctx);
      const output =
        params.action === "advance"
          ? await deps.fest.workflowAdvance(dir)
          : await deps.fest.workflowStatus(dir);
      return textResult(output);
    },
  });

  pi.registerTool({
    name: "fest_gate_submit",
    label: "Submit Fest Gate",
    description:
      "Present a gate/checkpoint for human review with evidence. Returns awaiting_human — you must STOP and wait for the operator. There is no self-approval path.",
    parameters: z.object({ evidence: z.string().describe("Validate score, tasks done, test results, files changed") }),
    async execute(_id: string, params: { evidence: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const dir = await festivalDirOf(deps, ctx);
      await deps.fest.workflowAdvance(dir);
      return textResult({
        status: "awaiting_human",
        evidence: params.evidence,
        instruction: "Present this evidence to the user and wait. Do not approve the checkpoint yourself.",
      });
    },
  });

  pi.registerTool({
    name: "fest_status",
    label: "Festival Status",
    description: "Current festival progress summary (phases, sequences, tasks, percent).",
    parameters: z.object({}),
    async execute(_id: string, _p: unknown, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const dir = await festivalDirOf(deps, ctx);
      return textResult(await deps.fest.status(dir));
    },
  });

  pi.registerTool({
    name: "fest_markers",
    label: "Fest Markers",
    description: "List/count unfilled [REPLACE:] and [FILL:] template markers that block fest next.",
    parameters: z.object({ list: z.boolean().optional() }),
    async execute(_id: string, params: { list?: boolean }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const dir = await festivalDirOf(deps, ctx);
      const count = await deps.fest.markersCount(dir);
      const listing = params.list ? await deps.fest.markersList(dir) : undefined;
      return textResult({ unfilled: count, ...(listing ? { listing } : {}) });
    },
  });

  pi.registerTool({
    name: "camp_idea_add",
    label: "Capture Camp Idea",
    description: "Quick-capture an idea into the camp inbox (camp idea add).",
    parameters: z.object({ text: z.string() }),
    async execute(_id: string, params: { text: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const root = await campRootOf(deps, ctx);
      return textResult(await deps.camp.ideaAdd(root, params.text));
    },
  });
}
