import { createHash, randomUUID } from "node:crypto";
import { filesOverlap } from "./supervisor-queue.js";

export const SUPERVISOR_ENTRY = "com.github.mohammadraufzahed.omp-fest.supervisor";
export const SUPERVISOR_POLICY = [
  "Festival supervisor mode: the main agent owns planning, decisions, integration, review, task completion and commits.",
  "After human-authorized activation reaches active, immediately continue with fest_next and supervisor dispatch; do not end the turn at activation or wait for a separate /fest dispatch command.",
  "Activation itself is not a worker launch. Invoke the exposed omp subagent tool; /fest dispatch explicitly unpauses, /fest resume reconciles without changing pause.",
  "Continue assignment, worker results, independent review, integration, task completion and commits until complete, a human gate, an explicit pause or a real blocker. Missing subagent capability means blocked, not launched.",
  "Use omp's exposed native parallel/subagent tools for substantial implementation, never an external Orca runtime, shell-launched agents or a custom worker scheduler. Batch independent eligible assignments; overlaps stay sequential.",
  "Call fest_supervisor queue, assign the exact eligible task and worker, pass the contract to that named subagent, and mark running only after the host accepts dispatch. If the current task is waiting on another session's project reservation, stop before edits/dispatch; do not mark it complete or commit, and resume only when the reservation clears.",
  "Workers return compact files/evidence/failures/blockers reports through their native channel. They must not select/claim festivals, mutate festival tasks, commit, approve gates, change scope or transfer ownership.",
  "Submit returned results through fest_supervisor; native completion is not acceptance. Independently review and verify, accept with evidence, then fest_task_complete and fest_commit.",
  "After each accepted submission record task completion and continue fest_next/queue in the same native agent turn; this is not an autonomous background scheduler. After workers and tasks settle, follow /fest finish and record actual combined checks and visual comparisons through fest_integration before the completion gate. Never approve that gate yourself.",
  "Maximum three outstanding workers. Never relaunch unfinished, exited, failed or unverifiable workers on resume; reconcile and continue the existing worker. Shared files/contracts stay sequential.",
  "Pause stops new assignments, not existing workers. Answer worker questions through the blocker inbox and send the answer to the same native worker. Human gates remain human-only.",
].join(" ");

export type WorkerStatus = "assigned" | "running" | "blocked" | "ready_for_review" | "accepted";
export type RuntimeStatus = "running" | "completed" | "failed" | "exited" | "unverifiable";
export interface RuntimeObservation {
  assignmentId: string;
  status: RuntimeStatus;
  runtimeId?: string;
  detail?: string;
}
export interface WorkerRuntime extends Omit<RuntimeObservation, "assignmentId"> {
  source: "native_runtime" | "native_tool_result" | "unverified";
  observedAt: string;
}
export interface WorkerAssignment {
  id: string; festival: string; task: string; worker: string; files: string[];
  /** Supervisor-reported workflow status, not a native lifecycle observation. */
  status: WorkerStatus;
  report: string; review: string;
  runtime?: WorkerRuntime;
  reportArtifact?: string;
  projectDir?: string;
}
export interface WorkerBlocker {
  id: string; assignmentId: string; question: string; answer?: string;
  createdAt: string; answeredAt?: string;
}
export interface SupervisorState { paused: boolean; workers: WorkerAssignment[]; blockers?: WorkerBlocker[] }
export interface Reconciliation {
  paused: boolean;
  unfinished: { assignment: WorkerAssignment; launchAllowed: false; next: string }[];
  unknownObservations: string[];
}

const runtimeStatuses: readonly string[] = ["running", "completed", "failed", "exited", "unverifiable"];

