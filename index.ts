/**
 * omp-fest — composition root.
 *
 * Registers the fest.build loop (tools, commands, per-turn state digest,
 * transition watcher, status line, gate notifications) on the omp
 * ExtensionAPI. Loaded by omp as a git submodule at
 * `.omp/extensions/omp-fest` — keep the dependency footprint at zero; the
 * runtime injects zod and the pi SDK.
 *
 * Event/result field shapes below mirror omp's ExtensionAPI
 * (packages/coding-agent/src/extensibility/extensions/types.ts) — verified
 * against upstream: before_agent_start.message, tool_call/tool_result
 * additionalContext, before_subagent_spawn {note, block, reason, model}.
 */
import { basename, isAbsolute, resolve } from "node:path";

import { CachedDetect } from "./src/application/detect-cache.js";
import { watchCampTransitions } from "./src/application/camp-watcher.js";
import { LoopTracker } from "./src/application/loop-tracker.js";
import { orientSession } from "./src/application/orient.js";
import { buildStateDigest } from "./src/application/state-digest.js";
import { CampCliAdapter } from "./src/adapters/cli/camp-cli.js";
import { FestCliAdapter } from "./src/adapters/cli/fest-cli.js";
import { NodeExecRunner } from "./src/adapters/cli/node-exec.js";
import { CampFsDetect } from "./src/adapters/fs/camp-fs.js";
import { registerCommands } from "./src/adapters/omp/commands.js";
import { notifyGate, OmpNotifier } from "./src/adapters/omp/notify.js";
import { registerTools, type PiLike } from "./src/adapters/omp/tools.js";
import { loadConfig } from "./src/domain/config.js";
import { statusLineText, summarizeProgress } from "./src/domain/progress.js";

interface ExtensionContextLike {
  cwd: string;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget?(key: string, content: string[] | undefined, options?: { placement?: string }): void;
  };
}

interface CustomMessagePayload {
  customType: string;
  content: string;
  display?: boolean;
  details?: unknown;
}

interface BeforeAgentStartResult {
  message?: CustomMessagePayload;
}

interface ToolCallEvent {
  toolName?: string;
  input?: Record<string, unknown>;
}

interface ToolResultEventShape extends ToolCallEvent {
  isError?: boolean;
}

interface ToolCallResult {
  block?: boolean;
  reason?: string;
  additionalContext?: string;
}

interface SubagentSpawnResult {
  model?: string | string[];
  block?: boolean;
  reason?: string;
  note?: string;
}

interface FestEventMap {
  session_start: unknown;
  before_agent_start: unknown;
  tool_call: ToolCallEvent;
  tool_result: ToolResultEventShape;
  before_subagent_spawn: { agent?: string };
  agent_end: unknown;
}

type HandlerResult =
  | BeforeAgentStartResult
  | ToolCallResult
  | SubagentSpawnResult
  | undefined;

interface ExtensionApiLike {
  zod: unknown;
  logger?: { warn(message: string): void };
  on<K extends keyof FestEventMap>(
    event: K,
    handler: (event: FestEventMap[K], ctx: ExtensionContextLike) => HandlerResult | Promise<HandlerResult>,
  ): void;
  registerTool(tool: Record<string, unknown>): void;
  registerCommand(name: string, options: Record<string, unknown>): void;
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void;
  setLabel(label: string): void;
}

const WRITE_TOOLS = new Set(["edit", "write", "multi_edit", "notebook_edit", "apply_patch"]);

/** Pull the target file path(s) out of a write/edit tool call input. */
function targetPaths(input: Record<string, unknown> | undefined, cwd: string): string[] {
  if (!input) {
    return [];
  }
  const raw: unknown[] = [];
  if (typeof input.path === "string") {
    raw.push(input.path);
  }
  if (typeof input.file_path === "string") {
    raw.push(input.file_path);
  }
  if (Array.isArray(input.paths)) {
    raw.push(...input.paths.filter((p): p is string => typeof p === "string"));
  }
  return raw
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => (isAbsolute(p) ? p : resolve(cwd, p)));
}

