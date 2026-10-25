/**
 * omp-fest — composition root.
 *
 * Registers the fest.build loop (tools, commands, per-turn state digest,
 * transition watcher, status line, gate notifications) on the omp
 * ExtensionAPI. Loaded by omp as a git submodule at
 * `.omp/extensions/omp-fest` — the runtime injects zod and the pi SDK; SVG.js
 * plus svgdom provide deterministic headless wireframe generation.
 *
 * Event/result field shapes below mirror omp's ExtensionAPI
 * (packages/coding-agent/src/extensibility/extensions/types.ts) — verified
 * against upstream: before_agent_start.message, tool_call/tool_result
 * additionalContext, before_subagent_spawn {note, block, reason, model}.
 */
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve, sep } from "node:path";

import { CachedDetect } from "./src/application/detect-cache.js";
import { watchCampTransitions } from "./src/application/camp-watcher.js";
import { LoopTracker } from "./src/application/loop-tracker.js";
import { Supervisor, SUPERVISOR_ENTRY, SUPERVISOR_POLICY } from "./src/application/supervisor.js";
import { orientSession } from "./src/application/orient.js";
import { restoreClaimFromBranch } from "./src/application/session-claim.js";
import { claimedFestivalDir } from "./src/application/fest-resolve.js";
import { festivalOwner, touchFestivalOwnership } from "./src/application/festival-ownership.js";
import { reconcileCamp } from "./src/application/reconcile.js";
import { buildStateDigest } from "./src/application/state-digest.js";
import { sessionIdOf } from "./src/application/session-id.js";
import { CampCliAdapter } from "./src/adapters/cli/camp-cli.js";
import { FestCliAdapter } from "./src/adapters/cli/fest-cli.js";
import { NodeExecRunner } from "./src/adapters/cli/node-exec.js";
import { CampFsDetect } from "./src/adapters/fs/camp-fs.js";
import { registerCommands } from "./src/adapters/omp/commands.js";
import { notifyGate, OmpNotifier } from "./src/adapters/omp/notify.js";
import { registerTools, type PiLike } from "./src/adapters/omp/tools.js";
import { loadConfig } from "./src/domain/config.js";
import { statusLineText, summarizeProgress } from "./src/domain/progress.js";
import { readFestivalWorktrees } from "./src/application/festival-worktrees.js";
import { campRules, campRulesCount, syncCampRules } from "./src/application/festival-rules.js";
import { planInterviewKickoff } from "./src/domain/orientation.js";
import { classifyPlanningIntent, planningIntentGuidance } from "./src/domain/planning-intent.js";
import { INTEGRATION_GUIDE } from "./src/application/integration-review.js";
import { NativeWriteLockInvocations, packageInstallCheckout, projectRootForFile, reserveProjectCheckout, reserveProjectFiles, releaseProjectFiles, parseSupportedPackageInstall, shellRedirectTargets } from "./src/application/project-conflicts.js";
import { readPortfolioState, updatePortfolioAssignment, updatePortfolioAssignmentRuntime } from "./src/application/portfolio-state.js";
import { releaseFestivalTask } from "./src/application/festival-team.js";
import type { WorkerAssignment } from "./src/application/supervisor.js";

