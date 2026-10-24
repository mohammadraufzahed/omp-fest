import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { Supervisor, SUPERVISOR_ENTRY, SUPERVISOR_POLICY, type WorkerAssignment } from "../../application/supervisor.js";
import { dispatchQueue, taskFiles, type DispatchQueue, type DispatchTask, type WriteLockOwner } from "../../application/supervisor-queue.js";
import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { festivalOwner } from "../../application/festival-ownership.js";
import { claimFestivalTask, joinFestivalTeam, readFestivalTeam, releaseFestivalTask, reviewFestivalTask, submitFestivalTask } from "../../application/festival-team.js";
import type { FestivalTeamAssignment } from "../../application/festival-team.js";
import { referencesForTask } from "../../application/visual-references.js";
import { BROWSER_VERIFICATION_POLICY } from "../../domain/orientation.js";
import { sessionIdOf } from "../../application/session-id.js";
import type { PiLike, ToolDeps } from "./tools.js";
import { checkProjectConflicts, listProjectReservations } from "../../application/project-conflicts.js";

import { buildPortfolioQueue, type PortfolioFestivalQueue } from "../../application/portfolio-queue.js";
import { readPortfolioState, reservePortfolioAssignment, updatePortfolioAssignment, releasePortfolioAssignment, recordPortfolioFestivalDispatch, updatePortfolioAssignmentRuntime } from "../../application/portfolio-state.js";
import { storeEvidenceBundle } from "../../application/evidence-bundles.js";
interface SupervisorToolContext { cwd: string; sessionManager?: { getSessionId?(): string }; agent?: { kind?: string }; getAsyncJobSnapshot?(): { running?: NativeJob[]; recent?: NativeJob[] } | null }
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
    status: assignment.status === "claimed" ? "running" as const : assignment.status === "submitted" ? "ready_for_review" as const : "accepted" as const,
    report: assignment.report ?? "",
    review: assignment.review ?? "",
  };
}


