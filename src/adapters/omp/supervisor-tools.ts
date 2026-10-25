import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { Supervisor, SupervisorBlocked, supervisorNextAction, SUPERVISOR_ENTRY, SUPERVISOR_POLICY, type WorkerAssignment } from "../../application/supervisor.js";
import { dispatchQueue, taskFiles, type DispatchQueue, type DispatchTask, type WriteLockOwner } from "../../application/supervisor-queue.js";
import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { festivalOwner } from "../../application/festival-ownership.js";
import { acceptFestivalTaskFromCoordinator, claimFestivalTask, joinFestivalTeam, readFestivalTeam, releaseFestivalTask, reviewFestivalTask, submitFestivalTask } from "../../application/festival-team.js";
import type { FestivalTeamAssignment } from "../../application/festival-team.js";
import { referencesForTask } from "../../application/visual-references.js";
import { BROWSER_VERIFICATION_POLICY } from "../../domain/orientation.js";
import { sessionIdOf } from "../../application/session-id.js";
import type { PiLike, ToolDeps } from "./tools.js";
import { checkProjectConflicts, listProjectReservations } from "../../application/project-conflicts.js";
import { readNativeReadyTasks } from "../../application/native-dependencies.js";
import { checkNativeChainEligibility } from "../../application/native-chain.js";
import { createFestivalWorktrees } from "../../application/festival-worktrees.js";
import { lifecycleStatus } from "../../domain/festival-lifecycle.js";
import { loadConfig } from "../../domain/config.js";

import { buildPortfolioQueue, type PortfolioFestivalQueue } from "../../application/portfolio-queue.js";
import { readPortfolioState, reservePortfolioAssignment, updatePortfolioAssignment, releasePortfolioAssignment, recordPortfolioFestivalDispatch, updatePortfolioAssignmentRuntime } from "../../application/portfolio-state.js";
import { storeEvidenceBundle } from "../../application/evidence-bundles.js";
interface SupervisorToolContext { cwd: string; sessionManager?: { getSessionId?(): string }; agent?: { kind?: string }; ui?: { confirm?(title: string, message: string): Promise<boolean> }; getAsyncJobSnapshot?(): { running?: NativeJob[]; recent?: NativeJob[] } | null }
interface NativeJob { id: string; type: string; status: string; label: string; agentId?: string }
export interface SupervisorToolHooks {
  isMainSession?(ctx: SupervisorToolContext): boolean;
  storeReport?(festivalDir: string, evidence: string): Promise<{ summary: string; path: string }>;
}
async function festivalLocation(deps: ToolDeps, sid: string, cwd: string, selector?: string) {
  const location = await deps.detect.locate(cwd);
  if (!location.campRoot) throw new Error("Select a festival inside a camp first.");
  const match = selector ? matchFestival(await deps.detect.listFestivals(location.campRoot), selector) : undefined;
  const dir = match?.kind === "match" ? match.festival.path : await claimedFestivalDir(deps.tracker, deps.detect, sid, location.campRoot);
  if (selector && match?.kind !== "match") throw new Error("Choose one exact festival.");
  if (!dir) throw new Error("No festival selected. Use /fest select as coordinator or /fest join as collaborator.");
  return { dir, campRoot: location.campRoot };
}
function teamAssignmentForQueue(assignment: FestivalTeamAssignment, festival: string, tasks: DispatchTask[]) {
  const task = tasks.find((item) => item.path === assignment.task);
  return {
    id: assignment.id,
    festival,
    task: assignment.task,
    worker: assignment.label ?? assignment.sessionId,
    files: task?.files ?? [],
    status: assignment.status === "claimed" ? "running" as const : assignment.status === "submitted" ? "ready_for_review" as const : assignment.status === "released" ? "failed" as const : "accepted" as const,
    report: assignment.report ?? "",
    review: assignment.review ?? "",
    ...(assignment.reviewSource ? { reviewSource: assignment.reviewSource } : {}),
  };
}


