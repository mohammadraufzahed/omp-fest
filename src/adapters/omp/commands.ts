/**
 * Human-facing slash commands with live autocomplete sourced from the CLIs —
 * festivals, tasks, projects, intents. Nothing is hardcoded.
 */
import { matchFestival } from "../../application/fest-resolve.js";
import { loadConfig, saveConfig } from "../../domain/config.js";
import { statusLineText, summarizeProgress } from "../../domain/progress.js";
import { DEFAULT_CONFIG, type OmpFestConfig } from "../../domain/types.js";
import { IDEA_INTERVIEW, PLAN_GUIDE, markerInterviewKickoff, planInterviewKickoff } from "../../domain/orientation.js";
import type { CampCli, CampDetect, FestCli } from "../../ports.js";

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
      getArgumentCompletions?: (argPrefix: string) => Promise<AutocompleteItemLike[] | null> | AutocompleteItemLike[] | null;
      handler: (args: string, ctx: CommandCtx) => Promise<void> | void;
    },
  ): void;
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void;
  sendUserMessage?(text: string): void;
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
    const all = await deps.fest.list(location.campRoot);
    const match = matchFestival(all, selector);
    if (match.kind === "ambiguous") {
      throw new Error(`Ambiguous festival "${selector}" — matches: ${match.matches.map((f) => f.id).join(", ")}`);
    }
    if (match.kind === "match") {
      return match.festival.path;
    }
    throw new Error(`No festival matches "${selector}" — known: ${all.map((f) => f.id).join(", ") || "none"}`);
  }
  const dir = location.festivalDir ?? (location.campRoot ? await deps.detect.activeFestival(location.campRoot) : undefined);
  if (!dir) {
    throw new Error("No festival found — pass a festival name or run inside a camp");
  }
  return dir;
}

interface AutocompleteItemLike {
  value: string;
  label: string;
}

const TASK_ACTIONS = ["show", "done", "block", "defer", "unblock", "reset", "update"];

interface Sub {
  desc: string;
  run: (args: string[], ctx: CommandCtx) => Promise<void> | void;
}

type SettingParse = { value: unknown } | { error: string };

interface SettingSpec {
  key: keyof OmpFestConfig;
  desc: string;
  /** Undefined raw = toggle (booleans only). */
  parse: (raw: string | undefined, current: unknown) => SettingParse;
}

const err = (error: string): SettingParse => ({ error });
const val = (value: unknown): SettingParse => ({ value });

const BOOL = (raw: string | undefined, current: unknown): SettingParse => {
  if (raw === undefined) {
    return val(!current);
  }
  if (/^(on|true|1|yes)$/i.test(raw)) {
    return val(true);
  }
  if (/^(off|false|0|no)$/i.test(raw)) {
    return val(false);
  }
  return err("expected on/off (omit the value to toggle)");
};

const enumOf = (values: readonly string[]) =>
  (raw: string | undefined): SettingParse =>
    raw !== undefined && values.includes(raw)
      ? val(raw)
      : err(`expected one of: ${values.join(", ")}`);

const GATE_CHANNELS = ["ui", "camp-notify", "webhook"] as const;

const SETTING_SPECS: SettingSpec[] = [
  { key: "statusLine", desc: "festival progress in the omp status line", parse: BOOL },
  { key: "watchTransitions", desc: "notify on festival lifecycle moves (planning→ready→active)", parse: BOOL },
  { key: "pauseAtGates", desc: "stop for human approval at gates", parse: BOOL },
  { key: "evidenceRequiredOnGates", desc: "require evidence text on gate approval", parse: BOOL },
  { key: "autoCommitAfterTask", desc: "auto fest_commit after task completed", parse: enumOf(["ask", "always", "never"]) },
  { key: "autonomyCeiling", desc: "max autonomy level", parse: enumOf(["low", "medium", "high"]) },
  {
    key: "gateNotify",
    desc: "gate notification channels (comma list: ui,camp-notify,webhook; 'none' disables)",
    parse: (raw) => {
      if (raw === undefined) {
        return err("expected a comma list like ui,camp-notify or 'none'");
      }
      if (/^(none|off)$/i.test(raw)) {
        return val([]);
      }
      const channels = raw.split(/[\s,]+/).filter(Boolean);
      const bad = channels.filter((c) => !(GATE_CHANNELS as readonly string[]).includes(c));
      return bad.length > 0 ? err(`unknown channel(s): ${bad.join(", ")} — use ${GATE_CHANNELS.join(", ")}`) : val(channels);
    },
  },
  {
    key: "webhookUrl",
    desc: "gate webhook target ('none' clears)",
    parse: (raw) => (raw === undefined ? err("expected a URL or 'none'") : val(raw === "none" ? undefined : raw)),
  },
];

