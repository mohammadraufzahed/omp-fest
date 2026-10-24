import { isAbsolute, relative, resolve, sep } from "node:path";
import type { NextUnit, PendingTask } from "../domain/types.js";
import type { WorkerAssignment } from "./supervisor.js";

export interface DispatchTask extends PendingTask { document: string; files?: string[]; workingDir?: string; boundaryError?: string }
export interface DispatchCandidate { task: string; sequence: string; files: string[]; dependencies: string[]; workingDir?: string }
export interface ReservationOwner {
  sessionId: string;
  assignmentId: string;
  worker?: string;
  festival?: string;
  task?: string;
  files: string[];
  reservedAt: string;
}
export interface DispatchQueue {
  kind: "dispatch_queue";
  paused: boolean;
  capacity: number;
  candidates: DispatchCandidate[];
  waiting: { task: string; reason: string; reservations?: ReservationOwner[] }[];
  barrier?: string;
}

/** Canonical file boundaries, including directory boundaries, are sequential. */
export function filesOverlap(left: string[], right: string[]): boolean {
  if (!left.length || !right.length) return true;
  return left.some((file) => right.some((other) => {
    const a = resolve(file), b = resolve(other);
    const ab = relative(a, b), ba = relative(b, a);
    return a === b || (!isAbsolute(ab) && ab !== ".." && !ab.startsWith(`..${sep}`)) ||
      (!isAbsolute(ba) && ba !== ".." && !ba.startsWith(`..${sep}`));
  }));
}

export function taskFiles(document: string): string[] {
  return [...document.matchAll(/^- (.+) \((?:existing|proposed)\)$/gm)].flatMap((match) => match[1] ? [match[1]] : []);
}

export function dispatchQueue(input: {
  festivalDir: string; festival: string; current: NextUnit; tasks: DispatchTask[];
  workers: WorkerAssignment[]; paused: boolean; limit?: number;
}): DispatchQueue {
  const outstanding = input.workers.filter((worker) => worker.status !== "accepted");
  const capacity = Math.max(0, (input.limit ?? 3) - outstanding.length);
  const queue: DispatchQueue = { kind: "dispatch_queue", paused: input.paused, capacity, candidates: [], waiting: [] };
  if (input.current.kind !== "task") {
    queue.barrier = `Current festival unit is ${input.current.kind}; resolve it before implementation dispatch.`;
    return queue;
  }
  const current = isAbsolute(input.current.path) ? relative(input.festivalDir, input.current.path) : input.current.path;
  const phase = current.split("/")[0];
  const completed = new Set(input.tasks.filter((task) => task.done).flatMap((task) => {
    const id = /^Task ID:[ \t]*(.+)$/m.exec(task.document)?.[1]?.trim();
    return id ? [id] : [];
  }));
  const first = new Set<string>();
  for (const task of [...input.tasks].sort((a, b) => a.path.localeCompare(b.path))) {
    if (task.done || task.path.split("/")[0] !== phase) continue;
    let reason: string | undefined;
    if (first.has(task.sequence)) reason = "Earlier task in this sequence is unfinished.";
    first.add(task.sequence);
    const dependencyLine = /^Dependencies:[ \t]*(.+)$/m.exec(task.document)?.[1]?.trim();
    const dependencies = dependencyLine === "none" ? [] : dependencyLine?.split(/\s*,\s*/).filter(Boolean) ?? [];
    const files = task.files ?? taskFiles(task.document);
    if (!reason && task.boundaryError) reason = task.boundaryError;
    if (!reason && !dependencyLine && task.path !== current) reason = "Parallel dispatch requires an explicit dependency contract.";
    if (!reason && dependencies.some((id) => !completed.has(id))) reason = "Task dependencies are not completed.";
    if (!reason && outstanding.some((worker) => worker.festival === input.festival && worker.task === task.path)) reason = "An unfinished assignment already owns this task; reconcile it, never relaunch.";
    if (!reason && input.workers.some((worker) => worker.status === "accepted" && worker.festival === input.festival && worker.task === task.path)) reason = "Accepted submission awaits festival task completion; do not repeat implementation.";
    if (!reason && input.paused) reason = "Dispatch is paused.";
    if (!reason && queue.candidates.length >= capacity) reason = "Outstanding assignment limit reached.";
    if (!reason && (outstanding.some((worker) => filesOverlap(files, worker.files)) || queue.candidates.some((candidate) => filesOverlap(files, candidate.files)))) reason = "Overlapping or unknown file boundary; keep work sequential.";
    if (reason) queue.waiting.push({ task: task.path, reason });
    else queue.candidates.push({ task: task.path, sequence: task.sequence, files, dependencies, ...(task.workingDir ? { workingDir: task.workingDir } : {}) });
  }
  return queue;
}