interface ExtensionContextLike {
  cwd: string;
  agent?: { kind: "main" | "sub"; id: string; name: string };
  sessionManager?: { getSessionId?(): string; getBranch?(): unknown[] };
  getAsyncJobSnapshot?(): { running?: { id: string; type: string; status: string; label: string; agentId?: string }[]; recent?: { id: string; type: string; status: string; label: string; agentId?: string }[] } | null;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget?(key: string, content: string[] | undefined, options?: { placement?: string }): void;
    input?(title: string, placeholder?: string, options?: Record<string, unknown>): Promise<string | undefined>;
    confirm?(title: string, message: string, options?: Record<string, unknown>): Promise<boolean>;
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

interface InputEventShape {
  text: string;
  images?: unknown[];
  source?: string;
}

interface ToolCallEvent {
  toolName?: string;
  toolCallId: string;
  input?: Record<string, unknown>;
}

interface ToolResultEventShape extends ToolCallEvent {
  isError?: boolean;
  result?: unknown;
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
  input: InputEventShape;
  session_start: unknown;
  session_branch: unknown;
  session_tree: unknown;
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
  | { text: string; images?: unknown[]; handled?: boolean }
  | undefined;

interface ExtensionApiLike {
  zod: unknown;
  logger?: { warn(message: string): void };
  getAllTools?(): { name: string; description: string; sourceInfo?: { source?: string; type?: string; name?: string } }[];
  getActiveTools?(): string[];
  on<K extends keyof FestEventMap>(
    event: K,
    handler: (event: FestEventMap[K], ctx: ExtensionContextLike) => HandlerResult | Promise<HandlerResult>,
  ): void;
  registerTool(tool: Record<string, unknown>): void;
  registerCommand(name: string, options: Record<string, unknown>): void;
  sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>): void;
  sendUserMessage?(text: string, options?: { deliverAs?: "steer" | "followUp" | "aside" }): void;
  setLabel(label: string): void;
  /** Persists a custom entry into the session transcript (durable per-session state). */
  appendEntry?(customType: string, data: unknown): void;
}


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
  if (typeof input.filePath === "string") raw.push(input.filePath);
  return raw
    // "xd:/fest_raw"-style scheme references are not file paths — locking them
    // would create a literal "xd:" directory inside the camp.
    .filter((p): p is string => typeof p === "string" && p.length > 0 && !/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(p))
    .map((p) => (isAbsolute(p) ? p : resolve(cwd, p)));
}
function writeTool(toolName: string): boolean {
  return ["write", "edit", "patch", "apply_patch", "write_file", "edit_file", "multiedit"].includes(toolName);
}

function shellWritesFiles(command: string): boolean {
  return /\b(?:tee|cp|mv|rm|touch|mkdir|truncate|apply_patch)\b/.test(command) ||
    /\b(?:sed|perl)\b[^;\n]*\s-i(?:\s|$)/.test(command) ||
    /\bgit\s+apply\b/.test(command) ||
    /\bdd\b[^;\n]*\bof=/.test(command) ||
    /\bawk\b[^;\n]*\s-i\s+inplace\b/.test(command) ||
    /\b(?:python(?:\d+(?:\.\d+)*)?|node|ruby|php)\s+(?:-c|-e|-r)\b/.test(command);
}

/** Redirect targets inside the camp or a Git checkout still need the write-lock path; /tmp noise does not. */
async function shellRedirectsProtected(command: string, cwd: string, campRoot: string): Promise<boolean> {
  const camp = resolve(campRoot);
  for (const target of shellRedirectTargets(command)) {
    const resolved = resolve(isAbsolute(target) ? target : resolve(cwd, target));
    if (resolved === camp || resolved.startsWith(`${camp}${sep}`)) return true;
    if (await projectRootForFile(resolved)) return true;
  }
  return false;
}



