/**
 * Human-facing slash commands with live autocomplete sourced from the CLIs —
 * festivals, tasks, projects, intents. Nothing is hardcoded.
 */
import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { joinFestivalTeam, transferFestivalTeamCoordinator, readFestivalTeam } from "../../application/festival-team.js";
import { festivalOwner, type FestivalOwner, claimFestivalOwnership } from "../../application/festival-ownership.js";
import { listFestivalCreationOrphans, quarantineFestival, restoreQuarantinedFestival, rollbackFestivalCreation } from "../../application/festival-creation.js";
import { FESTIVAL_CLAIM_ENTRY } from "../../application/session-claim.js";
import { listStalePortfolioAssignments, readPortfolioState, setPortfolioPaused, setPortfolioWorkerLimit } from "../../application/portfolio-state.js";
import { sessionIdOf } from "../../application/session-id.js";
import type { LoopTracker } from "../../application/loop-tracker.js";
import { lstat, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { referencesForTask, validateVisualReferences } from "../../application/visual-references.js";
import { visualEvidenceStatus } from "../../application/visual-evidence.js";
import { showCard, type OverlayUiLike } from "./overlay.js";
import { loadConfig, saveConfig } from "../../domain/config.js";
import { statusLineText, summarizeProgress } from "../../domain/progress.js";
import { DEFAULT_CONFIG, type OmpFestConfig } from "../../domain/types.js";
import { BROWSER_VERIFICATION_POLICY, IDEA_INTERVIEW, PLAN_GUIDE, markerInterviewKickoff, planInterviewKickoff } from "../../domain/orientation.js";
import type { CampCli, CampDetect, FestCli } from "../../ports.js";
import { Supervisor, SUPERVISOR_POLICY } from "../../application/supervisor.js";
import { supervisorCommands } from "./supervisor-commands.js";
import { qualityCommands } from "./quality-commands.js";
import { conflictCommands } from "./conflict-commands.js";
import { draftCommands } from "./draft-commands.js";
import { supervisorPortfolioQueue, supervisorQueue } from "./supervisor-tools.js";
import { flowCommands } from "./flow-commands.js";
import type { PortfolioCommandData } from "./supervisor-commands.js";

export interface CommandDeps {
  fest: FestCli;
  camp: CampCli;
  detect: CampDetect;
  tracker?: LoopTracker;
  supervisor?: Supervisor;
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
  appendEntry?(customType: string, data: unknown): void;
}

interface CommandCtx {
  cwd: string;
  sessionManager?: { getSessionId?(): string };
  agent?: { kind?: "main" | "sub" };
  ui: OverlayUiLike & {
    notify(message: string, type?: string): void;
    select?(
      title: string,
      options: (string | { label: string; description?: string })[],
      opts?: Record<string, unknown>,
    ): Promise<string | undefined>;
    confirm?(title: string, message: string, opts?: Record<string, unknown>): Promise<boolean>;
    input?(title: string, placeholder?: string, opts?: Record<string, unknown>): Promise<string | undefined>;
  };
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
      const picked =
        typeof ctx.ui.select === "function"
          ? await ctx.ui.select(
              `Multiple festivals match "${selector}"`,
              match.matches.map((f) => ({ label: f.id, description: f.status })),
            )
          : undefined;
      const resolved = picked ? matchFestival(all, picked) : undefined;
      if (resolved?.kind === "match") {
        return resolved.festival.path;
      }
      throw new Error(`Ambiguous festival "${selector}" — matches: ${match.matches.map((f) => f.id).join(", ")}`);
    }
    if (match.kind === "match") {
      return match.festival.path;
    }
    throw new Error(`No festival matches "${selector}" — known: ${all.map((f) => f.id).join(", ") || "none"}`);
  }
  const claimed = location.campRoot && deps.tracker
    ? await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), location.campRoot)
    : undefined;
  if (claimed) return claimed;
  throw new Error("No festival selected for this omp session — use /fest select <festival>.");
}

