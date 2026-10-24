export const PORTFOLIO_MAX_WORKERS = 20;
export const DEFAULT_PORTFOLIO_WORKERS = 20;

export interface PortfolioFestivalQueue {
  festival: string;
  candidates: PortfolioCandidate[];
  waiting: { task: string; reason: string }[];
}
export interface PortfolioCandidate {
  festival: string;
  task: string;
  sequence: string;
  files: string[];
  dependencies: string[];
  workingDir: string;
  priority?: "urgent" | "high" | "normal" | "low";
}
export interface PortfolioAssignment {
  festival: string;
  task: string;
  status: "assigned" | "running" | "blocked" | "submitted" | "accepted" | "failed";
}
export interface PortfolioQueue {
  kind: "portfolio_queue";
  paused: boolean;
  workerLimit: number;
  activeWorkers: number;
  availableSlots: number;
  lastFestival?: string;
  candidates: PortfolioCandidate[];
  waiting: { festival: string; task: string; reason: string }[];
}

export function buildPortfolioQueue(input: {
  festivals: PortfolioFestivalQueue[];
  assignments: PortfolioAssignment[];
  paused: boolean;
  workerLimit?: number;
  lastFestival?: string;
}): PortfolioQueue {
  const workerLimit = input.workerLimit ?? DEFAULT_PORTFOLIO_WORKERS;
  if (!Number.isInteger(workerLimit) || workerLimit < 1 || workerLimit > PORTFOLIO_MAX_WORKERS) {
    throw new RangeError(`workerLimit must be an integer from 1 to ${PORTFOLIO_MAX_WORKERS}`);
  }
  const active = input.assignments.filter((a) => a.status !== "accepted" && a.status !== "failed" && a.status !== "blocked");
  const held = input.assignments.filter((a) => a.status !== "accepted" && a.status !== "failed");
  const activeWorkers = active.length;
  const availableSlots = Math.max(0, workerLimit - activeWorkers);
  const result: PortfolioQueue = {
    kind: "portfolio_queue", paused: input.paused, workerLimit, activeWorkers, availableSlots,
    ...(input.lastFestival === undefined ? {} : { lastFestival: input.lastFestival }), candidates: [], waiting: [],
  };
  if (input.paused) {
    for (const f of input.festivals) {
      for (const row of f.candidates) result.waiting.push({ festival: f.festival, task: row.task, reason: "Portfolio dispatch is paused." });
      for (const row of f.waiting) result.waiting.push({ festival: f.festival, ...row, reason: "Portfolio dispatch is paused." });
    }
    return result;
  }
  for (const f of input.festivals) for (const row of f.waiting) result.waiting.push({ festival: f.festival, ...row });
  const activeKeys = new Set(held.map((a) => `${a.festival}\0${a.task}`));
  const submittedKeys = new Set(input.assignments.filter((a) => a.status === "submitted").map((a) => `${a.festival}\0${a.task}`));
  const seen = new Set<string>();
  const lists = input.festivals.map((f) => {
    const eligible: PortfolioCandidate[] = [];
    for (const c of f.candidates) {
      if (c.festival !== f.festival) continue;
      const key = `${f.festival}\0${c.task}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (activeKeys.has(key)) result.waiting.push({ festival: f.festival, task: c.task, reason: "An active assignment already owns this task; do not relaunch." });
      else if (submittedKeys.has(key)) result.waiting.push({ festival: f.festival, task: c.task, reason: "A submitted assignment awaits completion; do not repeat implementation." });
      else eligible.push(c);
    }
    const rank = { urgent: 0, high: 1, normal: 2, low: 3 } as const;
    eligible.sort((a, b) => rank[a.priority ?? "normal"] - rank[b.priority ?? "normal"]);
    return eligible;
  });
  const festivals = input.festivals.map((f) => f.festival);
  let start = 0;
  if (input.lastFestival !== undefined) {
    const index = festivals.indexOf(input.lastFestival);
    if (index >= 0 && festivals.length) start = (index + 1) % festivals.length;
  }
  const order = festivals.map((_, i) => (start + i) % festivals.length);
  const positions = lists.map(() => 0);
  while (result.candidates.length < availableSlots) {
    let moved = false;
    for (const index of order) {
      if (result.candidates.length >= availableSlots) break;
      const position = positions[index];
      if (position === undefined) continue;
      const list = lists[index];
      if (list === undefined) continue;
      const c = list[position];
      if (c === undefined) continue;
      positions[index] = position + 1;
      result.candidates.push(c);
      moved = true;
    }
    if (!moved) break;
  }
  for (let i = 0; i < lists.length; i++) {
    const festival = festivals[i];
    const eligible = lists[i];
    if (festival === undefined || eligible === undefined) continue;
    for (const c of eligible) {
      if (!result.candidates.includes(c)) result.waiting.push({ festival, task: c.task, reason: "Portfolio worker limit reached." });
    }
  }
  return result;
}
