/**
 * Turns `.fest/progress_events.jsonl` lines into a FestivalProgress summary
 * for the persistent status line — event-sourced, no CLI polling needed.
 */
import type { FestivalProgress, PendingTask, ProgressEvent } from "./types.js";

export type TaskProgressState = "pending" | "in_progress" | "blocked" | "completed";

const TASK_STATES: Record<string, TaskProgressState | undefined> = {
  completed: "completed", task_completed: "completed", task_complete: "completed",
  reset: "pending", task_reset: "pending", pending: "pending",
  blocked: "blocked", task_blocked: "blocked", blocker_added: "blocked",
  in_progress: "in_progress", task_started: "in_progress",
  unblocked: "in_progress", task_unblocked: "in_progress", blocker_cleared: "in_progress",
};
const STEP_DONE_EVENTS: Record<string, true | undefined> = {
  wf_step_done: true, wf_step_end: true, gate_step_approved: true, checkpoint_approved: true,
};
const STEP_RESET_EVENTS: Record<string, true | undefined> = {
  wf_step_start: true, wf_step_reset: true, wf_step_block: true,
  gate_step_rejected: true, checkpoint_rejected: true,
};
const GATE_PENDING_EVENTS: Record<string, true | undefined> = { checkpoint_pending: true, gate_step_pending: true };
const GATE_RESOLVED_EVENTS: Record<string, true | undefined> = {
  gate_step_approved: true, checkpoint_approved: true, checkpoint_rejected: true,
  gate_step_rejected: true, wf_step_block: true,
};

/** Match tasks before and after a sequence/phase is moved into completed/. */
export function canonicalTaskPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").split("/")
    .filter((part) => part !== "completed").join("/");
}

/** Replay in append order: resets and blockers supersede old completions. */
export function latestTaskStates(events: readonly ProgressEvent[]): Map<string, TaskProgressState> {
  const states = new Map<string, TaskProgressState>();
  for (const event of events) {
    if (typeof event.task !== "string" || !event.task) continue;
    let state = Object.hasOwn(TASK_STATES, event.event) ? TASK_STATES[event.event] : undefined;
    if (event.event === "progress" || event.event === "task_update" || event.event === "updated") {
      state = event.status === "completed" ? "completed"
        : event.status === "pending" ? "pending"
        : event.status === "blocked" ? "blocked" : "in_progress";
    }
    if (state) states.set(canonicalTaskPath(event.task), state);
  }
  return states;
}

export function parseProgressLine(line: string): ProgressEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof data.event !== "string" || typeof data.ts !== "string") {
      return undefined;
    }
    return data as ProgressEvent;
  } catch {
    return undefined;
  }
}

export function summarizeProgress(events: readonly ProgressEvent[], tasks?: readonly PendingTask[]): FestivalProgress {
  const taskStates = latestTaskStates(events);
  const steps = new Map<string, boolean>();
  const phaseTotals = new Map<string, number>();
  const pendingGates = new Set<string>();
  let taskTotal: number | undefined;
  let currentLabel: string | undefined;
  for (const event of events) {
    const phase = typeof event.phase === "string" ? event.phase : "";
    const step = typeof event.step === "number" ? event.step : undefined;
    const key = `${phase}:${String(step ?? "gate")}`;
    const total = event.total_steps ?? event.totalSteps;
    if ((event.event === "wf_init" || event.event === "gate_init") &&
        typeof total === "number" && Number.isInteger(total) && total >= 0) {
      phaseTotals.set(phase, total);
      currentLabel = phase || currentLabel;
    }
    if (typeof event.total_tasks === "number" && Number.isInteger(event.total_tasks) && event.total_tasks >= 0) {
      taskTotal = event.total_tasks;
    }
    if (event.event === "wf_reset" || event.event === "gate_reset") {
      for (const id of steps.keys()) if (id.startsWith(`${phase}:`)) steps.delete(id);
      for (const id of pendingGates) if (id.startsWith(`${phase}:`)) pendingGates.delete(id);
    }
    if (step !== undefined && Object.hasOwn(STEP_DONE_EVENTS, event.event)) steps.set(key, true);
    if (step !== undefined && Object.hasOwn(STEP_RESET_EVENTS, event.event)) steps.set(key, false);
    if (Object.hasOwn(GATE_PENDING_EVENTS, event.event)) {
      pendingGates.add(key);
      if (step !== undefined) steps.set(key, false);
    }
    if (Object.hasOwn(GATE_RESOLVED_EVENTS, event.event)) {
      if (!phase && step === undefined) pendingGates.clear();
      else pendingGates.delete(key);
    }
    if ((event.event === "wf_step_start" || event.event === "wf_advance") && phase) {
      currentLabel = `${phase} step ${String(step ?? "?")}`;
    }
  }
  const inventory = tasks ? new Map(tasks.map((task) => [canonicalTaskPath(task.path), task])) : undefined;
  const completedTasks = inventory
    ? [...inventory].filter(([path, task]) => (taskStates.get(path) ?? (task.done ? "completed" : "pending")) === "completed").length
    : [...taskStates.values()].filter((state) => state === "completed").length;
  const completed = completedTasks + [...steps.values()].filter(Boolean).length;
  const workflowTotal = [...phaseTotals.values()].reduce((sum, count) => sum + count, 0);
  const total = inventory ? inventory.size + workflowTotal
    : taskTotal !== undefined ? taskTotal + workflowTotal
    : workflowTotal;
  return {
    completed,
    total,
    percent: total === 0 ? 0 : Math.min(100, Math.round((completed / total) * 100)),
    gatePending: pendingGates.size > 0,
    ...(currentLabel ? { currentLabel } : {}),
  };
}

export function statusLineText(input: {
  campName?: string;
  festivalId?: string;
  progress: FestivalProgress;
  phase?: string;
}): string {
  const parts: string[] = [];
  if (input.campName) {
    parts.push(`🏕 ${input.campName}`);
  }
  if (input.festivalId) {
    parts.push(input.festivalId);
  }
  if (input.phase) {
    parts.push(input.phase);
  }
  const { completed, total, gatePending } = input.progress;
  if (total > 0) {
    parts.push(`${completed}/${total}`);
  }
  if (gatePending) {
    parts.push("⛔ gate");
  }
  return parts.join(" ▸ ");
}
