/**
 * Model-callable fest_* / camp_* tools. Each is a thin mapping from a zod
 * schema to a port call — the agent gets typed results, never raw prose.
 *
 * The wiring is intentionally table-driven: TOOL_SPECS describes the tools
 * once, registerTools() adapts them onto whatever ExtensionAPI shape the
 * runtime hands us (kept loose-typed here so the module compiles without the
 * coding-agent package installed).
 */
import { basename } from "node:path";
import type { CampCli, CampDetect, FestCli } from "../../ports.js";
import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { LoopTracker } from "../../application/loop-tracker.js";
import { FESTIVAL_CLAIM_ENTRY } from "../../application/session-claim.js";
import { sessionIdOf } from "../../application/session-id.js";
import type { NextUnit } from "../../domain/types.js";
import type { ZodLike } from "./zod-types.js";

export interface ToolDeps {
  fest: FestCli;
  camp: CampCli;
  detect: CampDetect;
  tracker: LoopTracker;
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
      "Get the next unit of work in the current festival (task, workflow step, gate step, blocked, or complete). This is the engine of the festival loop — call it, do what it returns, then call it again.",
    parameters: z.object({ festival: z.string().optional().describe("Festival name/id override") }),
    async execute(_id: string, params: { festival?: string }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      const dir = r.dir;
      const unit: NextUnit = await deps.fest.next(dir);
      if (unit.kind === "task") {
        const sid = sessionIdOf(ctx);
        const stale = deps.tracker.unfinishedFor(sid) ? deps.tracker.openTaskPathFor(sid) : undefined;
        deps.tracker.taskOpened(sid, unit.path);
        if (stale) {
          return textResult({
            ...unit,
            warning: `Previous unit ${stale} was opened but never completed+committed — the work record is stale. Finish its fest_task_complete/fest_commit before starting this one.`,
          });
        }
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
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { task?: string; evidence: string; festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      const dir = r.dir;
      const sid = sessionIdOf(ctx);
      const opened = deps.tracker.openTaskPathFor(sid);
      const completion = await deps.fest.taskComplete(dir, params.task ?? "", params.evidence);
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
    description: "Validate festival structure; returns the /100 score plus issues to fix.",
    parameters: z.object({
      fix: z.boolean().optional().describe("Auto-fix common structure issues"),
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { fix?: boolean; festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      return textResult(await deps.fest.validate(r.dir, params.fix));
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
      "Present a gate/checkpoint for human review with evidence. Returns awaiting_human — you must STOP and wait for the operator. There is no self-approval path.",
    parameters: z.object({
      evidence: z.string().describe("Validate score, tasks done, test results, files changed"),
      festival: z.string().optional().describe("Festival name/id override"),
    }),
    async execute(_id: string, params: { evidence: string; festival?: string }, _s: unknown, _u: unknown, ctx: ToolContextLike) {
      const r = await dirOrResult(pi, deps, ctx, params.festival);
      if ("result" in r) {
        return r.result;
      }
      await deps.fest.workflowAdvance(r.dir);
      return textResult({
        status: "awaiting_human",
        evidence: params.evidence,
        instruction: "Present this evidence to the user and wait. Do not approve the checkpoint yourself.",
      });
    },
  });

  pi.registerTool({
    name: "fest_plan",
    label: "Fest Plan (Scaffold From Plan)",
    description:
      "Generate a festival from a STRUCTURE.md plan doc the model wrote after interviewing the human. " +
      "Runs `fest scaffold from-plan --dest planning`. Returns the new festival path and unfilled marker " +
      "count. Follow with marker fills, fest_validate, human approval, then fest_promote x2.",
    parameters: z.object({
      name: z.string().describe("Festival name/slug, e.g. 'prenatal-form-groups'"),
      plan: z.string().describe("Absolute path to the STRUCTURE.md plan document"),
      dryRun: z.boolean().optional().describe("Preview without creating files"),
    }),
    async execute(_id: string, params: { name: string; plan: string; dryRun?: boolean }, _signal: unknown, _onUpdate: unknown, ctx: ToolContextLike) {
      const root = await campRootOf(deps, ctx);
      if (!root) {
        return await idleResult(deps, ctx);
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
      let gates: { created: number; output: string } | undefined;
      if (parsed?.festival_dir && params.dryRun !== true) {
        gates = await deps.fest
          .gatesApply(root, parsed.festival_dir)
          .catch((err: unknown) => ({ created: 0, output: `gates apply failed: ${String(err)}` }));
      }
      return textResult({
        kind: "plan_scaffolded",
        dryRun: params.dryRun === true,
        output,
        ...(parsed?.festival_dir ? { festivalDir: parsed.festival_dir } : {}),
        ...(gates ? { qualityGates: gates } : {}),
        nextSteps: [
          `Fill unfilled markers: fest_markers {list:true, festival:"${festId}"}`,
          `Run fest_validate {festival:"${festId}"}`,
          "Present the plan to the human and wait for approval",
          `fest_promote {festival:"${festId}"} twice: planning -> ready -> active`,
        ],
      });
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
      const pending = tasks.filter((t) => !t.done);
      const groups = new Map<string, string[]>();
      for (const task of pending) {
        const list = groups.get(task.sequence) ?? [];
        list.push(task.path);
        groups.set(task.sequence, list);
      }
      return textResult({
        hint: "Each sequence is an independent lane — spawn one subagent per sequence to work tasks in parallel; same-sequence tasks stay ordered.",
        lanes: [...groups.entries()].map(([sequence, files]) => ({ sequence, tasks: files })),
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
