/**
 * omp-fest — composition root.
 *
 * Registers the fest.build loop (tools, commands, orientation, status line,
 * gate notifications) on the omp ExtensionAPI. Loaded by omp as a git
 * submodule at `.omp/extensions/omp-fest` — keep the dependency footprint at
 * zero; the runtime injects zod and the pi SDK.
 */
import { LoopTracker } from "@/application/loop-tracker.js";
import { orientSession } from "@/application/orient.js";
import { CampCliAdapter } from "@/adapters/cli/camp-cli.js";
import { FestCliAdapter } from "@/adapters/cli/fest-cli.js";
import { NodeExecRunner } from "@/adapters/cli/node-exec.js";
import { CampFsDetect } from "@/adapters/fs/camp-fs.js";
import { registerCommands } from "@/adapters/omp/commands.js";
import { notifyGate, OmpNotifier } from "@/adapters/omp/notify.js";
import { registerTools, type PiLike } from "@/adapters/omp/tools.js";
import { loadConfig } from "@/domain/config.js";
import { PARALLEL_HINT, RECOVERY_PLAYBOOK } from "@/domain/orientation.js";
import { statusLineText, summarizeProgress } from "@/domain/progress.js";

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
  const detect = new CampFsDetect();
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
        pi.sendMessage(
          { customType: "fest-orientation", content: orientation.note, display: false },
          { triggerTurn: false },
        );
      }
    });

  pi.on("tool_call", (event) => {
      const toolCall = event as { toolName?: string; input?: { command?: string } };
      const command = toolCall.input?.command ?? "";
      if (toolCall.toolName === "bash" && /\bgit\s+commit\b/.test(command) && !/fest\s+commit/.test(command)) {
        return {
          block: false,
          reason: undefined,
          message: "omp-fest: prefer fest_commit inside linked projects so commits get [camp:festival] tags",
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