async function coordinatorOnly(pi: PiCommandsLike, deps: CommandDeps, ctx: CommandCtx, festivalDir: string): Promise<boolean> {
  const owner = await festivalOwner(festivalDir);
  if (owner?.sessionId === sessionIdOf(ctx)) return true;
  send(pi, "fest-status", `This action belongs to the festival coordinator${owner ? ` (${owner.sessionId})` : ""}. Use /fest join to collaborate; task work goes through fest_team.`);
  return false;
}

const RAW_READ_COMMANDS: Record<string, true> = { list: true, show: true, status: true, rules: true, context: true, markers: true, version: true, types: true, chain: true, feedback: true, links: true, watch: true, deps: true, parse: true, tokens: true, "--help": true };

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
  /** Drives the interactive editor: bool toggles, enum/list pick from choices, text prompts via ui.input. */
  kind: "bool" | "enum" | "list" | "text";
  choices?: readonly string[];
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

const GATE_PRESETS = ["ui", "camp-notify", "webhook", "ui,camp-notify", "ui,camp-notify,webhook", "none"] as const;

const SETTING_SPECS: SettingSpec[] = [
  { key: "statusLine", desc: "festival progress in the omp status line", kind: "bool", parse: BOOL },
  { key: "watchTransitions", desc: "notify on festival lifecycle moves (planning→ready→active)", kind: "bool", parse: BOOL },
  { key: "progressWidget", desc: "persistent progress widget above the editor", kind: "bool", parse: BOOL },
  { key: "pauseAtGates", desc: "stop for human approval at gates", kind: "bool", parse: BOOL },
  { key: "evidenceRequiredOnGates", desc: "require evidence text on gate approval", kind: "bool", parse: BOOL },
  { key: "autoCommitAfterTask", desc: "auto fest_commit after task completed", kind: "enum", choices: ["ask", "always", "never"], parse: enumOf(["ask", "always", "never"]) },
  { key: "autonomyCeiling", desc: "max autonomy level", kind: "enum", choices: ["low", "medium", "high"], parse: enumOf(["low", "medium", "high"]) },
  {
    key: "gateNotify",
    desc: "gate notification channels (comma list: ui,camp-notify,webhook; 'none' disables)",
    kind: "list",
    choices: GATE_PRESETS,
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
    kind: "text",
    parse: (raw) => (raw === undefined ? err("expected a URL or 'none'") : val(raw === "none" ? undefined : raw)),
  },
];

const formatSetting = (value: unknown): string => (value === undefined ? "—" : JSON.stringify(value));

/** One interactive settings pass: pick a key → edit it → repeat until Done. */
async function interactiveSettings(ctx: CommandCtx, dir: string): Promise<boolean> {
  if (typeof ctx.ui.select !== "function") {
    return false;
  }
  for (;;) {
    const config = await loadConfig(dir);
    const choice = await ctx.ui.select(
      "omp-fest settings",
      [
        ...SETTING_SPECS.map((spec) => ({
          label: spec.key,
          description: `${formatSetting(config[spec.key])} — ${spec.desc}`,
        })),
        { label: "reset", description: "restore all defaults" },
        { label: "done", description: "close settings" },
      ],
    );
    if (choice === undefined || choice === "done") {
      return true;
    }
    if (choice === "reset") {
      await saveConfig(dir, { ...DEFAULT_CONFIG, webhookUrl: undefined });
      ctx.ui.notify("Settings reset to defaults.", "info");
      continue;
    }
    const spec = SETTING_SPECS.find((s) => s.key === choice);
    if (!spec) {
      continue;
    }
    const current = config[spec.key];
    if (spec.kind === "bool") {
      const next = !current;
      await saveConfig(dir, { [spec.key]: next });
      ctx.ui.notify(`${spec.key} = ${next}`, "info");
      continue;
    }
    let value: unknown;
    if (spec.kind === "text") {
      value = await ctx.ui.input?.(`${spec.key} — ${spec.desc}`, "type 'none' to clear");
      if (value === undefined) {
        continue;
      }
      value = value === "none" ? undefined : value;
    } else if (typeof ctx.ui.select === "function") {
      const picked = await ctx.ui.select(
        `${spec.key} (current: ${formatSetting(current)})`,
        spec.choices?.map((c) => ({ label: c, description: spec.desc })) ?? [],
      );
      if (picked === undefined) {
        continue;
      }
      value = spec.kind === "list" ? (picked === "none" ? [] : picked.split(",")) : picked;
    }
    await saveConfig(dir, { [spec.key]: value });
    ctx.ui.notify(`${spec.key} = ${formatSetting(value)}`, "info");
  }
}