export function registerCommands(pi: PiCommandsLike, deps: CommandDeps): void {
  const subs: Record<string, Sub> = {
    "": {
      desc: "festival dashboard: camp, active festival, progress, gates",
      run: async (_args, ctx) => {
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
          const festivals = location.campRoot ? await deps.detect.listFestivals(location.campRoot) : [];
          if (festivals.length > 0) {
            lines.push("No active festival. Available:");
            for (const f of festivals) {
              lines.push(`  ${f.id} (${f.status}) — /fest next ${f.id}`);
            }
          } else {
            lines.push("No festivals yet — `/fest plan <goal>` starts the planning flow.");
          }
        }
        send(pi, "fest-status", lines.join("\n"));
      },
    },
    next: {
      desc: "pull the next festival unit into the conversation: /fest next [festival]",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx, args[0]);
        send(pi, "fest-next", JSON.stringify(await deps.fest.next(dir), null, 2));
      },
    },
    status: {
      desc: "live progress of the current festival: /fest status [festival]",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx, args[0]);
        const events = await deps.detect.readProgress(dir);
        const line = statusLineText({ progress: summarizeProgress(events) });
        send(pi, "fest-status", `${line}\n\n${await deps.fest.status(dir)}`);
      },
    },
    show: {
      desc: "festival tree with per-step checkmarks: /fest show [festival]",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx, args[0]);
        send(pi, "fest-show", await deps.fest.show(dir, args[1]));
      },
    },
    task: {
      desc: "task state: /fest task <show|done|block|defer|unblock|reset|update> [task] [reason|pct]",
      run: async (args, ctx) => {
        const [action = "show", ...rest] = args;
        const dir = await festivalDirOf(deps, ctx);
        if (action === "done") {
          const completion = await deps.fest.taskComplete(dir, rest[0] ?? "");
          send(pi, "fest-status", completion.ok ? "Task completed." : `Completion blocked:\n${completion.output}`);
          return;
        }
        if (action === "update") {
          await deps.fest.taskMutate(dir, "update", { task: rest[0], percent: rest[1] });
        } else if (action === "show") {
          send(pi, "fest-status", JSON.stringify(await deps.fest.next(dir), null, 2));
          return;
        } else {
          await deps.fest.taskMutate(dir, action as "blocked" | "defer" | "unblock" | "reset", {
            task: rest[0],
            reason: rest.slice(1).join(" ") || undefined,
          });
        }
        send(pi, "fest-status", `Task ${action} applied.`);
      },
    },
    plan: {
      desc: "guided planning interview — agent asks, you answer, agent builds the festival: /fest plan [goal]",
      run: (args, ctx) => {
        const goal = args.join(" ");
        if (pi.sendUserMessage) {
          pi.sendUserMessage(planInterviewKickoff(goal));
          ctx.ui.notify("Planning interview started — answer the agent's questions.", "info");
        } else {
          send(pi, "fest-plan", `${goal ? `Goal: ${goal}\n\n` : ""}${PLAN_GUIDE}`);
        }
      },
    },
    promote: {
      desc: "advance the festival one lifecycle step (only after human plan approval)",
      run: async (args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        const cwd = location.festivalDir ?? location.campRoot;
        if (!cwd) {
          send(pi, "fest-status", "Not inside a camp.");
          return;
        }
        send(pi, "fest-status", await deps.fest.promote(cwd, args[0]));
      },
    },
    validate: {
      desc: "structure check: /fest validate [--fix]",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx);
        const result = await deps.fest.validate(dir, args.includes("--fix"));
        send(pi, "fest-status", `score: ${result.score}\n${result.output}`);
      },
    },
    markers: {
      desc: "list unfilled markers — 'fill' interviews you for each: /fest markers [fill]",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx);
        const listing = (await deps.fest.markersList(dir)) || "No unfilled markers.";
        if (args[0] === "fill" && pi.sendUserMessage) {
          if (listing === "No unfilled markers.") {
            send(pi, "fest-status", listing);
          } else {
            pi.sendUserMessage(markerInterviewKickoff(listing));
            ctx.ui.notify("Marker interview started — the agent asks you each missing value.", "info");
          }
          return;
        }
        send(pi, "fest-status", listing);
      },
    },
    workflow: {
      desc: "workflow status/advance: /fest workflow [status|advance]",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx);
        send(pi, "fest-status", args[0] === "advance" ? await deps.fest.workflowAdvance(dir) : await deps.fest.workflowStatus(dir));
      },
    },
    approve: {
      desc: "approve the pending gate checkpoint (human attestation)",
      run: async (_args, ctx) => {
        send(pi, "fest-gate", await deps.fest.workflowApprove(await festivalDirOf(deps, ctx)));
      },
    },
    reject: {
      desc: "reject the pending checkpoint: /fest reject <reason>",
      run: async (args, ctx) => {
        send(pi, "fest-gate", await deps.fest.workflowReject(await festivalDirOf(deps, ctx), args.join(" ") || "no reason given"));
      },
    },
    parallel: {
      desc: "pending tasks grouped by sequence — spawn a subagent per lane",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx, args[0]);
        const tasks = await deps.detect.pendingTasks(dir);
        const pending = tasks.filter((t) => !t.done);
        if (pending.length === 0) {
          send(pi, "fest-status", "No pending tasks — festival is done or fully dispatched.");
          return;
        }
        const groups = new Map<string, string[]>();
        for (const task of pending) {
          const list = groups.get(task.sequence) ?? [];
          list.push(task.path);
          groups.set(task.sequence, list);
        }
        const lines = ["Pending tasks by lane (one subagent per sequence):"];
        for (const [seq, files] of groups) {
          lines.push(`\n${seq}`);
          for (const file of files) {
            lines.push(`  • ${file}`);
          }
        }
        send(pi, "fest-status", lines.join("\n"));
      },
    },
    doctor: {
      desc: "check fest/camp install, camp health, and judge configuration",
      run: async (_args, ctx) => {
        const lines: string[] = [];
        lines.push(`fest: ${(await deps.fest.version()) ?? "NOT INSTALLED — npm i -g @obedience-corp/festival"}`);
        lines.push(`camp: ${(await deps.camp.available()) ? "installed" : "NOT INSTALLED"}`);
        const location = await deps.detect.locate(ctx.cwd);
        lines.push(`location: ${location.kind}${location.campRoot ? ` (${location.campRoot})` : ""}`);
        send(pi, "fest-doctor", lines.join("\n"));
      },
    },
    cmd: {
      desc: "raw fest passthrough: /fest cmd <args> — e.g. /fest cmd list --json",
      run: async (args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        const cwd = location.festivalDir ?? (location.campRoot ? await deps.detect.activeFestival(location.campRoot) : undefined) ?? location.campRoot;
        if (!cwd) {
          send(pi, "fest-status", "Not inside a camp.");
          return;
        }
        const result = await deps.fest.raw(cwd, args);
        send(pi, "fest-cmd", result.stdout || result.stderr || `exit ${result.code}`);
      },
    },
    camp: {
      desc: "raw camp passthrough: /fest camp <args> — e.g. /fest camp idea list",
      run: async (args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        if (!location.campRoot) {
          send(pi, "fest-status", "Not inside a camp.");
          return;
        }
        const result = await deps.camp.raw(location.campRoot, args);
        send(pi, "camp-cmd", result.stdout || result.stderr || `exit ${result.code}`);
      },
    },
    idea: {
      desc: "capture an idea (no args = agent interviews you first): /fest idea [text]",
      run: async (args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        if (!location.campRoot) {
          ctx.ui.notify("Not inside a camp", "warning");
          return;
        }
        const text = args.join(" ");
        if (!text && pi.sendUserMessage) {
          pi.sendUserMessage(IDEA_INTERVIEW);
          return;
        }
        send(pi, "camp-idea", await deps.camp.ideaAdd(location.campRoot, text));
      },
    },
    settings: {
      desc: "view or toggle plugin settings (.ompfest.json): /fest settings [key] [value]",
      run: async (args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        const dir = location.campRoot ?? ctx.cwd;
        const config = await loadConfig(dir);
        if (args.length === 0) {
          const lines = [`omp-fest settings (${dir}/.ompfest.json):`];
          for (const spec of SETTING_SPECS) {
            const value = config[spec.key] === undefined ? "—" : JSON.stringify(config[spec.key]);
            lines.push(`  ${spec.key.padEnd(24)} ${value.padEnd(14)} ${spec.desc}`);
          }
          lines.push(
            "Toggle: /fest settings <key> [value] — omit value to flip a boolean. '/fest settings reset' restores defaults.",
          );
          send(pi, "fest-status", lines.join("\n"));
          return;
        }
        const [key, ...valueParts] = args;
        if (key === "reset") {
          await saveConfig(dir, { ...DEFAULT_CONFIG, webhookUrl: undefined });
          send(pi, "fest-status", "Settings reset to defaults.");
          return;
        }
        const spec = SETTING_SPECS.find((s) => s.key === key);
        if (!spec) {
          send(pi, "fest-status", `Unknown setting "${key}" — keys: ${SETTING_SPECS.map((s) => s.key).join(", ")}`);
          return;
        }
        const parsed = spec.parse(valueParts.join(" ") || undefined, config[spec.key]);
        if ("error" in parsed) {
          send(pi, "fest-status", `${key}: ${parsed.error}`);
          return;
        }
        await saveConfig(dir, { [spec.key]: parsed.value });
        send(pi, "fest-status", `${key} = ${JSON.stringify(parsed.value)} (saved to ${dir}/.ompfest.json)`);
      },
    },
    help: {
      desc: "list every /fest subcommand",
      run: (_args, _ctx) => {
        const lines = ["/fest — guided festival control:"];
        for (const [name, sub] of Object.entries(subs)) {
          if (name === "") {
            continue;
          }
          lines.push(`  /fest ${name.padEnd(10)} ${sub.desc}`);
        }
        lines.push("  /fest           " + (subs[""]?.desc ?? "dashboard"));
        send(pi, "fest-status", lines.join("\n"));
      },
    },
  };

  pi.registerCommand("fest", {
    description: "Guided festival control: /fest [next|status|show|task|plan|promote|validate|markers|workflow|approve|reject|parallel|settings|doctor|cmd|camp|idea|help]",
    getArgumentCompletions: async (prefix) => {
      const items: AutocompleteItemLike[] = Object.keys(subs)
        .filter((n) => n !== "")
        .map((name) => ({ value: name, label: `/fest ${name}` }));
      for (const action of TASK_ACTIONS) {
        items.push({ value: action, label: `task ${action}` });
      }
      for (const spec of SETTING_SPECS) {
        items.push({ value: spec.key, label: `settings ${spec.key}` });
      }
      const location = await deps.detect.locate(process.cwd());
      if (location.campRoot) {
        for (const f of await deps.fest.list(location.campRoot).catch(() => [])) {
          items.push({ value: f.id, label: f.name });
        }
      }
      return items.filter((i) => i.value.toLowerCase().startsWith(prefix.toLowerCase()));
    },
    handler: async (args, ctx) => {
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const entry = subs[sub];
      if (!entry) {
        const known = Object.keys(subs).filter((n) => n !== "");
        send(pi, "fest-status", `Unknown /fest subcommand "${sub}". Try: ${known.join(", ")} — or /fest help.`);
        return;
      }
      try {
        await entry.run(rest, ctx);
      } catch (err) {
        send(pi, "fest-status", err instanceof Error ? err.message : String(err));
      }
    },
  });
}
