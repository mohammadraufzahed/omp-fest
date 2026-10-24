import { isAbsolute, relative } from "node:path";
import type { NextUnit, PendingTask } from "../domain/types.js";
import type { WorkerAssignment } from "./supervisor.js";

export interface DispatchTask extends PendingTask { document: string; files?: string[]; workingDir?: string; boundaryError?: string }
export interface DispatchCandidate { task: string; sequence: string; files: string[]; dependencies: string[]; workingDir?: string }
export interface WriteLockOwner {
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
  capacity: number | "host-managed";
  candidates: DispatchCandidate[];
  waiting: { task: string; reason: string; writeLocks?: WriteLockOwner[] }[];
  barrier?: string;
}


export function taskFiles(document: string): string[] {
  return [...document.matchAll(/^- (.+) \((?:existing|proposed)\)$/gm)].flatMap((match) => match[1] ? [match[1]] : []);
}

function overlaps(a: string, b: string): boolean {
  const left = a.replaceAll("\\", "/").replace(/\/+$/, "");
  const right = b.replaceAll("\\", "/").replace(/\/+$/, "");
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function candidateOverlap(a: DispatchCandidate, b: DispatchCandidate): string | undefined {
  if (a.workingDir !== b.workingDir) return undefined;
  for (const left of a.files) for (const right of b.files) {
    if (overlaps(left, right)) return left === right ? left : left.length > right.length ? left : right;
  }
  return undefined;
}

export function dispatchQueue(input: {
  festivalDir: string; festival: string; current: NextUnit; tasks: DispatchTask[];
  workers: WorkerAssignment[]; paused: boolean; limit?: number;
}): DispatchQueue {
  const outstanding = input.workers.filter((worker) => worker.status !== "accepted" && worker.status !== "failed");
  const active = outstanding.filter((worker) => worker.status !== "blocked");
  const capacity = input.limit === undefined ? "host-managed" : Math.max(0, input.limit - active.length);
  const queue: DispatchQueue = { kind: "dispatch_queue", paused: input.paused, capacity, candidates: [], waiting: [] };
  if (input.paused) {
    queue.barrier = "Dispatch is paused; resume explicitly before assigning new work.";
    return queue;
  }
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
    if (!reason && typeof capacity === "number" && queue.candidates.length >= capacity) reason = "Outstanding assignment limit reached.";
    if (reason) queue.waiting.push({ task: task.path, reason });
    else queue.candidates.push({ task: task.path, sequence: task.sequence, files, dependencies, ...(task.workingDir ? { workingDir: task.workingDir } : {}) });
  }
  const nonOverlapping: DispatchCandidate[] = [];
  for (const candidate of queue.candidates) {
    const previous = nonOverlapping.find((item) => candidateOverlap(item, candidate) !== undefined);
    if (!previous) nonOverlapping.push(candidate);
    else {
      const file = candidateOverlap(previous, candidate);
      queue.waiting.push({
        task: candidate.task,
        reason: `Candidate file set overlaps ${previous.task} at ${file}; dispatch one task, then refresh the queue.`,
      });
    }
  }
  queue.candidates = nonOverlapping;
  return queue;
}
