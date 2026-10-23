import { randomUUID } from "node:crypto";

export const SUPERVISOR_ENTRY = "com.github.mohammadraufzahed.omp-fest.supervisor";
export const SUPERVISOR_POLICY = [
  "Festival supervisor mode: the main agent owns planning, decisions, integration, review, task completion and commits.",
  "After human-authorized activation reaches active, immediately continue with fest_next and supervisor dispatch; do not end the turn at activation or wait for a separate /fest dispatch command.",
  "Activation itself is not a worker launch. The agent must invoke the exposed omp subagent tool; /fest dispatch is the manual start/resume control. If paused, preserve pause and report /fest dispatch as the resume action.",
  "Continue assignment, worker results, independent review, integration, task completion and commits until complete, a human gate, an explicit pause or a real blocker. If no subagent tool is exposed, report the missing capability instead of claiming workers started.",
  "Use omp's exposed native parallel/subagent tools for substantial implementation, not an external Orca runtime, shell-launched agents or a custom worker scheduler. Batch independent eligible assignments into one native parallel dispatch when supported; overlapping files/contracts remain sequential. Do small coordination fixes directly. Never invent worker launches or results.",
  "Before dispatch call fest_supervisor assign with the exact task path and worker name; pass its contract to that named subagent. Mark running only after the host accepts the dispatch.",
  "Workers implement only their assignment and return files, exercised verification, failures and blockers through their subagent result. They must not select/claim festivals, call fest_next, mutate festival tasks, commit, approve gates, change scope, cancel plans or transfer ownership.",
  "Submit returned results through fest_supervisor; completion is a submission, not acceptance. Review changes and independently exercise combined behavior before accepting with evidence, then fest_task_complete and fest_commit.",
  "Use bounded independent workers. Shared checkout edits to overlapping files or contracts stay sequential; use isolated worktrees for concurrent conflicting edits. Never commit another worker's unfinished changes.",
  "Pause stops new assignments, not existing workers. Resolve repository-answerable blockers; ask the human only for material decisions. Human gates remain human-only.",
].join(" ");

export type WorkerStatus = "assigned" | "running" | "blocked" | "ready_for_review" | "accepted";
export interface WorkerAssignment {
  id: string;
  festival: string;
  task: string;
  worker: string;
  files: string[];
  status: WorkerStatus;
  report: string;
  review: string;
}
export interface SupervisorState {
  paused: boolean;
  workers: WorkerAssignment[];
}

/** Session-local supervisor records; snapshots are persisted in omp's transcript. */
export class Supervisor {
  private readonly sessions = new Map<string, SupervisorState>();

  state(session: string): SupervisorState {
    return structuredClone(this.sessions.get(session) ?? { paused: false, workers: [] });
  }

  restore(session: string, entries: unknown[]): void {
    this.sessions.delete(session);
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || !("customType" in entry) || entry.customType !== SUPERVISOR_ENTRY || !("data" in entry)) continue;
      const value = entry.data;
      if (!value || typeof value !== "object" || !("paused" in value) || typeof value.paused !== "boolean" || !("workers" in value) || !Array.isArray(value.workers)) continue;
      const workers: WorkerAssignment[] = [];
      const entries: unknown[] = value.workers;
      for (const item of entries) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        if (typeof row.id !== "string" || typeof row.festival !== "string" || typeof row.task !== "string" || typeof row.worker !== "string" ||
            !Array.isArray(row.files) || !row.files.every((path: unknown) => typeof path === "string") ||
            !["assigned", "running", "blocked", "ready_for_review", "accepted"].includes(String(row.status)) || typeof row.report !== "string" || typeof row.review !== "string") continue;
        workers.push({ id: row.id, festival: row.festival, task: row.task, worker: row.worker, files: row.files, status: row.status as WorkerStatus, report: row.report, review: row.review });
      }
      this.sessions.set(session, { paused: value.paused, workers });
    }
  }

  pause(session: string, paused: boolean): SupervisorState {
    const state = this.state(session);
    state.paused = paused;
    this.sessions.set(session, state);
    return this.state(session);
  }

  assign(session: string, festival: string, task: string, worker: string, files: string[]): WorkerAssignment {
    const state = this.state(session);
    if (state.paused) throw new Error("Dispatch is paused. Use /fest dispatch to resume explicitly.");
    if (!worker.trim()) throw new Error("Worker name is required.");
    const active = state.workers.filter((row) => row.status !== "accepted");
    if (active.length >= 3) throw new Error("Three assignments are outstanding; review or settle them before dispatching more.");
    if (active.some((row) => row.festival === festival && row.task === task)) throw new Error("This task already has an outstanding assignment; continue that worker instead.");
    if (active.some((row) => row.worker === worker)) throw new Error("This worker already has an outstanding assignment.");
    if (active.some((row) => !row.files.length || !files.length || row.files.some((path) => files.includes(path) || files.some((other) => path.startsWith(`${other}/`) || other.startsWith(`${path}/`))))) {
      throw new Error("Assignment overlaps outstanding work, or its file boundary is unknown. Keep it sequential.");
    }
    const row: WorkerAssignment = { id: randomUUID(), festival, task, worker, files: [...files], status: "assigned", report: "", review: "" };
    state.workers.push(row);
    this.sessions.set(session, state);
    return structuredClone(row);
  }

  update(session: string, id: string, action: "running" | "submit" | "block" | "accept" | "revise", evidence: string): WorkerAssignment {
    const state = this.state(session);
    const row = state.workers.find((item) => item.id === id);
    if (!row) throw new Error("Unknown assignment in this supervisor session.");
    if (row.status === "accepted") throw new Error("Accepted assignments cannot be changed.");
    if (action === "running") {
      if (row.status !== "assigned" && row.status !== "blocked") throw new Error("Only assigned or blocked workers can start/resume.");
      row.status = "running";
    } else {
      if (!evidence.trim()) throw new Error("Provide actual evidence or a concrete blocker.");
      if (action === "accept" || action === "revise") {
        if (row.status !== "ready_for_review") throw new Error("Only submitted results can be reviewed.");
        row.review = evidence;
        row.status = action === "accept" ? "accepted" : "blocked";
      } else {
        if (action === "submit" && row.status !== "running") throw new Error("Only a running worker can submit results; record the real dispatch first.");
        row.report = evidence;
        row.status = action === "submit" ? "ready_for_review" : "blocked";
      }
    }
    this.sessions.set(session, state);
    return structuredClone(row);
  }
}