/** Shared by tool and command integration; this only reports candidates, never launches. */
export async function supervisorQueue(deps: ToolDeps, supervisor: Supervisor, sid: string, cwd: string, selector?: string) {
  const { dir, campRoot } = await festivalLocation(deps, sid, cwd, selector);
  const current = await deps.fest.next(dir);
  const pending = await deps.detect.pendingTasks(dir);
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
  const localTasks = new Set(state.workers.filter((worker) => worker.festival === basename(dir)).map((worker) => worker.task));
  const teamWorkers = (team?.assignments ?? [])
    .filter((assignment) => !localTasks.has(assignment.task))
    .map((assignment) => teamAssignmentForQueue(assignment, basename(dir), tasks));
  const queue = dispatchQueue({ festivalDir: dir, festival: basename(dir), current, tasks, workers: [...state.workers, ...teamWorkers], paused: state.paused || portfolio.paused });
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
        waiting: queue.waiting.map(({ task, reason }) => ({ task, reason })),
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
      if (shared.sessionId !== sid) continue;
      const ledger = ledgerById.get(shared.id);
      if (!ledger) {
        const task = recoveryTasks.get(id)?.find((row) => row.path === shared.task);
        recovered.push({
          id: shared.id, festival: id, task: shared.task, worker: shared.label ?? shared.sessionId,
          files: task?.files ?? (task ? taskFiles(task.document) : []),
          status: shared.status === "accepted" ? "accepted" : shared.status === "submitted" ? "ready_for_review" : "assigned",
          report: shared.report ?? "", review: shared.review ?? "",
        });
        continue;
      }
      if (ledger.sessionId !== sid) continue;
      const status: WorkerAssignment["status"] = ["failed", "exited"].includes(ledger.runtimeStatus ?? "") || ledger.status === "failed" || ledger.status === "released"
        ? "failed"
        : shared.status === "accepted" || ledger.status === "accepted" ? "accepted"
        : shared.status === "submitted" || ledger.status === "submitted" ? "ready_for_review"
        : ledger.status === "blocked" ? "blocked"
        : ledger.status === "running" ? "running" : "assigned";
      recovered.push({
        id: shared.id, festival: id, task: shared.task, worker: shared.label ?? ledger.worker,
        files: ledger.files, status, report: shared.report ?? ledger.report ?? "", review: shared.review ?? "",
        ...(ledger.runtimeStatus ? { runtime: {
          status: ledger.runtimeStatus, source: "unverified" as const, observedAt: ledger.runtimeObservedAt ?? ledger.updatedAt,
          ...(ledger.runtimeId ? { runtimeId: ledger.runtimeId } : {}),
        } } : {}),
      });
    }
    for (const ledger of stored.assignments.filter((entry) => entry.festival === id && entry.sessionId === sid && !recovered.some((worker) => worker.id === entry.id))) {
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
    description: "Queue dependency-eligible tasks across owned festivals, inspect the read-only portfolio and per-file write locks, track native worker reports, reconcile resume, retain worker questions and independently review submissions. Status returns a compact delta for a known revision; omit since for full state. Never launches workers or completes tasks. Main session only.",
    parameters: z.object({
      action: z.enum(["status", "queue", "portfolio", "resume", "assign", "running", "submit", "block", "question", "accept", "revise"]),
      festival: z.string().optional(), task: z.string().optional(), worker: z.string().optional(),
      assignment: z.string().optional(), evidence: z.string().optional(), since: z.string().optional(), runtimeId: z.string().optional(),
    }),
    async execute(_id: string, params: { action: "status" | "queue" | "portfolio" | "resume" | "assign" | "running" | "submit" | "block" | "question" | "accept" | "revise"; festival?: string; task?: string; worker?: string; assignment?: string; evidence?: string; since?: string; runtimeId?: string }, _signal: unknown, _update: unknown, ctx: SupervisorToolContext) {
      const sid = sessionIdOf(ctx);
      const output = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
      try {
        if (hooks.isMainSession && !hooks.isMainSession(ctx)) throw new Error("Festival supervision is main-session only; return your report through the native worker channel.");
        if (params.action === "status") {
          const location = await deps.detect.locate(ctx.cwd);
          if (location.campRoot) await supervisorPortfolioQueue(deps, supervisor, sid, ctx.cwd);
          return output({ ...supervisor.snapshot(sid, params.since), statusSource: "supervisor_reported", runtimeSource: "worker.runtime.source; absent means unverified" });
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
                if (row.status === "accepted" && persisted.status === "submitted") {
                  if (shared?.status !== "accepted") await reviewFestivalTask(location.campRoot, festival.path, sid, row.id, "accept", row.review);
                  await updatePortfolioAssignment(location.campRoot, row.id, "accepted");
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
          return output(reconciliation);
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
          const { tasks } = await supervisorQueue(deps, supervisor, sid, ctx.cwd, candidate.festival);
          const task = tasks.find((item) => item.path === candidate.task);
          if (!task) throw new Error("Eligible task disappeared from the dispatch queue; refresh the portfolio.");
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
            shared = await claimFestivalTask(campRoot, dir, sid, candidate.task, candidate.workingDir, params.worker);
            await reservePortfolioAssignment(campRoot, {
              id: shared.id, festival: candidate.festival, task: candidate.task, sessionId: sid,
              worker: params.worker, workingDir: candidate.workingDir, files: candidate.files,
            });
            ledgerCreated = true;
            await recordPortfolioFestivalDispatch(campRoot, candidate.festival);
            deps.tracker.taskOpened(sid, candidate.task);
            const row = supervisor.assign(sid, candidate.festival, candidate.task, params.worker, candidate.files, { id: shared.id });
            result = { assignment: row, contract: { festivalDir: dir, task: candidate.task, workingDir: candidate.workingDir, document: task.document, ...(visualReferences.length ? { visualReferences } : {}), policy: SUPERVISOR_POLICY, browserVerification: BROWSER_VERIFICATION_POLICY }, nextSteps: "Launch this named worker through the native omp agent tool. The shared festival team board reserves this exact task across omp sessions; file locks remain write-scoped. After host acceptance bind the native job ID. Do not relaunch unfinished work." };
          } catch (error) {
            if (ledgerCreated && shared) await releasePortfolioAssignment(campRoot, shared.id, "Portfolio assignment transaction rolled back.").catch(() => undefined);
            if (shared) await releaseFestivalTask(campRoot, dir, sid, shared.id, "Native supervisor assignment could not be created.").catch(() => undefined);
            throw error;
          }
        } else {
          if (!params.assignment) throw new Error("Assignment id is required.");
          const assignment = supervisor.state(sid).workers.find((worker) => worker.id === params.assignment);
          if (!assignment) throw new Error("Unknown assignment in this supervisor session.");
          const { dir: assignmentDir, campRoot } = await festivalLocation(deps, sid, ctx.cwd, assignment.festival);
          const ownership = await festivalOwner(assignmentDir);
          if (ownership?.sessionId !== sid) throw new Error("Festival ownership changed; this session cannot mutate its worker assignment.");
          if (params.action === "question") {
            const row = supervisor.question(sid, params.assignment, params.evidence ?? "");
            if ((await readPortfolioState(campRoot)).assignments.some((entry) => entry.id === row.assignmentId)) await updatePortfolioAssignment(campRoot, row.assignmentId, "blocked", { failure: row.question });
            result = row;
          }
          else if (params.action === "running") {
            const jobs = ctx.getAsyncJobSnapshot?.(), job = [...(jobs?.running ?? []), ...(jobs?.recent ?? [])].find((item) => item.id === params.runtimeId);
            if (job?.type !== "task" || job.status !== "running" || (job.label !== assignment.worker && job.agentId !== assignment.worker)) throw new Error("Bind only a host-observed running task job whose label/agentId matches this assigned worker. Inspect fest_capabilities; do not invent runtime IDs.");
            const row = supervisor.update(sid, params.assignment, "running", "");
            const observed = supervisor.observeRuntime(sid, { assignmentId: row.id, runtimeId: job.id, status: "running" }, "native_runtime");
            await updatePortfolioAssignment(campRoot, row.id, "running");
            await updatePortfolioAssignmentRuntime(campRoot, row.id, { runtimeId: job.id, runtimeStatus: "running", runtimeObservedAt: observed.runtime?.observedAt });
            result = observed;
          } else {
            let evidence = params.evidence ?? "", artifact: string | undefined;
            if (params.action === "submit") {
              if (assignment.status !== "running") throw new Error("Only a running worker can submit results; record the real dispatch first.");
              const stored = hooks.storeReport
                ? await hooks.storeReport(assignmentDir, evidence)
                : await storeEvidenceBundle(assignmentDir, { kind: "worker", summary: evidence.trim().slice(0, 600), details: evidence });
              evidence = stored.summary; artifact = stored.path;
              await submitFestivalTask(campRoot, assignmentDir, sid, params.assignment, evidence);
            }
            const row = supervisor.update(sid, params.assignment, params.action, evidence, artifact);
            if (params.action === "accept" || params.action === "revise") {
              await reviewFestivalTask(campRoot, assignmentDir, sid, row.id, params.action, evidence);
              await updatePortfolioAssignment(campRoot, row.id, params.action === "accept" ? "accepted" : "blocked", { report: evidence });
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
        return output(result);
      } catch (error) { return output({ kind: "supervisor_blocked", error: String(error) }); }
    },
  });
}