export function registerCommands(pi: PiCommandsLike, deps: CommandDeps): void {
  const supervisor = deps.supervisor ?? new Supervisor();
  const subs: Record<string, Sub> = {
    ...supervisorCommands(pi, supervisor, {
      isMainSession: (ctx) => ctx.agent?.kind !== "sub",
      queue: async (ctx) => {
        if (!deps.tracker) throw new Error("Supervisor session tracker unavailable");
        return (await supervisorQueue({ ...deps, tracker: deps.tracker }, supervisor, sessionIdOf(ctx), ctx.cwd)).queue;
      },
      portfolio: async (ctx): Promise<PortfolioCommandData> => {
        const location = await deps.detect.locate(ctx.cwd);
        if (!location.campRoot) throw new Error("Portfolio requires a camp root.");
        const sid = sessionIdOf(ctx);
        if (!deps.tracker) throw new Error("Supervisor session tracker unavailable");
        const snapshot = await supervisorPortfolioQueue({ ...deps, tracker: deps.tracker }, supervisor, sid, ctx.cwd);
        const state = await readPortfolioState(location.campRoot);
        const owned = new Set(snapshot.festivals.map((festival) => festival.id));
        const activeAssignments = state.assignments.filter((row) =>
          owned.has(row.festival) && (row.status === "assigned" || row.status === "running" || row.status === "blocked" || row.status === "submitted"),
        );
        const fileLockConflicts = snapshot.locks.map((lock) => ({
          festival: lock.festival ?? "unknown festival",
          task: lock.task ?? "active write",
          files: lock.files,
          reason: `${lock.worker ?? lock.sessionId} is writing in ${lock.workingDir}`,
        }));
        const staleAssignments = (await listStalePortfolioAssignments(location.campRoot, 15 * 60_000))
          .filter((row) => owned.has(row.festival));
        return {
          workerLimit: snapshot.queue.workerLimit,
          activeWorkers: snapshot.queue.activeWorkers,
          availableSlots: snapshot.queue.availableSlots,
          paused: snapshot.queue.paused,
          festivalRows: snapshot.festivals.map((row) => ({
            festival: row.id,
            status: row.status ?? "unknown",
            progress: typeof row.progress === "string" ? row.progress : undefined,
          })),
          candidates: snapshot.queue.candidates,
          waiting: snapshot.queue.waiting,
          activeAssignments,
          failedTasks: state.assignments.filter((row) => row.status === "failed" && owned.has(row.festival)),
          fileLockConflicts,
          staleAssignments,
          errors: snapshot.errors,
        };
      },
      setPortfolioWorkerLimit: async (ctx, limit) => {
        const location = await deps.detect.locate(ctx.cwd);
        if (!location.campRoot) throw new Error("Portfolio limit requires a camp root.");
        if (!deps.tracker) throw new Error("Supervisor session tracker unavailable");
        const snapshot = await supervisorPortfolioQueue({ ...deps, tracker: deps.tracker }, supervisor, sessionIdOf(ctx), ctx.cwd);
        if (!snapshot.festivals.length) throw new Error("Only a session that owns at least one festival may change portfolio settings.");
        return setPortfolioWorkerLimit(location.campRoot, limit);
      },
      setPortfolioPaused: async (ctx, paused) => {
        const location = await deps.detect.locate(ctx.cwd);
        if (!location.campRoot) throw new Error("Portfolio pause requires a camp root.");
        if (!deps.tracker) throw new Error("Supervisor session tracker unavailable");
        const snapshot = await supervisorPortfolioQueue({ ...deps, tracker: deps.tracker }, supervisor, sessionIdOf(ctx), ctx.cwd);
        if (!snapshot.festivals.length) throw new Error("Only a session that owns at least one festival may change portfolio settings.");
        await setPortfolioPaused(location.campRoot, paused);
      },
    }),
    ...qualityCommands(pi, { ...deps, supervisor }),
    ...conflictCommands(pi, deps),
    ...draftCommands(pi, deps),
    ...flowCommands(pi, deps.detect),
    "": {
      desc: "festival dashboard: camp, active festival, progress, gates",
      run: async (_args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        if (location.kind === "outside") {
          send(pi, "fest-status", "Not inside a camp. `camp init` creates one; `fest init` works standalone.");
          return;
        }
        const dir = location.festivalDir ?? (location.campRoot && deps.tracker
          ? await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), location.campRoot)
          : undefined);
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
        const shown = await showCard(ctx.ui, {
          title: `✦ camp ${location.campName ?? "fest"}`,
          lines,
          footer: "esc close · /fest help for commands",
        });
        if (!shown) {
          send(pi, "fest-status", lines.join("\n"));
        }
      },
    },
    next: {
      desc: "pull the next festival unit into the conversation: /fest next [festival]",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx, args[0]);
        const unit = await deps.fest.next(dir);
        const visual = await validateVisualReferences(dir, deps.detect);
        if (visual.issues.length > 0) {
          send(pi, "fest-next", `Visual references need repair:\n${visual.issues.join("\n")}`);
          return;
        }
        const refs = unit.kind === "task" ? await referencesForTask(dir, unit.doc) : [];
        send(pi, "fest-next", JSON.stringify({
          ...unit,
          ...(unit.kind === "task" ? { browserVerification: BROWSER_VERIFICATION_POLICY } : {}),
          ...(refs.length ? { visualReferences: refs } : {}),
        }, null, 2));
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
        const output = await deps.fest.show(dir, args[1]);
        const name = dir.split("/").filter(Boolean).at(-1) ?? "festival";
        const shown = await showCard(ctx.ui, {
          title: `✦ ${name}`,
          lines: output.split("\n"),
          footer: "esc/q close · j/k/↑↓ scroll · space pgdn",
        });
        if (!shown) {
          send(pi, "fest-show", output);
        }
      },
    },
    task: {
      desc: "task state: /fest task <show|done|block|defer|unblock|reset|update> [task] [reason|pct]",
      run: async (args, ctx) => {
        const [action = "show", ...rest] = args;
        const dir = await festivalDirOf(deps, ctx);
        if (action !== "show" && !(await coordinatorOnly(pi, deps, ctx, dir))) return;
        if (action === "done") {
          const outstanding = supervisor.state(sessionIdOf(ctx)).workers.filter((worker) => worker.status !== "accepted");
          if (outstanding.length) {
            send(pi, "fest-status", "Completion blocked: review outstanding worker submissions before completing festival tasks.");
            return;
          }
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
        const dir = await festivalDirOf(deps, ctx, args[0]);
        if (!(await coordinatorOnly(pi, deps, ctx, dir))) return;
        const visual = await validateVisualReferences(dir, deps.detect);
        if (visual.issues.length > 0) {
          send(pi, "fest-status", `Promotion blocked by visual references:\n${visual.issues.join("\n")}`);
          return;
        }
        send(pi, "fest-status", `${await deps.fest.promote(cwd, args[0])}\n\n${SUPERVISOR_POLICY}`);
      },
    },
    validate: {
      desc: "structure check: /fest validate [--fix]",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx);
        if (args.includes("--fix") && !(await coordinatorOnly(pi, deps, ctx, dir))) return;
        const result = await deps.fest.validate(dir, args.includes("--fix"));
        const visual = await validateVisualReferences(dir, deps.detect);
        const verification = visual.issues.length ? undefined : await visualEvidenceStatus(dir, deps.detect);
        send(pi, "fest-status", `score: ${result.score}\n${result.output}\nVisual references: ${visual.issues.length ? visual.issues.join("\n") : "valid"}` +
          (verification ? `\nVisual verification: ${verification.verified.length} verified; ${verification.untested.length} untested\n${verification.issues.join("\n")}` : ""));
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
        if (args[0] === "advance" && !(await coordinatorOnly(pi, deps, ctx, dir))) return;
        send(pi, "fest-status", args[0] === "advance" ? await deps.fest.workflowAdvance(dir) : await deps.fest.workflowStatus(dir));
      },
    },
    approve: {
      desc: "approve the pending gate checkpoint (human attestation)",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx);
        if (!(await coordinatorOnly(pi, deps, ctx, dir))) return;
        const visual = await validateVisualReferences(dir, deps.detect);
        const verification = visual.issues.length ? undefined : await visualEvidenceStatus(dir, deps.detect);
        if (visual.issues.length || verification?.issues.length) {
          send(pi, "fest-gate", `Approval blocked:\n${[...visual.issues, ...(verification?.issues ?? [])].join("\n")}`);
          return;
        }
        const untested = verification?.untested ?? [];
        const warning = untested.map((entry) => `UNTESTED ${entry.page}/${entry.check}: ${entry.proof}`).join("\n");
        if (untested.length && !ctx.ui.confirm && !args.includes("--allow-untested")) {
          send(pi, "fest-gate", `${warning}\nGate remains pending. Human may explicitly waive these checks with /fest approve --allow-untested.`);
          return;
        }
        const lines = [
          `Festival: ${dir.split("/").filter(Boolean).at(-1) ?? "festival"}`,
          "",
          warning || "All recorded checks have evidence.",
          ...(verification?.verified.map((entry) => `VERIFIED ${entry.page}/${entry.check}: ${entry.proof}`) ?? []),
        ];
        const floated = await showCard(ctx.ui, {
          title: "⛔ Gate review",
          lines,
          footer: "esc/q close — then choose approve or cancel",
        });
        const yes =
          typeof ctx.ui.confirm === "function"
            ? await ctx.ui.confirm("Approve gate", floated ? `Approve the pending gate in ${dir.split("/").filter(Boolean).at(-1) ?? "festival"}?` : `${lines.join("\n")}\n\nApprove the pending gate?`)
            : true;
        if (!yes) {
          send(pi, "fest-gate", "Approval cancelled — the gate stays pending.");
          return;
        }
        const currentReferences = await validateVisualReferences(dir, deps.detect);
        const currentEvidence = currentReferences.issues.length ? undefined : await visualEvidenceStatus(dir, deps.detect);
        if (currentReferences.issues.length || JSON.stringify(currentEvidence) !== JSON.stringify(verification)) {
          send(pi, "fest-gate", "References or evidence changed during review. Review the gate again.");
          return;
        }
        send(pi, "fest-gate", await deps.fest.workflowApprove(dir));
      },
    },
    reject: {
      desc: "reject the pending checkpoint: /fest reject <reason>",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx);
        if (!(await coordinatorOnly(pi, deps, ctx, dir))) return;
        let reason = args.join(" ");
        if (!reason && typeof ctx.ui.input === "function") {
          const typed = await ctx.ui.input("Reject checkpoint — reason", "what should be fixed?");
          if (typed === undefined) {
            send(pi, "fest-gate", "Rejection cancelled — the gate stays pending.");
            return;
          }
          reason = typed;
        }
        send(pi, "fest-gate", await deps.fest.workflowReject(dir, reason || "no reason given"));
      },
    },
    parallel: {
      desc: "pending tasks grouped by sequence — spawn a subagent per lane",
      run: async (args, ctx) => {
        const dir = await festivalDirOf(deps, ctx, args[0]);
        const visual = await validateVisualReferences(dir, deps.detect);
        if (visual.issues.length > 0) {
          send(pi, "fest-status", `Visual references need repair:\n${visual.issues.join("\n")}`);
          return;
        }
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
        const lines = ["Candidate tasks by lane (check dependencies and file overlap before dispatch):", SUPERVISOR_POLICY, BROWSER_VERIFICATION_POLICY];
        for (const [seq, files] of groups) {
          lines.push(`\n${seq}`);
          for (const file of files) {
            lines.push(`  • ${file}`);
            const refs = await referencesForTask(dir, await readFile(join(dir, file), "utf8"));
            for (const ref of refs) {
              lines.push(`    Visual reference: ${ref.spec} (wireframe: ${ref.wireframe})`);
            }
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
        const shown = await showCard(ctx.ui, { title: "✦ fest doctor", lines });
        if (!shown) {
          send(pi, "fest-doctor", lines.join("\n"));
        }
      },
    },
    cmd: {
      desc: "raw fest passthrough: /fest cmd <args> — e.g. /fest cmd list --json",
      run: async (args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        const cwd = location.festivalDir ?? (location.campRoot && deps.tracker
          ? await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), location.campRoot)
          : undefined) ?? location.campRoot;
        if (!cwd) {
          send(pi, "fest-status", "Not inside a camp.");
          return;
        }
        if (location.campRoot && resolve(cwd) !== resolve(location.campRoot)) {
          if (!(await coordinatorOnly(pi, deps, ctx, cwd))) return;
        } else if (!RAW_READ_COMMANDS[args[0] ?? ""]) {
          send(pi, "fest-status", "Mutating raw fest commands require an explicitly selected festival. Use /fest select <festival> first; read-only camp commands remain available.");
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
    select: {
      desc: "select and optionally transfer a festival to this omp session: /fest select [festival]",
      run: async (args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        if (!location.campRoot) {
          ctx.ui.notify("Not inside a camp", "warning");
          return;
        }
        const festivals = await deps.detect.listFestivals(location.campRoot);
        let selector = args.join(" ").trim();
        if (!selector && typeof ctx.ui.select === "function") {
          selector = await ctx.ui.select(
            "Select festival for this omp session",
            festivals.map((festival) => ({ label: festival.id, description: `${festival.name} · ${festival.status}` })),
          ) ?? "";
        }
        if (!selector) {
          send(pi, "fest-status", festivals.map((festival) => `${festival.id} (${festival.status})`).join("\n") || "No festivals found.");
          return;
        }
        const match = matchFestival(festivals, selector);
        if (match.kind !== "match") {
          send(pi, "fest-status", match.kind === "ambiguous"
            ? `Ambiguous festival "${selector}": ${match.matches.map((festival) => festival.id).join(", ")}`
            : `No festival matches "${selector}".`);
          return;
        }
        const pending = (await listFestivalCreationOrphans(location.campRoot)).find((item) => item.receipt.name === match.festival.id || item.festivalDir === match.festival.path);
        if (pending) {
          send(pi, "fest-status", `${match.festival.id} has an incomplete scaffold transaction. Review /fest orphans before selecting it.`);
          return;
        }
        const sid = sessionIdOf(ctx);
        const current = await festivalOwner(match.festival.path);
        let transfer: FestivalOwner | undefined;
        if (current && current.sessionId !== sid) {
          const confirmed = typeof ctx.ui.confirm === "function"
            ? await ctx.ui.confirm("Transfer festival ownership", `${match.festival.id} is owned by omp session ${current.sessionId}. Transfer it to this session?`)
            : false;
          if (!confirmed) {
            send(pi, "fest-status", `Ownership unchanged — ${match.festival.id} remains with ${current.sessionId}.`);
            return;
          }
          transfer = current;
        }
        if (transfer) await joinFestivalTeam(location.campRoot, match.festival.path, sid, transfer.sessionId);
        const ownership = await claimFestivalOwnership(match.festival.path, sid, transfer);
        if (ownership.kind !== "claimed") {
          send(pi, "fest-status", `Ownership changed concurrently; ${match.festival.id} remains with ${ownership.owner?.sessionId ?? "another session"}.`);
          return;
        }
        try {
          if (ownership.transferredFrom) {
            await transferFestivalTeamCoordinator(location.campRoot, match.festival.path, ownership.transferredFrom.sessionId, sid);
          } else {
            await joinFestivalTeam(location.campRoot, match.festival.path, sid, sid);
          }
        } catch (error) {
          if (ownership.transferredFrom) {
            await claimFestivalOwnership(match.festival.path, ownership.transferredFrom.sessionId, ownership.owner).catch(() => undefined);
          }
          send(pi, "fest-status", `Festival selection failed while updating team coordination: ${String(error)}`);
          return;
        }
        deps.tracker?.claimFestival(sid, match.festival.path);
        pi.appendEntry?.(FESTIVAL_CLAIM_ENTRY, { festivalId: match.festival.id, festivalDir: match.festival.path, campRoot: location.campRoot });
        send(pi, "fest-status", `Selected ${match.festival.id} for this omp session${ownership.transferredFrom ? `; transferred from ${ownership.transferredFrom.sessionId}` : ""}.`);
      },
    },
    join: {
      desc: "join a festival for this omp session without transferring ownership: /fest join <festival>",
      run: async (args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        if (!location.campRoot) {
          ctx.ui.notify("Not inside a camp", "warning");
          return;
        }
        const selector = args.join(" ").trim();
        if (!selector) {
          send(pi, "fest-status", "Choose a festival explicitly: /fest join <festival-id>. New sessions remain unselected.");
          return;
        }
        const match = matchFestival(await deps.detect.listFestivals(location.campRoot), selector);
        if (match.kind !== "match") {
          send(pi, "fest-status", match.kind === "ambiguous"
            ? `Ambiguous festival "${selector}": ${match.matches.map((festival) => festival.id).join(", ")}`
            : `No festival matches "${selector}".`);
          return;
        }
        const pending = (await listFestivalCreationOrphans(location.campRoot)).find((item) => item.receipt.name === match.festival.id || item.festivalDir === match.festival.path);
        if (pending) {
          send(pi, "fest-status", `${match.festival.id} has an incomplete scaffold transaction. Review /fest orphans before joining it.`);
          return;
        }
        const owner = await festivalOwner(match.festival.path);
        if (!owner) {
          send(pi, "fest-status", `${match.festival.id} has no coordinator. Use /fest select ${match.festival.id} in the session that will coordinate it.`);
          return;
        }
        const sid = sessionIdOf(ctx);
        await joinFestivalTeam(location.campRoot, match.festival.path, sid, owner.sessionId);
        deps.tracker?.claimFestival(sid, match.festival.path);
        pi.appendEntry?.(FESTIVAL_CLAIM_ENTRY, { festivalId: match.festival.id, festivalDir: match.festival.path, campRoot: location.campRoot });
        send(pi, "fest-status", `Joined ${match.festival.id} as a collaborator. Ownership remains with ${owner.sessionId}; coordinate tasks through fest_team.`);
      },
    },
    team: {
      desc: "show the shared festival team board: /fest team [festival]",
      run: async (args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        if (!location.campRoot) throw new Error("Not inside a camp.");
        const dir = await festivalDirOf(deps, ctx, args.join(" ").trim() || undefined);
        const team = await readFestivalTeam(location.campRoot, dir);
        const owner = await festivalOwner(dir);
        if (!team) {
          send(pi, "fest-status", `No team board exists for ${basename(dir)}. The coordinator selects with /fest select; collaborators join with /fest join.`);
          return;
        }
        const lines = [
          `Festival: ${basename(dir)}`,
          `Coordinator session: ${team.coordinatorSessionId ?? owner?.sessionId ?? "not recorded"}`,
          `Assignments: ${team.assignments.length}`,
          ...team.assignments.map((assignment) => `- ${assignment.task} · ${assignment.status} · ${assignment.sessionId}${assignment.report ? ` · ${assignment.report.slice(0, 180)}` : ""}`),
        ];
        send(pi, "fest-status", lines.join("\n"));
      },
    },
    orphans: {
      desc: "review incomplete or unowned planning festivals; quarantine is reversible and always asks first: /fest orphans",
      run: async (args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        if (!location.campRoot) throw new Error("Not inside a camp.");
        const root = location.campRoot;
        const journals = await listFestivalCreationOrphans(root);
        const festivals = await deps.detect.listFestivals(root);
        const journalNames = new Set(journals.map((orphan) => orphan.receipt.name));
        const legacy: typeof festivals = [];
        for (const festival of festivals.filter((item) => item.status === "planning" && !journalNames.has(item.id))) {
          const has = async (file: string) => {
            const info = await lstat(join(festival.path, file)).catch(() => undefined);
            return Boolean(info?.isFile() && !info.isSymbolicLink());
          };
          if (!(await has(".omp-fest-owner.json")) && !(await has("APPROVED_PLAN.json")) && !(await has(".omp-fest-creation.json"))) legacy.push(festival);
        }
        const [action, selector] = args;
        if (action === "rollback") {
          const found = journals.find((item) => item.receipt.id === selector);
          if (!found) throw new Error("No matching creation transaction. Run /fest orphans to inspect exact IDs.");
          const confirmed = await ctx.ui.confirm?.("Remove incomplete festival creation", `Roll back only ${found.receipt.name} from transaction ${found.receipt.id}? Removal proceeds only if its on-disk marker matches this transaction; otherwise it is preserved for manual inspection.`);
          if (!confirmed) {
            send(pi, "fest-status", "No cleanup performed.");
            return;
          }
          const remaining = await rollbackFestivalCreation(found.receipt, found.festivalDir);
          send(pi, "fest-status", remaining
            ? `Preserved ${remaining.festivalDir ?? found.receipt.name}; transaction could not prove safe ownership. Inspect it manually.`
            : `Rolled back incomplete creation ${found.receipt.name}.`);
          deps.detect.bustCache?.();
          return;
        }
        if (action === "quarantine") {
          const found = legacy.find((item) => item.id === selector);
          if (!found) throw new Error("No matching unowned legacy planning candidate. Run /fest orphans to inspect candidates.");
          const confirmed = await ctx.ui.confirm?.("Quarantine planning festival", `Move ${found.id} out of fest listings into .ompfest/orphans? It has no owner or approved plan. The move is reversible with /fest orphans restore.`);
          if (!confirmed) {
            send(pi, "fest-status", "No cleanup performed.");
            return;
          }
          const destination = await quarantineFestival(root, found.path);
          deps.detect.bustCache?.();
          send(pi, "fest-status", `Quarantined ${found.id} to ${destination}. Restore with /fest orphans restore ${basename(destination)}.`);
          return;
        }
        if (action === "restore") {
          if (!selector) throw new Error("Specify the exact quarantine folder id from /fest orphans.");
          const dir = join(root, ".ompfest", "orphans", selector);
          const confirmed = await ctx.ui.confirm?.("Restore quarantined festival", `Restore ${selector} to festivals/planning?`);
          if (!confirmed) {
            send(pi, "fest-status", "No restore performed.");
            return;
          }
          const restored = await restoreQuarantinedFestival(root, dir);
          deps.detect.bustCache?.();
          send(pi, "fest-status", `Restored ${basename(restored)}.`);
          return;
        }
        const lines = [
          "Incomplete creation transactions (not automatically removed):",
          ...(journals.length ? journals.map((item) => `- ${item.receipt.id} · ${item.receipt.name} · ${item.festivalDir ?? "no festival directory recorded"} · ${item.receipt.sessionId}`) : ["- none"]),
          "Unowned legacy planning candidates (inspect before quarantine):",
          ...(legacy.length ? legacy.map((item) => `- ${item.id} · ${item.path}`) : ["- none"]),
          "Actions: /fest orphans rollback <transaction-id> · /fest orphans quarantine <festival-id> · /fest orphans restore <quarantine-id>",
          "Plan drafts and previews in .ompfest/plans are not orphans and are never removed by this flow.",
        ];
        send(pi, "fest-status", lines.join("\n"));
      },
    },
    settings: {
      desc: "view or toggle plugin settings (.ompfest.json): /fest settings [key] [value]",
      run: async (args, ctx) => {
        const location = await deps.detect.locate(ctx.cwd);
        const dir = location.campRoot ?? ctx.cwd;
        const config = await loadConfig(dir);
        if (args.length === 0) {
          if (await interactiveSettings(ctx, dir)) {
            return;
          }
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
    description: "Native festival control: /fest [flows|draft|finish|conflicts|blockers|resume|release|workers|portfolio|dispatch|pause|review|next|status|show|select|join|team|orphans|task|plan|promote|validate|markers|workflow|approve|reject|parallel|settings|doctor|cmd|camp|idea|help]",
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