/** Shared by tool and command integration; this only reports candidates, never launches. */
export async function supervisorQueue(deps: ToolDeps, supervisor: Supervisor, sid: string, cwd: string, selector?: string) {
  const { dir, campRoot } = await festivalLocation(deps, sid, cwd, selector);
  if (deps.exec && lifecycleStatus(dir) === "active" && await lstat(join(dir, "APPROVED_PLAN.json")).catch(() => undefined)) {
    const config = await loadConfig(campRoot);
    await createFestivalWorktrees(deps.exec, campRoot, dir, basename(dir), await deps.camp.projects(campRoot), config.conventions);
  }
  const [current, pending, nativeReady, chain] = await Promise.all([
    deps.fest.next(dir), deps.detect.pendingTasks(dir), readNativeReadyTasks(deps.fest, dir), checkNativeChainEligibility(deps.fest, dir),
  ]);
  const sequenceDirs = new Map<string, string | undefined>();
  for (const sequence of new Set(pending.filter((task) => !task.done).map((task) => task.sequence))) {
    const goal = await readFile(join(dir, sequence, "SEQUENCE_GOAL.md"), "utf8").catch(() => "");
    const raw = /^fest_working_dir:[ \t]*(.+)$/m.exec(goal)?.[1]?.trim();
    let workingDir: string | undefined;
    if (raw) {
      let value: string;
      if (raw.startsWith('"')) { try { const parsed: unknown = JSON.parse(raw); if (typeof parsed === "string") value = parsed; else value = ""; } catch { value = ""; } }
      else if (raw.startsWith("'") && raw.endsWith("'")) value = raw.slice(1, -1).replaceAll("''", "'");
      else value = raw.replace(/\s+#.*$/, "").trim();
      if (value) workingDir = await realpath(resolve(campRoot, value)).catch(() => undefined);
    }
    if (!workingDir && current.kind === "task" && current.workingDir && current.path.replace(`${dir}/`, "").startsWith(`${sequence}/`)) {
      workingDir = await realpath(resolve(campRoot, current.workingDir)).catch(() => undefined);
    }
    sequenceDirs.set(sequence, workingDir);
  }
  const tasks: DispatchTask[] = await Promise.all(pending.map(async (task) => {
    const document = await readFile(join(dir, task.path), "utf8");
    const workingDir = sequenceDirs.get(task.sequence);
    return { ...task, document, ...(workingDir ? { workingDir, files: taskFiles(document).map((file) => resolve(workingDir, file)) } : !task.done ? { boundaryError: "Sequence working directory is unknown; resolve its fest_working_dir before dispatch." } : {}) };
  }));
  const state = supervisor.state(sid);
  const [team, portfolio] = await Promise.all([readFestivalTeam(campRoot, dir), readPortfolioState(campRoot)]);
  const localAssignments = new Set(state.workers.filter((worker) => worker.festival === basename(dir)).map((worker) => worker.id));
  const teamWorkers = (team?.assignments ?? [])
    .filter((assignment) => !localAssignments.has(assignment.id))
    .map((assignment) => teamAssignmentForQueue(assignment, basename(dir), tasks));
  const queue = dispatchQueue({
    festivalDir: dir, festival: basename(dir), current, tasks, nativeReady,
    workers: [...state.workers, ...teamWorkers], paused: state.paused || portfolio.paused,
    ...(!chain.allowed ? { chainBlocker: `Native interfestival chain ${chain.kind} (exit ${chain.code}): ${chain.stderr || chain.stdout}` } : {}),
  });
  const currentTask = current.kind === "task"
    ? (isAbsolute(current.path) ? relative(dir, current.path) : current.path)
    : undefined;
  let currentWriteLock: string | undefined;
  {
    const candidates = [];
    for (const candidate of queue.candidates) {
      if (!candidate.workingDir) {
        queue.waiting.push({ task: candidate.task, reason: "Sequence working directory is unknown." }); continue;
      }
      const conflict = await checkProjectConflicts(candidate.workingDir, candidate.files);
      if (conflict.kind === "clear") candidates.push(candidate);
      else {
        const writeLocks: WriteLockOwner[] | undefined = conflict.kind === "conflict" ? conflict.conflicts.map((row) => ({
          sessionId: row.sessionId, assignmentId: row.assignmentId,
          ...(row.worker ? { worker: row.worker } : {}),
          ...(row.festival ? { festival: row.festival } : {}),
          ...(row.task ? { task: row.task } : {}),
          files: row.files, reservedAt: row.reservedAt,
        })) : undefined;
        const ownerSummary = writeLocks?.map((row) =>
          `${row.worker ?? row.assignmentId} (session ${row.sessionId}; ${row.festival ?? "unknown festival"}/${row.task ?? "unknown task"}; ${row.files.length ? row.files.join(", ") : "whole checkout"})`,
        ).join("; ");
        const reason = conflict.kind === "busy"
          ? "Write-lock registry is busy; retry without dispatching."
          : `A write operation holds overlapping files in ${candidate.workingDir}: ${ownerSummary}. The lock may have cleared since this snapshot; refresh the queue. Inspect with /fest conflicts; run /fest conflicts reclaim only after confirming the writer stopped.`;
        queue.waiting.push({ task: candidate.task, reason, ...(writeLocks ? { writeLocks } : {}) });
        if (candidate.task === currentTask) currentWriteLock = reason;
      }
    }
    queue.candidates = candidates;
  }
  if (currentTask && currentWriteLock) deps.tracker.taskPaused(sid, currentTask, currentWriteLock);
  else if (currentTask && queue.candidates.some((candidate) => candidate.task === currentTask)) deps.tracker.taskResumed(sid, currentTask);
  return { dir, campRoot, current, tasks, queue };
}

function priorityOf(document: string): "urgent" | "high" | "normal" | "low" {
  const match = /^Priority:[ \t]*(urgent|high|normal|low)[ \t]*$/im.exec(document);
  return (match?.[1]?.toLowerCase() as "urgent" | "high" | "normal" | "low" | undefined) ?? "normal";
}

/** Read-only, session-owned portfolio view. Festival failures remain local diagnostics. */
export async function supervisorPortfolioQueue(deps: ToolDeps, supervisor: Supervisor, sid: string, cwd: string) {
  const location = await deps.detect.locate(cwd);
  if (!location.campRoot) throw new Error("Select a festival inside a camp first.");
  const listed = await deps.detect.listFestivals(location.campRoot);
  const owned = [];
  const errors: { festival: string; error: string }[] = [];
  for (const festival of listed) {
    try {
      if ((await festivalOwner(festival.path))?.sessionId === sid) owned.push(festival);
    } catch (error) {
      errors.push({ festival: basename(festival.path), error: String(error) });
    }
  }
  const festivalQueues: PortfolioFestivalQueue[] = [];
  const rows: { id: string; status?: string; progress?: unknown }[] = [];
  const workingDirs = new Set<string>();
  const recoveryTasks = new Map<string, DispatchTask[]>();
  for (const festival of owned) {
    const id = basename(festival.path);
    rows.push({ id, status: festival.status, progress: festival.progress });
    try {
      const { queue, tasks } = await supervisorQueue(deps, supervisor, sid, cwd, festival.id);
      recoveryTasks.set(id, tasks);
      festivalQueues.push({
        festival: id,
        candidates: queue.candidates.flatMap((candidate) => candidate.workingDir ? [{
          festival: id, task: candidate.task, sequence: candidate.sequence, files: candidate.files,
          dependencies: candidate.dependencies, workingDir: candidate.workingDir,
          priority: priorityOf(tasks.find((task) => task.path === candidate.task)?.document ?? ""),
        }] : []),
        waiting: [...queue.waiting.map(({ task, reason }) => ({ task, reason })), ...(queue.barrier ? [{ task: "", reason: queue.barrier }] : [])],
      });
      for (const candidate of queue.candidates) if (candidate.workingDir) workingDirs.add(candidate.workingDir);
      for (const task of tasks) if (task.workingDir) workingDirs.add(task.workingDir);
    } catch (error) {
      errors.push({ festival: id, error: String(error) });
      festivalQueues.push({ festival: id, candidates: [], waiting: [{ task: "", reason: String(error) }] });
    }
  }
  const [stored, localLocks] = await Promise.all([
    readPortfolioState(location.campRoot),
    Promise.all([...workingDirs].map(async (workingDir) => {
      try { return { workingDir, reservations: await listProjectReservations(workingDir) }; }
      catch (error) { return { workingDir, error: String(error), reservations: [] }; }
    })),
  ]);
  const assignments = stored.assignments.map((row) => ({
    festival: row.festival, task: row.task,
    status: row.status === "released" || row.status === "failed" || ["failed", "exited"].includes(row.runtimeStatus ?? "")
      ? "failed" as const : row.status,
  }));
  const ledgerById = new Map(stored.assignments.map((row) => [row.id, row]));
  const recovered: WorkerAssignment[] = [];
  for (const festival of owned) {
    const id = basename(festival.path);
    const team = await readFestivalTeam(location.campRoot, festival.path).catch(() => undefined);
    for (const shared of team?.assignments ?? []) {
      if (shared.status === "released") continue;
      const ledger = ledgerById.get(shared.id);
      if (!ledger && shared.sessionId !== sid) continue;
      if (ledger && ledger.festival !== id) continue;
      if (!ledger) {
        const task = recoveryTasks.get(id)?.find((row) => row.path === shared.task);
        recovered.push({
          id: shared.id, festival: id, task: shared.task, worker: shared.label ?? shared.sessionId,
          files: task?.files ?? (task ? taskFiles(task.document) : []),
          status: shared.status === "accepted" ? "accepted" : shared.status === "submitted" ? "ready_for_review" : "assigned",
          report: shared.report ?? "", review: shared.review ?? "",
          ...(shared.reviewSource ? { reviewSource: shared.reviewSource } : {}),
        });
        continue;
      }
      const status: WorkerAssignment["status"] = ["failed", "exited"].includes(ledger.runtimeStatus ?? "") || ledger.status === "failed" || ledger.status === "released"
        ? "failed"
        : shared.status === "accepted" || ledger.status === "accepted" ? "accepted"
        : shared.status === "submitted" || ledger.status === "submitted" ? "ready_for_review"
        : ledger.status === "blocked" ? "blocked"
        : ledger.status === "running" ? "running" : "assigned";
      recovered.push({
        id: shared.id, festival: id, task: shared.task, worker: shared.label ?? ledger.worker,
        files: ledger.files, status, report: shared.report ?? ledger.report ?? "", review: shared.review ?? ledger.review ?? "",
        ...(shared.reviewSource ?? ledger.reviewSource ? { reviewSource: shared.reviewSource ?? ledger.reviewSource } : {}),
        ...(ledger.runtimeStatus ? { runtime: {
          status: ledger.runtimeStatus, source: "unverified" as const, observedAt: ledger.runtimeObservedAt ?? ledger.updatedAt,
          ...(ledger.runtimeId ? { runtimeId: ledger.runtimeId } : {}),
        } } : {}),
      });
    }
    for (const ledger of stored.assignments.filter((entry) => entry.festival === id && !recovered.some((worker) => worker.id === entry.id))) {
      const failed = ledger.status === "failed" || ledger.status === "released" || ["failed", "exited"].includes(ledger.runtimeStatus ?? "");
      recovered.push({
        id: ledger.id, festival: id, task: ledger.task, worker: ledger.worker, files: ledger.files,
        status: failed ? "failed" : ledger.status === "accepted" ? "accepted" : ledger.status === "submitted" ? "ready_for_review" : ledger.status === "blocked" ? "blocked" : ledger.status === "running" ? "running" : "assigned",
        report: ledger.report ?? "", review: "",
        ...(ledger.runtimeStatus ? { runtime: {
          status: ledger.runtimeStatus, source: "unverified" as const, observedAt: ledger.runtimeObservedAt ?? ledger.updatedAt,
          ...(ledger.runtimeId ? { runtimeId: ledger.runtimeId } : {}),
        } } : {}),
      });
    }
  }
  supervisor.restoreAssignments(sid, recovered);
  const scheduler = buildPortfolioQueue({
    festivals: festivalQueues, assignments,
    paused: supervisor.state(sid).paused || stored.paused,
    workerLimit: stored.workerLimit, lastFestival: stored.lastFestival,
  });
  const lockErrors = localLocks.filter((row) => "error" in row).map((row) => ({ festival: "", error: `Locks in ${row.workingDir}: ${row.error}` }));
  return {
    queue: scheduler,
    festivals: rows,
    festivalQueues,
    errors: [...errors, ...lockErrors],
    paused: scheduler.paused,
    locks: localLocks.flatMap((row) => row.reservations.map((reservation) => ({ ...reservation, workingDir: row.workingDir }))),
  };
}


export function registerSupervisorTools(pi: PiLike, deps: ToolDeps, supervisor: Supervisor, hooks: SupervisorToolHooks = {}): void {
  const z = pi.zod;
  pi.registerTool({
    name: "fest_supervisor",
    description: "Queue dependency-eligible tasks across owned festivals, inspect the read-only portfolio and per-file write locks, track native worker reports, reconcile resume, retain worker questions and independently review submissions. Read status nextActions before transitioning: submitted results use accept after independent review; accept_reviewed is only an interactive, audited fallback when no worker submission is available and no native worker remains active. Acceptance calls are not probes; retry a blocker only after its named prerequisite changes. Reuse still-valid revision-bound evidence rather than automatically rerunning checks. Status returns a compact delta for a known revision; omit since for full state. Never launches workers or completes tasks. Main session only.",
    parameters: z.object({
      action: z.enum(["status", "queue", "portfolio", "resume", "assign", "running", "submit", "block", "question", "accept", "accept_reviewed", "revise"]),
      festival: z.string().optional(), task: z.string().optional(), worker: z.string().optional(),
      assignment: z.string().optional(), evidence: z.string().optional(), since: z.string().optional(), runtimeId: z.string().optional(),
    }),
    async execute(_id: string, params: { action: "status" | "queue" | "portfolio" | "resume" | "assign" | "running" | "submit" | "block" | "question" | "accept" | "accept_reviewed" | "revise"; festival?: string; task?: string; worker?: string; assignment?: string; evidence?: string; since?: string; runtimeId?: string }, _signal: unknown, _update: unknown, ctx: SupervisorToolContext) {
      const sid = sessionIdOf(ctx);
      const output = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
      try {
        if (hooks.isMainSession && !hooks.isMainSession(ctx)) throw new Error("Festival supervision is main-session only; return your report through the native worker channel.");
        if (params.action === "status") {
          const location = await deps.detect.locate(ctx.cwd);
          if (location.campRoot) await supervisorPortfolioQueue(deps, supervisor, sid, ctx.cwd);
          return output({ ...supervisor.snapshot(sid, params.since), nextActions: supervisor.state(sid).workers.map((row) => ({ assignment: row.id, nextAction: supervisorNextAction(row) })), statusSource: "supervisor_reported", runtimeSource: "worker.runtime.source; absent means unverified" });
        }
        if (params.action === "resume") {
          const location = await deps.detect.locate(ctx.cwd);
          if (location.campRoot) await supervisorPortfolioQueue(deps, supervisor, sid, ctx.cwd);
          const reconciliation = supervisor.reconcile(sid);
          if (location.campRoot) {
            const ledger = await readPortfolioState(location.campRoot);
            const festivals = await deps.detect.listFestivals(location.campRoot);
            for (const row of supervisor.state(sid).workers) {
              const persisted = ledger.assignments.find((entry) => entry.id === row.id);
              if (persisted?.sessionId !== sid) continue;
              const festival = festivals.find((entry) => basename(entry.path) === row.festival);
              if (festival && (await festivalOwner(festival.path))?.sessionId === sid) {
                const team = await readFestivalTeam(location.campRoot, festival.path).catch(() => undefined);
                const shared = team?.assignments.find((entry) => entry.id === row.id);
                if (row.status === "accepted" && persisted.status !== "accepted" &&
                    row.reviewSource === "coordinator-worktree" && shared?.status === "accepted" &&
                    shared.reviewSource === "coordinator-worktree") {
                  await updatePortfolioAssignment(location.campRoot, row.id, "accepted", {
                    review: row.review, reviewSource: "coordinator-worktree",
                  });
                } else if (row.status === "accepted" && persisted.status === "submitted") {
                  if (shared?.status !== "accepted") await reviewFestivalTask(location.campRoot, festival.path, sid, row.id, "accept", row.review);
                  await updatePortfolioAssignment(location.campRoot, row.id, "accepted", { review: row.review, reviewSource: "worker-submission" });
                } else if (shared?.status === "submitted" && row.status === "ready_for_review" &&
                    !["accepted", "failed", "released", "submitted"].includes(persisted.status)) {
                  await updatePortfolioAssignment(location.campRoot, row.id, "submitted", { report: shared.report ?? row.report });
                } else if (row.status === "blocked" && !["blocked", "accepted", "failed", "released"].includes(persisted.status)) {
                  await updatePortfolioAssignment(location.campRoot, row.id, "blocked");
                }
              }
              if (row.runtime && ["failed", "exited"].includes(row.runtime.status) &&
                  !["accepted", "failed", "released"].includes(persisted.status)) {
                await updatePortfolioAssignment(location.campRoot, row.id, "failed", { failure: `Native runtime ${row.runtime.status}.` });
              }
              if (row.runtime) await updatePortfolioAssignmentRuntime(location.campRoot, row.id, {
                ...(row.runtime.runtimeId ? { runtimeId: row.runtime.runtimeId } : {}),
                runtimeStatus: row.runtime.status, runtimeObservedAt: row.runtime.observedAt,
              });
            }
          }
          pi.appendEntry?.(SUPERVISOR_ENTRY, supervisor.state(sid));
          return output({ ...reconciliation, nextActions: supervisor.state(sid).workers.map((row) => ({ assignment: row.id, nextAction: supervisorNextAction(row) })) });
        }
        if (params.action === "queue") return output((await supervisorQueue(deps, supervisor, sid, ctx.cwd, params.festival)).queue);
        if (params.action === "portfolio") return output(await supervisorPortfolioQueue(deps, supervisor, sid, ctx.cwd));
        let result: unknown;
        if (params.action === "assign") {
          if (!params.task || !params.worker) throw new Error("Choose an exact eligible task path and worker name.");
          const portfolio = await supervisorPortfolioQueue(deps, supervisor, sid, ctx.cwd);
          const choices = portfolio.festivalQueues.flatMap((row) => row.candidates)
            .filter((item) => item.task === params.task && (!params.festival || item.festival === params.festival || item.festival === basename(params.festival)));
          if (choices.length > 1) throw new Error("Task path is ambiguous across owned festivals; specify festival.");
          const eligible = choices[0];
          const candidate = eligible && portfolio.queue.candidates.find((item) => item.festival === eligible.festival && item.task === eligible.task);
          if (!candidate) throw new Error(portfolio.queue.waiting.find((item) => item.task === params.task)?.reason ?? "Choose an exact eligible portfolio task.");
          const refreshed = await supervisorQueue(deps, supervisor, sid, ctx.cwd, candidate.festival);
          const freshCandidate = refreshed.queue.candidates.find((item) => item.task === candidate.task);
          if (!freshCandidate) throw new Error(refreshed.queue.waiting.find((item) => item.task === candidate.task)?.reason ?? refreshed.queue.barrier ?? "Task is no longer eligible; refresh the portfolio.");
          const task = refreshed.tasks.find((item) => item.path === candidate.task);
          if (!task) throw new Error("Eligible task disappeared from the dispatch queue; refresh the portfolio.");
          if (!freshCandidate.workingDir) throw new Error("Sequence working directory disappeared; refresh the portfolio.");
          const location = await deps.detect.locate(ctx.cwd);
          if (!location.campRoot) throw new Error("Select a festival inside a camp first.");
          const festival = (await deps.detect.listFestivals(location.campRoot)).find((row) => basename(row.path) === candidate.festival);
          if (!festival) throw new Error("Owned festival disappeared; refresh the portfolio.");
          const dir = festival.path, campRoot = location.campRoot;
          const visualReferences = await referencesForTask(dir, task.document);
          const ownership = await festivalOwner(dir);
          if (ownership?.sessionId !== sid) throw new Error("Only festivals explicitly owned by this session may be supervised.");
          const local = supervisor.state(sid);
          if (local.paused) throw new Error("Dispatch is paused. Resume explicitly before assigning new work.");
          if (local.workers.some((row) => row.status !== "accepted" && row.status !== "failed" && row.worker === params.worker)) throw new Error("This worker already has an outstanding assignment.");
          if (local.workers.some((row) => row.status !== "accepted" && row.status !== "failed" && row.festival === candidate.festival && row.task === candidate.task)) throw new Error("This task already has an outstanding assignment; continue that worker instead.");
          await joinFestivalTeam(campRoot, dir, sid, sid, params.worker);
          let shared: FestivalTeamAssignment | undefined, ledgerCreated = false;
          try {
            shared = await claimFestivalTask(campRoot, dir, sid, candidate.task, freshCandidate.workingDir, params.worker);
            await reservePortfolioAssignment(campRoot, {
              id: shared.id, festival: candidate.festival, task: candidate.task, sessionId: sid,
              worker: params.worker, workingDir: freshCandidate.workingDir, files: freshCandidate.files,
            });
            ledgerCreated = true;
            await recordPortfolioFestivalDispatch(campRoot, candidate.festival);
            deps.tracker.taskOpened(sid, candidate.task);
            const row = supervisor.assign(sid, candidate.festival, candidate.task, params.worker, freshCandidate.files, { id: shared.id });
            result = { assignment: row, contract: { festivalDir: dir, task: candidate.task, workingDir: freshCandidate.workingDir, document: task.document, ...(visualReferences.length ? { visualReferences } : {}), policy: SUPERVISOR_POLICY, browserVerification: BROWSER_VERIFICATION_POLICY }, nextSteps: "Launch this named worker through the native omp agent tool. The shared festival team board reserves this exact task across omp sessions; file locks remain write-scoped. After host acceptance bind the native job ID. Do not relaunch unfinished work." };
          } catch (error) {
            if (ledgerCreated && shared) await releasePortfolioAssignment(campRoot, shared.id, "Portfolio assignment transaction rolled back.").catch(() => undefined);
            if (shared) await releaseFestivalTask(campRoot, dir, sid, shared.id, "Native supervisor assignment could not be created.").catch(() => undefined);
            throw error;
          }
        } else {
          if (!params.assignment && !params.task) throw new Error("Provide an assignment ID or an exact task path.");
          const currentLocation = await deps.detect.locate(ctx.cwd);
          if (currentLocation.campRoot) await supervisorPortfolioQueue(deps, supervisor, sid, ctx.cwd);
          const workers = supervisor.state(sid).workers;
          const matchesForTask = () => workers.filter((worker) => worker.task === params.task &&
            (!params.festival || worker.festival === params.festival || basename(worker.festival) === basename(params.festival)));
          let assignment = params.assignment ? workers.find((worker) => worker.id === params.assignment) : undefined;
          if (!assignment && params.task) {
            const matches = matchesForTask();
            if (matches.length > 1) throw new Error("Task path matches multiple assignments; provide the exact assignment ID.");
            assignment = matches[0];
          }
          if (!assignment) throw new Error("Festival assignment not found in the selected session. Refresh action=status and use its exact assignment ID or task path.");
          const { dir: assignmentDir, campRoot } = await festivalLocation(deps, sid, ctx.cwd, assignment.festival);
          const ownership = await festivalOwner(assignmentDir);
          if (ownership?.sessionId !== sid) throw new Error("Festival ownership changed; this session cannot mutate its worker assignment.");
          const blocked = (message: string, reasonCode: string, missingRequirements: string[], nextAction = supervisorNextAction(assignment)) => new SupervisorBlocked(message, reasonCode, missingRequirements, nextAction);
          if (params.action === "question") {
            const row = supervisor.question(sid, assignment.id, params.evidence ?? "");
            if ((await readPortfolioState(campRoot)).assignments.some((entry) => entry.id === row.assignmentId)) await updatePortfolioAssignment(campRoot, row.assignmentId, "blocked", { failure: row.question });
            result = row;
          } else if (params.action === "running") {
            const jobs = ctx.getAsyncJobSnapshot?.(), job = [...(jobs?.running ?? []), ...(jobs?.recent ?? [])].find((item) => item.id === params.runtimeId);
            if (job?.type !== "task" || job.status !== "running" || (job.label !== assignment.worker && job.agentId !== assignment.worker)) throw blocked("Bind only a host-observed running task job whose label/agentId matches this assigned worker. Inspect fest_capabilities; do not invent runtime IDs.", "native_runtime_binding_required", ["Host-observed running task job matching the assigned worker"], { tool: "fest_capabilities", action: "inspect", assignment: assignment.id, instruction: "Inspect native jobs and bind the actual running matching task ID with fest_supervisor action=running. If the worker already stopped, reconcile with resume instead." });
            const row = supervisor.update(sid, assignment.id, "running", "");
            const observed = supervisor.observeRuntime(sid, { assignmentId: row.id, runtimeId: job.id, status: "running" }, "native_runtime");
            await updatePortfolioAssignment(campRoot, row.id, "running");
            await updatePortfolioAssignmentRuntime(campRoot, row.id, { runtimeId: job.id, runtimeStatus: "running", runtimeObservedAt: observed.runtime?.observedAt });
            result = observed;
          } else if (params.action === "accept_reviewed") {
            const evidence = params.evidence ?? "";
            if (!["assigned", "running", "blocked"].includes(assignment.status)) {
              throw blocked(`Coordinator worktree acceptance cannot replace an existing ${assignment.status} assignment; use the normal independent review for submitted results.`, "wrong_acceptance_path", ["An assignment without an existing worker submission"]);
            }
            if (!assignment.runtime || !["completed", "unverifiable"].includes(assignment.runtime.status)) {
              throw blocked("Coordinator attestation requires a completed or explicitly unverifiable worker runtime; reconcile native lifecycle first.", "runtime_reconciliation_required", ["Completed or explicitly unverifiable native lifecycle", "No active native worker"]);
            }
            if (!evidence.trim()) throw blocked("Provide concrete coordinator review evidence: inspected files, valid checks, and observed results.", "missing_review_evidence", ["Independent coordinator review evidence"], { tool: "fest_supervisor", action: "accept_reviewed", assignment: assignment.id, instruction: "Inspect the shared worktree and valid revision-bound evidence independently, then provide concrete review findings. Interactive confirmation is still required." });
            const jobs = ctx.getAsyncJobSnapshot?.();
            if (!jobs) throw blocked("Cannot attest while native worker state is unavailable. Reconcile through fest_supervisor action=resume and retry.", "native_snapshot_unavailable", ["Available native job snapshot proving no matching active worker"], { tool: "fest_supervisor", action: "resume", assignment: assignment.id, instruction: "Restore native job visibility and reconcile; retry coordinator attestation only once the native snapshot is available." });
            const active = (jobs.running ?? []).filter((job) =>
              job.type === "task" && job.status === "running" &&
              (job.id === assignment.runtime?.runtimeId || job.label === assignment.worker || job.agentId === assignment.worker));
            if (active.length) throw blocked(`Worker ${assignment.worker} still has a running native job (${active.map((job) => job.id).join(", ")}); wait for it to stop before reviewing the shared worktree.`, "native_worker_active", ["Matching native worker stopped"], { tool: "native_worker", action: "observe", assignment: assignment.id, instruction: "Wait for or message the existing active worker; recover its real result and use normal submission and review when available." });
            if (!ctx.ui?.confirm) throw blocked("Coordinator worktree acceptance requires an interactive native confirmation; no state changed.", "interactive_confirmation_required", ["Interactive native confirmation UI"], { tool: "fest_supervisor", action: "accept_reviewed", assignment: assignment.id, instruction: "Return to a native interactive session with confirmation available; do not bypass confirmation." });
            const confirmed = await ctx.ui.confirm(
              "Accept coordinator-reviewed work?",
              `Confirm you inspected the shared worktree for ${assignment.task}, verified the stated evidence, and know worker ${assignment.worker} is no longer running. This records coordinator acceptance, not a worker submission. Evidence: ${evidence}`,
            );
            if (!confirmed) throw blocked("Coordinator review cancelled; assignment remains open.", "confirmation_cancelled", ["Human confirmation of coordinator attestation"], { tool: "fest_supervisor", action: "status", assignment: assignment.id, instruction: "Respect cancellation. Keep the assignment open; request attestation again only after renewed human intent and valid prerequisites." });
            const team = await acceptFestivalTaskFromCoordinator(campRoot, assignmentDir, sid, assignment.id, evidence);
            const row = supervisor.update(sid, assignment.id, "accept_reviewed", evidence);
            await updatePortfolioAssignment(campRoot, row.id, "accepted", { review: evidence, reviewSource: "coordinator-worktree" });
            result = { assignment: row, sharedAssignment: team, nextSteps: "Coordinator review recorded; no worker result was fabricated. If the Festival task was manually blocked during recovery, unblock it with fest_task_update action=unblock; then call fest_task_complete for this verified task and continue the queue." };
          } else {
            let evidence = params.evidence ?? "", artifact: string | undefined;
            if (params.action === "submit") {
              if (assignment.status !== "running") throw blocked(`Only a running worker can submit results (assignment status: ${assignment.status}). Do not submit coordinator notes as worker output. If the worker is completed or unverifiable and you independently reviewed the shared worktree, use action=accept_reviewed with concrete evidence; this requires interactive confirmation.`, "worker_not_running", ["Real running-worker result and recorded dispatch"], supervisorNextAction(assignment));
              const stored = hooks.storeReport
                ? await hooks.storeReport(assignmentDir, evidence)
                : await storeEvidenceBundle(assignmentDir, { kind: "worker", summary: evidence.trim().slice(0, 600), details: evidence });
              evidence = stored.summary; artifact = stored.path;
              await submitFestivalTask(campRoot, assignmentDir, sid, assignment.id, evidence);
            }
            const row = supervisor.update(sid, assignment.id, params.action, evidence, artifact);
            if (params.action === "accept" || params.action === "revise") {
              await reviewFestivalTask(campRoot, assignmentDir, sid, row.id, params.action, evidence);
              await updatePortfolioAssignment(campRoot, row.id, params.action === "accept" ? "accepted" : "blocked", {
                ...(params.action === "accept" ? { review: evidence, reviewSource: "worker-submission" as const } : {}),
              });
            } else if (params.action === "block") {
              await releaseFestivalTask(campRoot, assignmentDir, sid, row.id, evidence);
              await updatePortfolioAssignment(campRoot, row.id, "blocked", { failure: evidence });
            } else {
              await updatePortfolioAssignment(campRoot, row.id, "submitted", { report: evidence });
            }
            result = row;
            if (params.action === "accept") {
              pi.appendEntry?.(SUPERVISOR_ENTRY, supervisor.state(sid));
              let next: DispatchQueue | { kind: "queue_unavailable"; error: string };
              try { next = (await supervisorQueue(deps, supervisor, sid, ctx.cwd, row.festival)).queue; }
              catch (error) { next = { kind: "queue_unavailable", error: String(error) }; }
              result = { assignment: row, next, nextSteps: "Acceptance does not complete this festival task. Record task completion, then continue fest_next/queue in this native agent turn; launch only queued candidates through native tools. Once tasks settle follow /fest finish and record actual combined verification and visual comparisons through fest_integration before the human completion gate; never approve the gate yourself." };
            }
          }
        }
        pi.appendEntry?.(SUPERVISOR_ENTRY, supervisor.state(sid));
        const resultAssignment = result && typeof result === "object" && "assignment" in result ? result.assignment : result;
        const row = resultAssignment && typeof resultAssignment === "object" && "id" in resultAssignment
          ? supervisor.state(sid).workers.find((worker) => worker.id === resultAssignment.id) : undefined;
        return output(row ? { ...result as object, nextAction: supervisorNextAction(row) } : result);
      } catch (error) {
        const structured = error instanceof SupervisorBlocked ? error : new SupervisorBlocked(String(error), "supervisor_prerequisite_required", [String(error)], { tool: "fest_supervisor", action: "status", instruction: "Inspect current state and resolve the reported prerequisite before retrying the transition; do not probe acceptance or reword evidence." });
        return output({ kind: "supervisor_blocked", error: String(error), reasonCode: structured.reasonCode, missingRequirements: structured.missingRequirements, nextAction: structured.nextAction, hint: structured.nextAction.instruction });
      }
    },
  });
}