export default function ompFest(pi: ExtensionApiLike): void {
  pi.setLabel("fest.build");

  const exec = new NodeExecRunner();
  const fest = new FestCliAdapter(exec);
  const camp = new CampCliAdapter(exec);
  const detect = new CachedDetect(new CampFsDetect());
  const tracker = new LoopTracker();

  const cwd = process.cwd();
  const deps = { fest, camp, detect, tracker };

  registerTools(pi as unknown as PiLike, deps);
  registerCommands(pi, deps);

  const configFor = async () => loadConfig(cwd);
  const silentContext = (content: string): void => {
    pi.sendMessage(
      { customType: "fest-state", content, display: false },
      { triggerTurn: false },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    const config = await configFor();
    const notifier = new OmpNotifier(ctx.ui);
    if (!(await fest.available())) {
      notifier.warn("fest CLI not found — npm i -g @obedience-corp/festival");
      return;
    }
    const orientation = await orientSession(ctx.cwd, detect);
    if (orientation.statusLine && config.statusLine) {
      ctx.ui.setStatus("omp-fest", orientation.statusLine);
    }
    const watchedDir = orientation.location.festivalDir;
    if (watchedDir) {
      detect.watch(watchedDir, () => {
        void (async () => {
          const events = await detect.readProgress(watchedDir);
          const progress = summarizeProgress(events);
          ctx.ui.setStatus(
            "omp-fest",
            statusLineText({
              campName: orientation.location.campName,
              festivalId: orientation.location.festivalId,
              progress,
            }),
          );
          if (progress.gatePending) {
            await notifyGate({
              ui: ctx.ui,
              camp,
              campRoot: orientation.location.campRoot,
              config,
              message: `Festival gate pending in ${orientation.location.festivalId ?? "festival"} — approval needed`,
            });
          }
        })();
      });
    }
    if (orientation.location.campRoot && config.watchTransitions) {
      watchCampTransitions(detect, orientation.location.campRoot, (messages) => {
        for (const message of messages) {
          ctx.ui.notify(`fest: ${message}`, "info");
        }
        silentContext(
          `fest camp transition: ${messages.join("; ")}. If a festival became active, drive it via fest_next.`,
        );
      });
    }
  });

  // Live state + rules injected into EVERY turn — survives compaction and
  // never goes stale, replacing the old one-shot orientation/compaction
  // re-inject.
  pi.on("before_agent_start", async (_event, ctx) => {
    const digest = await buildStateDigest(deps, ctx.cwd);
    const config = await configFor();
    ctx.ui.setWidget?.(
      "ompfest",
      digest && config.progressWidget
        ? [
            `⛺ ${(digest.split("\n")[0] ?? "").replace(/^fest: /, "")}`,
            ...(digest.includes("GATE PENDING") ? ["⚑ GATE PENDING — needs your approval (/fest approve)"] : []),
          ]
        : undefined,
      { placement: "aboveEditor" },
    );
    if (!digest) {
      return undefined;
    }
    return { message: { customType: "fest-state", content: digest, display: false } };
  });

  // Pre-execution nudges for bypass paths (raw fest/camp, ad hoc todos,
  // untagged git commits).
  pi.on("tool_call", (event, ctx) => {
    return (async (): Promise<ToolCallResult | undefined> => {
      const toolName = event.toolName ?? "";
      if (toolName.startsWith("fest_") || toolName.startsWith("camp_")) {
        return undefined;
      }
      const location = await detect.locate(ctx.cwd);
      if (!location.campRoot) {
        return undefined;
      }
      const command =
        typeof event.input?.command === "string" ? event.input.command : "";
      if (
        toolName === "bash" &&
        /\b(?:fest|camp)\s+[a-z]/i.test(command) &&
        !/^\s*(?:cd|ls|which)\b/.test(command)
      ) {
        return {
          additionalContext:
            "omp-fest: do not run fest/camp via shell — use the fest_*/camp_* tools (fest_raw/camp_raw for uncovered subcommands); they resolve the festival dir, inject --yes, and parse output.",
        };
      }
      if (
        toolName === "bash" &&
        /\bgit\s+commit\b/.test(command) &&
        !/fest\s+commit/.test(command)
      ) {
        return {
          additionalContext:
            "omp-fest: prefer fest_commit inside linked projects so commits get [camp:festival] tags and the work record stays truthful.",
        };
      }
      if (toolName === "todo") {
        return {
          additionalContext:
            "omp-fest: inside a camp the festival plan is the task list — do not track festival work with ad hoc todos. Call fest_next for the next unit; use fest_task_update for progress/blocked state.",
        };
      }
      return undefined;
    })();
  });

  // Post-execution discipline: edits/writes on real files while a festival has
  // pending work but no unit was opened via fest_next — the exact "implemented
  // without fest_next" failure.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) {
      return undefined;
    }
    const toolName = event.toolName ?? "";
    if (!WRITE_TOOLS.has(toolName)) {
      return undefined;
    }
    const location = await detect.locate(ctx.cwd);
    const festivalDir =
      location.festivalDir ??
      (location.campRoot ? await detect.activeFestival(location.campRoot) : undefined);
    if (!festivalDir) {
      return undefined;
    }
    const targets = targetPaths(event.input, ctx.cwd).filter(
      (p) => !p.startsWith(`${festivalDir}/`) && !p.includes("/festivals/"),
    );
    if (targets.length === 0) {
      return undefined;
    }
    if (tracker.openTaskPath !== undefined) {
      return undefined;
    }
    const pending = await detect.pendingTasks(festivalDir);
    if (pending.length === 0) {
      return undefined;
    }
    const fresh = targets.filter((p) => tracker.markWarned(p));
    if (fresh.length === 0) {
      return undefined;
    }
    return {
      additionalContext: `omp-fest: edited ${fresh.map((p) => basename(p)).join(", ")} with no unit open — the festival only tracks work fest_next hands out (${pending.length} task(s) pending). Call fest_next before more project edits.`,
    };
  });

  // Subagent steering: the API can't rewrite the spawn prompt — attach a note
  // so the routing output reminds the parent to hand out explicit units.
  pi.on("before_subagent_spawn", (_event, _ctx) => {
    return {
      note: "omp-fest: inside a camp, give each subagent an explicit festival unit (fest_parallel lanes or fest_next output — festivalDir + task path). Subagents run the same fest_* loop.",
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    const nudge = tracker.nudge();
    if (nudge) {
      ctx.ui.notify(nudge, "warning");
    }
    return undefined;
  });
}
