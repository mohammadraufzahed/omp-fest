/**
 * Turns `.fest/progress_events.jsonl` lines into a FestivalProgress summary
 * for the persistent status line — event-sourced, no CLI polling needed.
 */
import type { FestivalProgress, ProgressEvent } from "./types.js";

const COMPLETE_EVENTS = new Set([
  "task_completed",
  "wf_step_end",
  "gate_step_approved",
  "task_complete",
]);
const GATE_PENDING_EVENTS = new Set(["checkpoint_pending", "gate_step_pending"]);
const GATE_RESOLVED_EVENTS = new Set([
  "gate_step_approved",
  "checkpoint_approved",
  "checkpoint_rejected",
]);

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

export function summarizeProgress(events: ProgressEvent[]): FestivalProgress {
  let completed = 0;
  let total = 0;
  let gatePending = false;
  let currentLabel: string | undefined;
  for (const event of events) {
    if (event.event === "wf_init" && typeof event.total_steps === "number") {
      total += event.total_steps;
      currentLabel = event.phase;
    }
    if (event.event === "wf_step_start" && event.phase) {
      currentLabel = `${event.phase} step ${String(event.step ?? "?")}`;
    }
    if (COMPLETE_EVENTS.has(event.event)) {
      completed += 1;
    }
    if (GATE_PENDING_EVENTS.has(event.event)) {
      gatePending = true;
    }
    if (GATE_RESOLVED_EVENTS.has(event.event)) {
      gatePending = false;
    }
  }
  return {
    completed,
    total,
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    gatePending,
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