/** Branch-local snapshots persist through omp transcript entries; runtime truth is separate. */
export class Supervisor {
  private readonly sessions = new Map<string, SupervisorState>();
  state(session: string): SupervisorState { return structuredClone(this.sessions.get(session) ?? { paused: false, workers: [] }); }
  private readonly snapshots = new Map<string, Map<string, SupervisorState>>();
  snapshot(session: string, since?: string) {
    const state = this.state(session), revision = createHash("sha256").update(JSON.stringify(state)).digest("hex");
    let history = this.snapshots.get(session); if (!history) { history = new Map(); this.snapshots.set(session, history); }
    const previous = since ? history.get(since) : undefined;
    history.set(revision, state);
    while (history.size > 24) {
      const oldest = history.keys().next();
      if (!oldest.done) history.delete(oldest.value);
    }
    if (!since) return { revision, state, full: true };
    if (!previous) return { revision, state, full: true, reset: true, reason: "Unknown or expired revision; this is a full snapshot." };
    const oldWorkers = new Map(previous.workers.map((worker) => [worker.id, worker]));
    const workers = state.workers.filter((worker) => JSON.stringify(oldWorkers.get(worker.id)) !== JSON.stringify(worker));
    const currentIds = new Set(state.workers.map((worker) => worker.id));
    const oldBlockers = new Map((previous.blockers ?? []).map((blocker) => [blocker.id, blocker]));
    const blockers = (state.blockers ?? []).filter((blocker) => JSON.stringify(oldBlockers.get(blocker.id)) !== JSON.stringify(blocker));
    return { revision, since, full: false, delta: { paused: previous.paused === state.paused ? undefined : state.paused, workers, removedWorkerIds: previous.workers.filter((worker) => !currentIds.has(worker.id)).map((worker) => worker.id), blockers } };
  }

