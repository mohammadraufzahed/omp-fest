import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { Supervisor, SUPERVISOR_ENTRY, SUPERVISOR_POLICY } from "../../application/supervisor.js";
import { dispatchQueue, taskFiles, type DispatchQueue, type DispatchTask, type WriteLockOwner } from "../../application/supervisor-queue.js";
import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { claimFestivalOwnership, festivalOwner } from "../../application/festival-ownership.js";
import { storeEvidenceBundle } from "../../application/evidence-bundles.js";
import { checkProjectConflicts } from "../../application/project-conflicts.js";
import { BROWSER_VERIFICATION_POLICY } from "../../domain/orientation.js";
import { sessionIdOf } from "../../application/session-id.js";
import type { PiLike, ToolDeps } from "./tools.js";

interface SupervisorToolContext { cwd: string; sessionManager?: { getSessionId?(): string }; getAsyncJobSnapshot?(): { running?: NativeJob[]; recent?: NativeJob[] } | null }
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
  if (!dir) throw new Error("No selected festival. Use /fest select first.");
  return { dir, campRoot: location.campRoot };
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
  const queue = dispatchQueue({ festivalDir: dir, festival: basename(dir), current, tasks, workers: state.workers, paused: state.paused });
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
  return { dir, current, tasks, queue };
}

export function registerSupervisorTools(pi: PiLike, deps: ToolDeps, supervisor: Supervisor, hooks: SupervisorToolHooks = {}): void {
  const z = pi.zod;
  pi.registerTool({
    name: "fest_supervisor",
    description: "Queue dependency-eligible tasks, track native worker reports and per-file write locks, reconcile resume, retain worker questions and independently review submissions. Status returns a compact delta for a known revision; omit since for full state. Never launches workers or completes tasks. Main session only.",
    parameters: z.object({
      action: z.enum(["status", "queue", "resume", "assign", "running", "submit", "block", "question", "accept", "revise"]),
      festival: z.string().optional(), task: z.string().optional(), worker: z.string().optional(),
      assignment: z.string().optional(), evidence: z.string().optional(), since: z.string().optional(), runtimeId: z.string().optional(),
    }),
    async execute(_id: string, params: { action: "status" | "queue" | "resume" | "assign" | "running" | "submit" | "block" | "question" | "accept" | "revise"; festival?: string; task?: string; worker?: string; assignment?: string; evidence?: string; since?: string; runtimeId?: string }, _signal: unknown, _update: unknown, ctx: SupervisorToolContext) {
      const sid = sessionIdOf(ctx);
      const output = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
      try {
        if (hooks.isMainSession && !hooks.isMainSession(ctx)) throw new Error("Festival supervision is main-session only; return your report through the native worker channel.");
        if (params.action === "status") return output({ ...supervisor.snapshot(sid, params.since), statusSource: "supervisor_reported", runtimeSource: "worker.runtime.source; absent means unverified" });
        if (params.action === "resume") {
          const reconciliation = supervisor.reconcile(sid);
          pi.appendEntry?.(SUPERVISOR_ENTRY, supervisor.state(sid));
          return output(reconciliation);
        }
        if (params.action === "queue") return output((await supervisorQueue(deps, supervisor, sid, ctx.cwd, params.festival)).queue);
        let result: unknown;
        if (params.action === "assign") {
          const { dir, tasks, queue } = await supervisorQueue(deps, supervisor, sid, ctx.cwd, params.festival);
          if (queue.barrier) throw new Error(queue.barrier);
          const candidate = queue.candidates.find((item) => item.task === params.task);
          if (!candidate || !params.worker || !candidate.workingDir) throw new Error(queue.waiting.find((item) => item.task === params.task)?.reason ?? "Choose an exact eligible queued task and worker name.");
          const projectDir = candidate.workingDir;
          const owner = await claimFestivalOwnership(dir, sid);
          if (owner.kind !== "claimed") throw new Error("Festival belongs to another session; transfer only through /fest select.");
          const task = tasks.find((item) => item.path === candidate.task);
          if (!task) throw new Error("Queued task disappeared; refresh the queue.");
          const document = task.document;
          const id = randomUUID();
          const row = supervisor.assign(sid, basename(dir), candidate.task, params.worker, candidate.files, { id });
          deps.tracker.taskOpened(sid, candidate.task);
          result = { assignment: row, contract: { festivalDir: dir, task: candidate.task, workingDir: projectDir, document, policy: SUPERVISOR_POLICY, browserVerification: BROWSER_VERIFICATION_POLICY }, nextSteps: "Launch this named worker through the native omp agent tool. After host acceptance, call fest_capabilities and bind the exact running task job ID with fest_supervisor action running {assignment,runtimeId}; if no matching job is exposed, keep runtime unverified. Native async job snapshots reconcile running/completed/failed/cancelled states and surface completion for supervisor review; no duplicate launch or auto-accept." };
        } else {
          if (!params.assignment) throw new Error("Assignment id is required.");
          const assignment = supervisor.state(sid).workers.find((worker) => worker.id === params.assignment);
          if (!assignment) throw new Error("Unknown assignment in this supervisor session.");
          const { dir: assignmentDir } = await festivalLocation(deps, sid, ctx.cwd, assignment.festival);
          const ownership = await festivalOwner(assignmentDir);
          if (ownership?.sessionId !== sid) throw new Error("Festival ownership changed; this session cannot mutate its worker assignment.");
          if (params.action === "question") result = supervisor.question(sid, params.assignment, params.evidence ?? "");
          else if (params.action === "running") {
            const jobs = ctx.getAsyncJobSnapshot?.(), job = [...(jobs?.running ?? []), ...(jobs?.recent ?? [])].find((item) => item.id === params.runtimeId);
            if (job?.type !== "task" || job.status !== "running" || (job.label !== assignment.worker && job.agentId !== assignment.worker)) throw new Error("Bind only a host-observed running task job whose label/agentId matches this assigned worker. Inspect fest_capabilities; do not invent runtime IDs.");
            const row = supervisor.update(sid, params.assignment, "running", "");
            result = supervisor.observeRuntime(sid, { assignmentId: row.id, runtimeId: job.id, status: "running" }, "native_runtime");
          } else {
            let evidence = params.evidence ?? "", artifact: string | undefined;
            if (params.action === "submit") {
              const assignment = supervisor.state(sid).workers.find((worker) => worker.id === params.assignment);
              if (assignment?.status !== "running") throw new Error("Only a running worker can submit results; record the real dispatch first.");
              const { dir } = await festivalLocation(deps, sid, ctx.cwd, assignment.festival);
              const stored = hooks.storeReport
                ? await hooks.storeReport(dir, evidence)
                : await storeEvidenceBundle(dir, { kind: "worker", summary: evidence.trim().slice(0, 600), details: evidence });
              evidence = stored.summary; artifact = stored.path;
            }
            const row = supervisor.update(sid, params.assignment, params.action, evidence, artifact);
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