export default function ompFest(pi: ExtensionApiLike): void {
  const writeLocks = new NativeWriteLockInvocations();
  const releaseWriteLocks = async (locks: { projectDir: string; sessionId: string; assignmentId: string }[]) => {
    for (const lock of locks) {
      try {
        const result = await releaseProjectFiles(lock.projectDir, lock.sessionId, lock.assignmentId);
        if (result.kind === "busy") pi.logger?.warn(`omp-fest could not release write lock ${lock.assignmentId}; inspect /fest conflicts.`);
      } catch (error) {
        pi.logger?.warn(`omp-fest could not release write lock ${lock.assignmentId}: ${String(error)}`);
      }
    }
  };

  const exec = new NodeExecRunner();
  const fest = new FestCliAdapter(exec);
  const camp = new CampCliAdapter(exec);
  const detect = new CachedDetect(new CampFsDetect());
  const tracker = new LoopTracker();
  const supervisor = new Supervisor();



  const cwd = process.cwd();
  const deps = { fest, camp, detect, tracker, exec, supervisor, config: () => loadConfig(cwd), host: { getAllTools: pi.getAllTools?.bind(pi), getActiveTools: pi.getActiveTools?.bind(pi) } };

  registerTools(pi as unknown as PiLike, deps);
  registerCommands(pi, deps);

  pi.on("input", (event) => {
    if (!event.images?.length || event.source === "extension") {
      return undefined;
    }
    const match = /^\/fest\s+plan(?:\s+([\s\S]*))?$/.exec(event.text.trim());
    if (!match) {
      return undefined;
    }
    const intent = classifyPlanningIntent(match[1] ?? "", true);
    return {
      text: planInterviewKickoff(match[1] ?? "", planningIntentGuidance(intent)),
      images: event.images,
    };
  });

  const configFor = async () => loadConfig(cwd);
  const silentContext = (content: string): void => {
    pi.sendMessage(
      { customType: "fest-state", content, display: false },
      { triggerTurn: false },
    );
  };

  // Restore this session's claimed festival from its transcript — persisted
  // claims survive resume/branch/tree. Runs before orientation so the status
  // line and progress watcher land on the claimed festival, not whichever
  // active festival the camp-wide pick returns first.
  const restoreClaim = async (ctx: ExtensionContextLike): Promise<string | undefined> => {
    const branch = ctx.sessionManager?.getBranch?.();
    const sid = sessionIdOf(ctx);
    supervisor.restore(sid, branch ?? []);
    if (branch && branch.length > 0) {
      restoreClaimFromBranch(tracker, sid, branch);
    }
    const location = await detect.locate(ctx.cwd);
    return location.campRoot
      ? claimedFestivalDir(tracker, detect, sid, location.campRoot)
      : undefined;
  };
  const mirrorPortfolioRuntime = async (ctx: ExtensionContextLike, workers: WorkerAssignment[]): Promise<void> => {
    if (workers.length === 0) return;
    const location = await detect.locate(ctx.cwd);
    if (!location.campRoot) return;
    let state;
    try {
      state = await readPortfolioState(location.campRoot);
    } catch (error) {
      pi.logger?.warn(`omp-fest could not read portfolio runtime ledger: ${String(error)}`);
      return;
    }
    for (const worker of workers) {
      if (!worker.runtime) continue;
      const assignment = state.assignments.find((row) => row.id === worker.id);
      if (!assignment) continue;
      const observedAt = worker.runtime.observedAt;
      try {
        await updatePortfolioAssignmentRuntime(location.campRoot, worker.id, {
          ...(worker.runtime.runtimeId ? { runtimeId: worker.runtime.runtimeId } : {}),
          runtimeStatus: worker.runtime.status,
          runtimeObservedAt: observedAt,
        });
        if (worker.runtime.status === "failed" || worker.runtime.status === "exited") {
          const current = (await readPortfolioState(location.campRoot)).assignments.find((row) => row.id === worker.id);
          if (current && !["accepted", "failed", "released"].includes(current.status)) {
            const reason = worker.runtime.detail ?? `Native worker ${worker.runtime.status}`;
            await updatePortfolioAssignment(location.campRoot, worker.id, "failed", { failure: reason });
            const festival = (await detect.listFestivals(location.campRoot)).find((row) => basename(row.path) === current.festival);
            if (festival) await releaseFestivalTask(location.campRoot, festival.path, current.sessionId, worker.id, reason);
          }
        }
      } catch (error) {
        pi.logger?.warn(`omp-fest could not mirror portfolio runtime for ${worker.id}: ${String(error)}`);
      }
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    const config = await configFor();
    const notifier = new OmpNotifier(ctx.ui);
    const claimedDir = await restoreClaim(ctx);
    if (!(await fest.available())) {
      notifier.warn("fest CLI not found — npm i -g @obedience-corp/festival");
      return;
    }
    const orientation = await orientSession(ctx.cwd, detect, claimedDir);
    // Session briefing: after compaction/resume the model gets orientation but
    // not narrative — last progress events, open unit, pending decisions, worktrees.
    const briefingDir = orientation.location.festivalDir;
    if (briefingDir) {
      try {
        const events = await detect.readProgress(briefingDir);
        const recent = events.slice(-5).map((event) => `${event.ts} ${event.event}${event.task ? ` ${event.task}` : ""}`).join("; ");
        const progress = summarizeProgress(events);
        const worktrees = await readFestivalWorktrees(briefingDir).catch(() => []);
        const rulesCount = campRulesCount(await campRules(orientation.location.campRoot ?? briefingDir).catch(() => undefined));
        const notes = [
          `omp-fest briefing: festival ${orientation.location.festivalId ?? basename(briefingDir)} ${progress.completed}/${progress.total} done${progress.currentLabel ? `, at ${progress.currentLabel}` : ""}.`,
          rulesCount ? `camp rules: ${rulesCount} (RULES.md applies to every festival).` : "",
          recent ? `Recent: ${recent}` : "",
          progress.gatePending ? "A gate is PENDING human decision — do not approve it yourself; surface it and wait." : "",
          worktrees.length ? `Festival worktrees: ${worktrees.map((row) => row.worktreePath).join(", ")}` : "",
        ].filter(Boolean).join(" ");
        silentContext(notes);
      } catch { /* briefing is best-effort */ }
    }
    if (orientation.location.campRoot) {
      const campRoot = orientation.location.campRoot;
      void reconcileCamp(campRoot, async (root) => (await camp.projects(root)).map((project) => project.path)).then((summary) => {
        if (summary.total) silentContext(`omp-fest startup reconcile: ${summary.describe()}.`);
      }).catch((error: unknown) => pi.logger?.warn(`omp-fest startup reconcile failed: ${String(error)}`));
      void syncCampRules(campRoot).then((synced) => {
        if (synced) silentContext(`omp-fest: camp RULES.md synced into ${synced} festival(s).`);
      }).catch((error: unknown) => pi.logger?.warn(`omp-fest camp rules sync failed: ${String(error)}`));
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

  // Branch/tree rebuild a session's branch — the persisted claim must be
  // re-restored so the new leaf's picks stay on the claimed festival.
  pi.on("session_branch", async (_event, ctx) => {
    await restoreClaim(ctx);
    return undefined;
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restoreClaim(ctx);
    return undefined;
  });

  // Live state + rules injected into EVERY turn — survives compaction and
  // never goes stale, replacing the old one-shot orientation/compaction
  // re-inject.
  pi.on("before_agent_start", async (_event, ctx) => {
    const sid = sessionIdOf(ctx);
    const snapshot = ctx.getAsyncJobSnapshot?.();
    const jobs = [...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])].filter((job) => job.type === "task");
    const updates: string[] = [];
    const observedWorkers: WorkerAssignment[] = [];
    for (const assignment of supervisor.state(sid).workers) {
      if (!assignment.runtime?.runtimeId) continue;
      const job = jobs.find((item) => item.id === assignment.runtime?.runtimeId);
      const status = job?.status === "completed" ? "completed" : job?.status === "failed" ? "failed" : job?.status === "cancelled" ? "exited" : job?.status === "running" ? "running" : undefined;
      if (!job || !status || assignment.runtime.status === status) continue;
      observedWorkers.push(supervisor.observeRuntime(sid, { assignmentId: assignment.id, runtimeId: job.id, status, detail: `Native omp async task ${job.status}; ${job.label}` }));
      updates.push(`${assignment.task}: native worker ${job.status}`);
    }
    if (observedWorkers.length) {
      await mirrorPortfolioRuntime(ctx, observedWorkers);
      pi.appendEntry?.(SUPERVISOR_ENTRY, supervisor.state(sid));
    }
    const digest = await buildStateDigest(deps, ctx.cwd, sessionIdOf(ctx));
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
    if (!digest) return updates.length ? { message: { customType: "fest-state", content: `Native omp worker lifecycle: ${updates.join("; ")}. Review the existing worker result through fest_supervisor; do not relaunch or auto-accept.`, display: false } } : undefined;
    const location = await detect.locate(ctx.cwd);
    const festivalDir = location.festivalDir ?? (location.campRoot
      ? await claimedFestivalDir(tracker, detect, sid, location.campRoot)
      : undefined);
    const owner = festivalDir ? await festivalOwner(festivalDir) : undefined;
    if (owner?.sessionId === sid && festivalDir) {
      await touchFestivalOwnership(festivalDir, sid).catch(() => undefined);
    }
    const rolePolicy = owner?.sessionId === sid
      ? `${SUPERVISOR_POLICY}\n${INTEGRATION_GUIDE}`
      : digest.includes("festival collaborator")
        ? "Festival collaboration mode: claim only explicit eligible tasks through fest_team; the selected coordinator owns integration, review, task completion, gates and commits."
        : "";
    const state = supervisor.state(sid);
    return { message: { customType: "fest-state", content: `${updates.length ? `Native omp worker lifecycle: ${updates.join("; ")}. Review the existing result; never relaunch or auto-accept.\n` : ""}${digest}${rolePolicy ? `\n${rolePolicy}` : ""}\nDispatch: ${state.paused ? "paused" : "enabled"}; workers: ${state.workers.filter((worker) => worker.status !== "accepted").length} outstanding.`, display: false } };
  });

  // Pre-execution nudges for bypass paths (raw fest/camp, ad hoc todos,
  // untagged git commits).
  pi.on("tool_call", (event, ctx) => {
    return (async (): Promise<ToolCallResult | undefined> => {
      const toolName = event.toolName ?? "";
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      if (toolName.startsWith("fest_") || toolName.startsWith("camp_")) {
        return undefined;
      }
      const location = await detect.locate(ctx.cwd);
      if (!location.campRoot) {
        return undefined;
      }
      // writeLocks=false: worktree-per-festival and legacy projects run without
      // file/checkout reservations — every agent writes freely.
      const writeLocksEnabled = (await loadConfig(location.campRoot)).writeLocks;
      if (writeTool(toolName) && writeLocksEnabled) {
        const sid = sessionIdOf(ctx);
        const campRoot = location.campRoot;
        const administrativeRoot = resolve(campRoot, ".ompfest");
        const requestedTargets = targetPaths(event.input, ctx.cwd);
        // Device writes dispatch tools; they do not mutate checkout files.
        const requestedDeviceTarget = typeof event.input?.path === "string" && event.input.path.startsWith("xd:/");
        if (requestedTargets.length === 0 && requestedDeviceTarget) return undefined;
        if (requestedTargets.length === 0) return { block: true, reason: "omp-fest cannot lock this write because its target path is missing. Use a native write/edit tool with an explicit file path." };
        const targets = requestedTargets.filter((path) =>
          !path.includes(`${sep}festivals${sep}`) && !path.startsWith(`${administrativeRoot}${sep}`),
        );
        // Festival and .ompfest documents are not project files; an explicit
        // target there needs no project lock, but must not look like a missing path.
        if (targets.length === 0) return undefined;
        const grouped = new Map<string, string[]>();
        for (const target of targets) {
          const projectDir = await projectRootForFile(target);
          if (!projectDir) return { block: true, reason: `omp-fest cannot safely lock ${target}: no Git checkout owns this file.` };
          grouped.set(projectDir, [...(grouped.get(projectDir) ?? []), target]);
        }
        const acquired: { projectDir: string; sessionId: string; assignmentId: string }[] = [];
        try {
          const festival = await claimedFestivalDir(tracker, detect, sid, campRoot);
          for (const [projectDir, files] of grouped) {
            const assignmentId = randomUUID();
            const result = await reserveProjectFiles(projectDir, {
              sessionId: sid, assignmentId, files,
              ...(festival ? { festival: basename(festival) } : {}),
              ...(tracker.openTaskPathFor(sid) ? { task: tracker.openTaskPathFor(sid) } : {}),
              worker: ctx.agent?.name ?? ctx.agent?.id ?? toolName,
            });
            if (result.kind !== "reserved") {
              const owners = result.kind === "conflict"
                ? result.conflicts.map((row) => `${row.worker ?? row.assignmentId} (${row.files.join(", ") || "whole checkout"})`).join("; ")
                : "write-lock registry busy";
              throw new Error(`Write lock unavailable for ${files.join(", ")}: ${owners}. Retry after the active write finishes.`);
            }
            acquired.push({ projectDir, sessionId: sid, assignmentId });
          }
          writeLocks.reserve(event.toolCallId, acquired);
        } catch (error) {
          await releaseWriteLocks(acquired);
          return { block: true, reason: String(error) };
        }
      }
      const supportedInstall = toolName === "bash" && writeLocksEnabled ? parseSupportedPackageInstall(command) : undefined;
      if (supportedInstall) {
        const sid = sessionIdOf(ctx);
        const workingDir = resolve(ctx.cwd, supportedInstall.workingDirectory ?? ".");
        let checkoutLock: { projectDir: string; sessionId: string; assignmentId: string } | undefined;
        try {
          const projectDir = await packageInstallCheckout(workingDir);
          if (!projectDir) return { block: true, reason: `omp-fest cannot safely run package installs outside a real Git checkout: ${workingDir}.` };
          const assignmentId = randomUUID();
          const result = await reserveProjectCheckout(projectDir, {
            sessionId: sid,
            assignmentId,
            worker: ctx.agent?.name ?? ctx.agent?.id ?? toolName,
          });
          if (result.kind !== "reserved") {
            const owners = result.kind === "conflict"
              ? result.conflicts.map((row) => `${row.worker ?? row.assignmentId} (${row.files.join(", ") || "whole checkout"})`).join("; ")
              : "write-lock registry busy";
            return { block: true, reason: `Package install checkout lock unavailable for ${projectDir}: ${owners}. Retry after the active write finishes.` };
          }
          checkoutLock = { projectDir, sessionId: sid, assignmentId };
          writeLocks.reserve(event.toolCallId, [checkoutLock]);
        } catch (error) {
          if (checkoutLock) await releaseWriteLocks([checkoutLock]);
          return { block: true, reason: `omp-fest cannot safely reserve package install checkout: ${String(error)}` };
        }
      }
      if (toolName === "bash" && writeLocksEnabled && !supportedInstall && (shellWritesFiles(command) || await shellRedirectsProtected(command, ctx.cwd, location.campRoot))) {
        return { block: true, reason: "omp-fest blocks shell-based project file mutations because it cannot acquire exact per-file write locks. Use native write/edit tools with explicit target paths, or a package-manager install command inside a Git checkout (pnpm/npm/yarn/bun/deno, optionally via corepack, mise exec, direnv exec, npx, or bunx)." };
      }
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
    const pendingLocks = writeLocks.settle(event.toolCallId);
    if (pendingLocks) await releaseWriteLocks(pendingLocks);
    const sid = sessionIdOf(ctx);
    const observed = supervisor.observeNativeResult(sessionIdOf(ctx), event.result);
    if (observed.observed.length) {
      await mirrorPortfolioRuntime(ctx, observed.observed);
      pi.appendEntry?.(SUPERVISOR_ENTRY, supervisor.state(sessionIdOf(ctx)));
    }
    if (event.isError) {
      return undefined;
    }
    const toolName = event.toolName ?? "";
    if (toolName === "fest_commit") {
      return {
        additionalContext:
          "omp-fest: The task commit is recorded, but the festival is not necessarily complete. Immediately call fest_next and continue the loop: complete and fest_commit each returned task, repeating until fest_next reports kind 'complete'. If it reports a gate, submit evidence and stop for human approval; if blocked, resolve the stated blocker before continuing. Do not end the session after one committed task.",
      };
    }
    const location = await detect.locate(ctx.cwd);
    const festivalDir =
      location.festivalDir ??
      (location.campRoot ? await claimedFestivalDir(tracker, detect, sid, location.campRoot) : undefined);
    if (!festivalDir) {
      return undefined;
    }
    const plansDir = location.campRoot ? resolve(location.campRoot, ".ompfest", "plans") : undefined;
    const targets = targetPaths(event.input, ctx.cwd).filter(
      (p) => !p.startsWith(`${festivalDir}${sep}`) && !p.includes(`${sep}festivals${sep}`) &&
        !(plansDir && p.startsWith(`${plansDir}${sep}`)),
    );
    if (targets.length === 0) {
      return undefined;
    }
    if (tracker.openTaskPathFor(sessionIdOf(ctx)) !== undefined) {
      return undefined;
    }
    const pending = await detect.pendingTasks(festivalDir);
    if (pending.length === 0) {
      return undefined;
    }
    const fresh = targets.filter((p) => tracker.markWarned(sid, p));
    if (fresh.length === 0) {
      return undefined;
    }
    return {
      additionalContext: `omp-fest: edited ${fresh.map((p) => basename(p)).join(", ")} with no unit open — the festival only tracks work fest_next hands out (${pending.length} task(s) pending). Call fest_next before more project edits.`,
    };
  });

  // Subagent steering: the API can't rewrite the spawn prompt — attach a note
  // so the routing output reminds the parent to hand out explicit units.
  pi.on("before_subagent_spawn", async (_event, ctx) => {
    const location = await detect.locate(ctx.cwd);
    if (!location.campRoot) return undefined;
    if (supervisor.state(sessionIdOf(ctx)).paused) {
      return { block: true, reason: "Festival worker dispatch is paused. Use /fest dispatch to resume." };
    }
    const config = await configFor();
    if (config.delegateMode === "never") {
      return { block: true, reason: "This camp forbids subagent delegation (delegateMode=never). Do the work in the main session, or ask the user to change the setting." };
    }
    const modeNote = config.delegateMode === "always"
      ? "delegateMode=always: the parent should delegate implementation units to workers."
      : "delegateMode=auto: delegate units only when their file scope is disjoint from other live work; do small or overlapping units in the main session.";
    return {
      note: `omp-fest worker: implement only the parent's explicit assignment; use native path-bearing write/edit tools for all project changes so exact per-file locks are acquired. Shell file mutations are blocked. Return files changed, actual verification results and blockers through the native subagent result. Do not select/claim festivals, run fest_next, complete festival tasks, commit, approve gates, change scope or transfer ownership. The parent supervisor alone reviews and records completion. When the assignment belongs to a cross-session team, the parent coordinates through fest_team; do not claim work outside your assignment. Follow the browser-verification policy in the task contract. Parent note — ${modeNote}`,
    };
  });

  pi.on("agent_end", (_event, ctx) => {
    const nudge = tracker.nudge(sessionIdOf(ctx));
    if (nudge) {
      ctx.ui.notify(nudge, "warning");
    }
    return undefined;
  });
}
