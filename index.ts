/**
 * omp-fest — composition root.
 *
 * Registers the fest.build loop (tools, commands, orientation, status line,
 * gate notifications) on the omp ExtensionAPI. Loaded by omp as a git
 * submodule at `.omp/extensions/omp-fest` — keep the dependency footprint at
 * zero; the runtime injects zod and the pi SDK.
 */
import { CachedDetect } from "./src/application/detect-cache.js";
import { LoopTracker } from "./src/application/loop-tracker.js";
import { orientSession } from "./src/application/orient.js";
import { CampCliAdapter } from "./src/adapters/cli/camp-cli.js";
import { FestCliAdapter } from "./src/adapters/cli/fest-cli.js";
import { NodeExecRunner } from "./src/adapters/cli/node-exec.js";
import { CampFsDetect } from "./src/adapters/fs/camp-fs.js";
import { registerCommands } from "./src/adapters/omp/commands.js";
import { notifyGate, OmpNotifier } from "./src/adapters/omp/notify.js";
import { registerTools, type PiLike } from "./src/adapters/omp/tools.js";
import { loadConfig } from "./src/domain/config.js";
import { PARALLEL_HINT, RECOVERY_PLAYBOOK } from "./src/domain/orientation.js";
import { statusLineText, summarizeProgress } from "./src/domain/progress.js";

interface ExtensionContextLike {
  cwd: string;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
  };
}

interface ExtensionApiLike {
  zod: unknown;
  logger?: { warn(message: string): void };
  on(event: string, handler: (event: unknown, ctx: ExtensionContextLike) => unknown): void;
  registerTool(tool: Record<string, unknown>): void;
  registerCommand(name: string, options: Record<string, unknown>): void;
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void;
  setLabel(label: string): void;
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

  pi.on("session_start", async (_event, ctx) => {
      const config = await configFor();
      const notifier = new OmpNotifier(ctx.ui);
      if (!(await fest.available())) {
        notifier.warn("fest CLI not found — npm i -g @obedience-corp/festival");
        return;
      }
      const orientation = await orientSession(ctx.cwd, detect);
      if (orientation.note) {
        pi.sendMessage(
          { customType: "fest-orientation", content: `${orientation.note}\n\n${PARALLEL_HINT}\n\n${RECOVERY_PLAYBOOK}`, display: false },
          { triggerTurn: false },
        );
      }
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
    });

  pi.on("session_compact", async (_event, ctx) => {
      const orientation = await orientSession(ctx.cwd, detect);
      if (orientation.note) {
        // Compaction drops context — re-inject the full protocol, not just the note.
        pi.sendMessage(
          { customType: "fest-orientation", content: `${orientation.note}\n\n${PARALLEL_HINT}\n\n${RECOVERY_PLAYBOOK}`, display: false },
          { triggerTurn: false },
        );
      }
    });

  pi.on("tool_call", async (event, ctx) => {
      const toolCall = event as { toolName?: string; input?: { command?: string } };
      const toolName = toolCall.toolName ?? "";
      if (toolName.startsWith("fest_") || toolName.startsWith("camp_")) {
        return undefined;
      }
      const location = await detect.locate(ctx.cwd);
      if (!location.campRoot) {
        return undefined;
      }
      const command = toolCall.input?.command ?? "";
      if (toolName === "bash" && /\b(?:fest|camp)\s+[a-z]/i.test(command) && !/^\s*(?:cd|ls|which)\b/.test(command)) {
        return {
          additionalContext:
            "omp-fest: do not run fest/camp via shell — use the fest_*/camp_* tools (fest_raw/camp_raw for uncovered subcommands); they resolve the festival dir, inject --yes, and parse output.",
        };
      }
      if (toolName === "bash" && /\bgit\s+commit\b/.test(command) && !/fest\s+commit/.test(command)) {
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
    });

  pi.on("agent_end", (_event, ctx) => {
      const nudge = tracker.nudge();
      if (nudge) {
        ctx.ui.notify(nudge, "warning");
      }
    });
}