  restore(session: string, entries: unknown[]): void {
    this.sessions.delete(session);
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || !("customType" in entry) || entry.customType !== SUPERVISOR_ENTRY || !("data" in entry) || !entry.data || typeof entry.data !== "object") continue;
      const value = entry.data as Partial<SupervisorState>;
      if (typeof value.paused !== "boolean" || !Array.isArray(value.workers)) continue;
      const workers: WorkerAssignment[] = [];
      for (const item of value.workers as unknown[]) {
        if (!item || typeof item !== "object") continue;
        const row = item as Partial<WorkerAssignment>;
        const status = row.status;
        if (typeof row.id !== "string" || typeof row.festival !== "string" || typeof row.task !== "string" || typeof row.worker !== "string" ||
            !Array.isArray(row.files) || !row.files.every((path: unknown) => typeof path === "string") ||
            !status || !["assigned", "running", "blocked", "ready_for_review", "accepted"].includes(status) || typeof row.report !== "string" || typeof row.review !== "string") continue;
        const worker: WorkerAssignment = { id: row.id, festival: row.festival, task: row.task, worker: row.worker, files: row.files, status, report: row.report, review: row.review };
        if (typeof row.reportArtifact === "string") worker.reportArtifact = row.reportArtifact;
        if (typeof row.projectDir === "string") worker.projectDir = row.projectDir;
        if (row.runtime && typeof row.runtime === "object" && runtimeStatuses.includes(row.runtime.status) && ["native_runtime", "native_tool_result", "unverified"].includes(row.runtime.source) && typeof row.runtime.observedAt === "string") {
          worker.runtime = { status: row.runtime.status, source: row.runtime.source, observedAt: row.runtime.observedAt };
          if (typeof row.runtime.runtimeId === "string") worker.runtime.runtimeId = row.runtime.runtimeId;
          if (typeof row.runtime.detail === "string") worker.runtime.detail = row.runtime.detail;
        }
        workers.push(worker);
      }
      const state: SupervisorState = { paused: value.paused, workers };
      if (Array.isArray(value.blockers)) state.blockers = (value.blockers as unknown[]).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const row = item as Partial<WorkerBlocker>;
        if (typeof row.id !== "string" || typeof row.assignmentId !== "string" || typeof row.question !== "string" || typeof row.createdAt !== "string" || !workers.some((worker) => worker.id === row.assignmentId)) return [];
        const blocker: WorkerBlocker = { id: row.id, assignmentId: row.assignmentId, question: row.question, createdAt: row.createdAt };
        if (typeof row.answer === "string") blocker.answer = row.answer;
        if (typeof row.answeredAt === "string") blocker.answeredAt = row.answeredAt;
        return [blocker];
      });
      this.sessions.set(session, state);
    }
  }

  pause(session: string, paused: boolean): SupervisorState {
    const state = this.state(session); state.paused = paused; this.sessions.set(session, state); return this.state(session);
  }

  assign(session: string, festival: string, task: string, worker: string, files: string[], options: { id?: string; projectDir?: string } = {}): WorkerAssignment {
    const state = this.state(session);
    if (state.paused) throw new Error("Dispatch is paused. Use /fest dispatch to resume explicitly.");
    if (!worker.trim()) throw new Error("Worker name is required.");
    const active = state.workers.filter((row) => row.status !== "accepted");
    if (active.length >= 3) throw new Error("Three assignments are outstanding; review or settle them before dispatching more.");
    if (active.some((row) => row.festival === festival && row.task === task)) throw new Error("This task already has an outstanding assignment; continue that worker instead.");
    if (active.some((row) => row.worker === worker)) throw new Error("This worker already has an outstanding assignment.");
    if (active.some((row) => filesOverlap(row.files, files))) throw new Error("Assignment overlaps outstanding work, or its file boundary is unknown. Keep it sequential.");
    const row: WorkerAssignment = { id: options.id ?? randomUUID(), festival, task, worker, files: [...files], status: "assigned", report: "", review: "" };
    if (state.workers.some((item) => item.id === row.id)) throw new Error("Assignment id already exists.");
    if (options.projectDir) row.projectDir = options.projectDir;
    state.workers.push(row); this.sessions.set(session, state); return structuredClone(row);
  }

  update(session: string, id: string, action: "running" | "submit" | "block" | "accept" | "revise", evidence: string, reportArtifact?: string): WorkerAssignment {
    const state = this.state(session), row = state.workers.find((item) => item.id === id);
    if (!row) throw new Error("Unknown assignment in this supervisor session.");
    if (row.status === "accepted") throw new Error("Accepted assignments cannot be changed.");
    if (action === "running") {
      if (row.status !== "assigned" && row.status !== "blocked") throw new Error("Only assigned or blocked workers can start/resume.");
      if (row.runtime && ["failed", "exited", "unverifiable"].includes(row.runtime.status)) throw new Error("Reconcile native lifecycle before continuing this worker; do not relaunch it.");
      row.status = "running";
    } else {
      if (!evidence.trim()) throw new Error("Provide actual evidence or a concrete blocker.");
      if (action === "accept" || action === "revise") {
        if (row.status !== "ready_for_review") throw new Error("Only submitted results can be reviewed.");
        if (action === "accept" && row.runtime && ["failed", "exited", "unverifiable"].includes(row.runtime.status)) throw new Error("Native lifecycle is failed, exited or unverifiable; reconcile before acceptance.");
        row.review = evidence; row.status = action === "accept" ? "accepted" : "blocked";
      } else {
        if (action === "submit" && row.status !== "running") throw new Error("Only a running worker can submit results; record the real dispatch first.");
        row.report = evidence;
        if (reportArtifact) row.reportArtifact = reportArtifact;
        row.status = action === "submit" ? "ready_for_review" : "blocked";
      }
    }
    this.sessions.set(session, state); return structuredClone(row);
  }

  observeRuntime(session: string, observation: RuntimeObservation, source: WorkerRuntime["source"] = "native_runtime"): WorkerAssignment {
    if (!runtimeStatuses.includes(observation.status)) throw new Error("Invalid native lifecycle status.");
    const state = this.state(session), row = state.workers.find((worker) => worker.id === observation.assignmentId);
    if (!row) throw new Error("Unknown assignment in this supervisor session.");
    if (row.runtime?.runtimeId && observation.runtimeId && row.runtime.runtimeId !== observation.runtimeId) throw new Error("Runtime identity does not match the assigned worker; do not relaunch.");
    const runtimeId = observation.runtimeId ?? row.runtime?.runtimeId;
    row.runtime = { status: observation.status, source, observedAt: new Date().toISOString(), ...(runtimeId ? { runtimeId } : {}), ...(observation.detail ? { detail: observation.detail } : {}) };
    this.sessions.set(session, state); return structuredClone(row);
  }

  /** Accepts structured native results only, never prose or supervisor-reported evidence. */
  observeNativeResult(session: string, result: unknown): { observed: WorkerAssignment[]; ignored: number } {
    const observed: WorkerAssignment[] = []; let ignored = 0;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) visit(item); return; }
      if (!value || typeof value !== "object") { ignored++; return; }
      const row = value as { status?: unknown; assignmentId?: unknown; worker?: unknown; name?: unknown; agentId?: unknown; id?: unknown; result?: unknown; results?: unknown; details?: unknown; tasks?: unknown; agents?: unknown };
      if (typeof row.status === "string" && runtimeStatuses.includes(row.status)) {
        const workers = this.state(session).workers;
        const matches = typeof row.assignmentId === "string" ? workers.filter((worker) => worker.id === row.assignmentId) : workers.filter((worker) => worker.worker === (row.worker ?? row.name));
        const runtimeId = typeof row.agentId === "string" ? row.agentId : typeof row.id === "string" ? row.id : undefined;
        const worker = matches.length === 1 ? matches[0] : undefined;
        if (!worker || !runtimeId) { ignored++; return; }
        try { observed.push(this.observeRuntime(session, { assignmentId: worker.id, runtimeId, status: row.status as RuntimeStatus }, "native_tool_result")); } catch { ignored++; }
        return;
      }
      let nested = false;
      for (const nestedValue of [row.result, row.results, row.details, row.tasks, row.agents]) if (nestedValue !== undefined) { nested = true; visit(nestedValue); }
      if (!nested) ignored++;
    };
    visit(result); return { observed, ignored };
  }

  reconcile(session: string, observations: RuntimeObservation[] = []): Reconciliation {
    const unknownObservations: string[] = [];
    const confirmed = new Set<string>();
    for (const observation of observations) {
      try { this.observeRuntime(session, observation); confirmed.add(observation.assignmentId); }
      catch (error) { unknownObservations.push(`${observation.assignmentId}: ${String(error)}`); }
    }
    for (const worker of this.state(session).workers) {
      if (worker.status === "accepted" || confirmed.has(worker.id) || (worker.runtime && ["completed", "failed", "exited"].includes(worker.runtime.status))) continue;
      this.observeRuntime(session, { assignmentId: worker.id, status: "unverifiable", detail: worker.runtime ? `Prior observation: ${worker.runtime.status} at ${worker.runtime.observedAt}. No current runtime observation supplied.` : "No current runtime observation supplied." }, "unverified");
    }
    const state = this.state(session);
    return { paused: state.paused, unknownObservations, unfinished: state.workers.filter((row) => row.status !== "accepted").map((assignment) => ({ assignment, launchAllowed: false, next: assignment.status === "ready_for_review" ? "Independently review the existing submission; do not relaunch." : assignment.runtime?.status === "running" ? "Continue observing or message the existing native worker." : "Runtime not confirmed active. Reconcile this existing assignment; never launch a duplicate." })) };
  }

  question(session: string, assignmentId: string, question: string): WorkerBlocker {
    if (!question.trim()) throw new Error("A concrete worker question or blocker is required.");
    const state = this.state(session), worker = state.workers.find((row) => row.id === assignmentId);
    if (!worker || worker.status === "accepted") throw new Error("Unknown or accepted assignment cannot open a blocker.");
    const blocker: WorkerBlocker = { id: randomUUID(), assignmentId, question, createdAt: new Date().toISOString() };
    state.blockers = [...(state.blockers ?? []), blocker]; worker.status = "blocked";
    this.sessions.set(session, state); return structuredClone(blocker);
  }

  answer(session: string, id: string, answer: string): WorkerBlocker {
    if (!answer.trim()) throw new Error("A concrete blocker answer is required.");
    const state = this.state(session), blocker = state.blockers?.find((row) => row.id === id);
    if (!blocker || blocker.answer !== undefined) throw new Error("Unknown or already answered blocker.");
    blocker.answer = answer; blocker.answeredAt = new Date().toISOString();
    this.sessions.set(session, state); return structuredClone(blocker);
  }
}
