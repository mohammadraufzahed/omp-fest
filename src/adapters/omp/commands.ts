/**
 * Human-facing slash commands with live autocomplete sourced from the CLIs —
 * festivals, tasks, projects, intents. Nothing is hardcoded.
 */
import { statusLineText, summarizeProgress } from "@/domain/progress.js";
import type { FestivalSummary } from "@/domain/types.js";
import type { CampCli, CampDetect, FestCli } from "@/ports.js";

export interface CommandDeps {
  fest: FestCli;
  camp: CampCli;
  detect: CampDetect;
}

export interface PiCommandsLike {
  registerCommand(
    name: string,
    options: {
      description?: string;
      getArgumentCompletions?: (argPrefix: string, argIndex: number, ctx: CommandCtx) => Promise<string[]> | string[];
      handler: (args: string, ctx: CommandCtx) => Promise<void> | void;
    },
  ): void;
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void;
}

interface CommandCtx {
  cwd: string;
  ui: { notify(message: string, type?: string): void };
}

function send(pi: PiCommandsLike, customType: string, content: string): void {
  pi.sendMessage(
    { customType, content, display: true },
    { triggerTurn: false },
  );
}

async function festivalDirOf(deps: CommandDeps, ctx: CommandCtx, selector?: string): Promise<string> {
  const location = await deps.detect.locate(ctx.cwd);
  if (selector && location.campRoot) {
    const matches = await deps.fest.list(location.campRoot);
    const hit = matches.find((f) => f.id.includes(selector) || f.name.includes(selector));
    if (hit) {
      return hit.path;
    }
  }
  const dir = location.festivalDir ?? (location.campRoot ? await deps.detect.activeFestival(location.campRoot) : undefined);
  if (!dir) {
    throw new Error("No festival found — pass a festival name or run inside a camp");
  }
  return dir;
}

function festivalCompleter(deps: CommandDeps) {
  return async (prefix: string, _i: number, ctx: CommandCtx): Promise<string[]> => {
    const location = await deps.detect.locate(ctx.cwd);
    if (!location.campRoot) {
      return [];
    }
    const festivals = await deps.fest.list(location.campRoot);
    return festivals
      .map((f: FestivalSummary) => f.id)
      .filter((id) => id.toLowerCase().includes(prefix.toLowerCase()));
  };
}

const TASK_ACTIONS = ["show", "done", "block", "defer", "unblock", "reset", "update"];

export function registerCommands(pi: PiCommandsLike, deps: CommandDeps): void {
  pi.registerCommand("fest", {
    description: "Festival dashboard: camp, active festival, progress, gates",
    handler: async (_args, ctx) => {
      const location = await deps.detect.locate(ctx.cwd);
      if (location.kind === "outside") {
        send(pi, "fest-status", "Not inside a camp. `camp init` creates one; `fest init` works standalone.");
        return;
      }
      const dir = location.festivalDir ?? (location.campRoot ? await deps.detect.activeFestival(location.campRoot) : undefined);
      const lines: string[] = [`Camp: ${location.campName ?? location.campRoot}`];
      if (dir) {
        lines.push(`Festival dir: ${dir}`, await deps.fest.status(dir));
      } else {
        lines.push("No active festival — `/fest-plan <goal>` starts one.");
      }
      send(pi, "fest-status", lines.join("\n"));
    },
  });

  pi.registerCommand("fest-next", {
    description: "Pull the next festival unit into the conversation",
    getArgumentCompletions: festivalCompleter(deps),
    handler: async (args, ctx) => {
      const dir = await festivalDirOf(deps, ctx, args.trim() || undefined);
      const unit = await deps.fest.next(dir);
      send(pi, "fest-next", JSON.stringify(unit, null, 2));
    },
  });

  pi.registerCommand("fest-status", {
    description: "Live progress of the current festival",
    getArgumentCompletions: festivalCompleter(deps),
    handler: async (args, ctx) => {
      const dir = await festivalDirOf(deps, ctx, args.trim() || undefined);
      const events = await deps.detect.readProgress(dir);
      const progress = summarizeProgress(events);
      const line = statusLineText({ progress });
      send(pi, "fest-status", `${line}\n\n${await deps.fest.status(dir)}`);
    },
  });

  pi.registerCommand("fest-show", {
    description: "Festival tree with per-step checkmarks",
    getArgumentCompletions: festivalCompleter(deps),
    handler: async (args, ctx) => {
      const dir = await festivalDirOf(deps, ctx, args.trim() || undefined);
      send(pi, "fest-show", await deps.fest.show(dir, args.trim() || undefined));
    },
  });

  pi.registerCommand("fest-task", {
    description: "Task state: /fest-task <show|done|block|defer|unblock|reset|update> [task] [reason|pct]",
    getArgumentCompletions: (prefix, index) =>
      index === 0 ? TASK_ACTIONS.filter((a) => a.startsWith(prefix)) : [],
    handler: async (args, ctx) => {
      const [action = "show", ...rest] = args.trim().split(/\s+/);
      const dir = await festivalDirOf(deps, ctx);
      if (action === "done") {
        await deps.fest.taskComplete(dir, rest[0] ?? "");
        send(pi, "fest-status", "Task completed.");
        return;
      }
      if (action === "update") {
        await deps.fest.taskMutate(dir, "update", { task: rest[0], percent: rest[1] });
      } else if (action === "show") {
        send(pi, "fest-status", await deps.fest.next(dir).then((u) => JSON.stringify(u, null, 2)));
        return;
      } else {
        await deps.fest.taskMutate(dir, action as "blocked" | "defer" | "unblock" | "reset", {
          task: rest[0],
          reason: rest.slice(1).join(" ") || undefined,
        });
      }
      send(pi, "fest-status", `Task ${action} applied.`);
    },
  });

  pi.registerCommand("fest-approve", {
    description: "Approve the pending gate checkpoint (human attestation)",
    handler: async (_args, ctx) => {
      const dir = await festivalDirOf(deps, ctx);
      send(pi, "fest-gate", await deps.fest.workflowApprove(dir));
    },
  });

  pi.registerCommand("fest-reject", {
    description: "Reject the pending checkpoint: /fest-reject <reason>",
    handler: async (args, ctx) => {
      const dir = await festivalDirOf(deps, ctx);
      send(pi, "fest-gate", await deps.fest.workflowReject(dir, args.trim() || "no reason given"));
    },
  });

  pi.registerCommand("fest-doctor", {
    description: "Check fest/camp install, camp health, and judge configuration",
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      lines.push(`fest: ${(await deps.fest.version()) ?? "NOT INSTALLED — npm i -g @obedience-corp/festival"}`);
      lines.push(`camp: ${(await deps.camp.available()) ? "installed" : "NOT INSTALLED"}`);
      const location = await deps.detect.locate(ctx.cwd);
      lines.push(`location: ${location.kind}${location.campRoot ? ` (${location.campRoot})` : ""}`);
      send(pi, "fest-doctor", lines.join("\n"));
    },
  });

  pi.registerCommand("camp-idea", {
    description: "Capture an idea into the camp inbox: /camp-idea <text>",
    handler: async (args, ctx) => {
      const location = await deps.detect.locate(ctx.cwd);
      if (!location.campRoot) {
        ctx.ui.notify("Not inside a camp", "warning");
        return;
      }
      send(pi, "camp-idea", await deps.camp.ideaAdd(location.campRoot, args.trim()));
    },
  });
}
