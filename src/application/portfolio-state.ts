import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const PORTFOLIO_LIMIT_MAX = 20;
export const PORTFOLIO_LIMIT_DEFAULT = 20;

export interface PortfolioStateAssignment {
  id: string;
  festival: string;
  task: string;
  sessionId: string;
  worker: string;
  workingDir: string;
  files: string[];
  status: "assigned" | "running" | "blocked" | "submitted" | "accepted" | "failed" | "released";
  createdAt: string;
  updatedAt: string;
  report?: string;
  review?: string;
  reviewSource?: "worker-submission" | "coordinator-worktree";
  failure?: string;
  runtimeId?: string;
  runtimeStatus?: "running" | "completed" | "failed" | "exited" | "unverifiable";
  runtimeObservedAt?: string;
}
export interface PortfolioState {
  version: 1;
  workerLimit: number;
  paused: boolean;
  lastFestival?: string;
  assignments: PortfolioStateAssignment[];
}

const STORE = ".ompfest";
const FILE = "portfolio.json";
const LOCK = "portfolio.lock";
const ACTIVE = new Set<PortfolioStateAssignment["status"]>(["assigned", "running", "blocked", "submitted"]);
const WORKER_SLOTS = new Set<PortfolioStateAssignment["status"]>(["assigned", "running", "submitted"]);
const TERMINAL = new Set<PortfolioStateAssignment["status"]>(["accepted", "failed", "released"]);
const STATUSES = new Set<PortfolioStateAssignment["status"]>([...ACTIVE, ...TERMINAL]);
const RUNTIME_STATUSES = new Set(["running", "completed", "failed", "exited", "unverifiable"]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function validAssignment(value: unknown): value is PortfolioStateAssignment {
  if (!record(value)) return false;
  const allowed = new Set(["id", "festival", "task", "sessionId", "worker", "workingDir", "files", "status", "createdAt", "updatedAt", "report", "review", "reviewSource", "failure", "runtimeId", "runtimeStatus", "runtimeObservedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  for (const key of ["id", "festival", "task", "sessionId", "worker", "workingDir"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) return false;
  }
  return Array.isArray(value.files) && value.files.every((file) => typeof file === "string") &&
    typeof value.status === "string" && STATUSES.has(value.status as PortfolioStateAssignment["status"]) &&
    validTimestamp(value.createdAt) && validTimestamp(value.updatedAt) &&
    (value.report === undefined || typeof value.report === "string") &&
    (value.review === undefined || typeof value.review === "string") &&
    (value.reviewSource === undefined || value.reviewSource === "worker-submission" || value.reviewSource === "coordinator-worktree") &&
    (value.failure === undefined || typeof value.failure === "string") &&
    (value.runtimeId === undefined || (typeof value.runtimeId === "string" && !!value.runtimeId.trim())) &&
    (value.runtimeStatus === undefined || (typeof value.runtimeStatus === "string" && RUNTIME_STATUSES.has(value.runtimeStatus))) &&
    (value.runtimeObservedAt === undefined || validTimestamp(value.runtimeObservedAt));
}
function validState(value: unknown): value is PortfolioState {
  if (!record(value) || Object.keys(value).some((key) => !["version", "workerLimit", "paused", "lastFestival", "assignments"].includes(key)) ||
      value.version !== 1 || !Number.isInteger(value.workerLimit) || (value.workerLimit as number) < 1 || (value.workerLimit as number) > PORTFOLIO_LIMIT_MAX ||
      (value.paused !== undefined && typeof value.paused !== "boolean") ||
      (value.lastFestival !== undefined && (typeof value.lastFestival !== "string" || !value.lastFestival.trim())) || !Array.isArray(value.assignments) ||
      !value.assignments.every(validAssignment)) return false;
  const ids = new Set<string>();
  const activeTasks = new Set<string>();
  for (const assignment of value.assignments) {
    if (ids.has(assignment.id)) return false;
    ids.add(assignment.id);
    if (ACTIVE.has(assignment.status)) {
      const key = `${assignment.festival}\0${assignment.task}`;
      if (activeTasks.has(key)) return false;
      activeTasks.add(key);
    }
  }
  return true;
}

async function directory(root: string, create: boolean): Promise<{ file: string; lock: string }> {
  const camp = await realpath(root);
  const path = join(camp, STORE);
  let info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!info && create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    info = await lstat(path);
  }
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("Portfolio storage .ompfest must be a real directory, not a symlink");
  if (info) await chmod(path, 0o700);
  return { file: join(path, FILE), lock: join(path, LOCK) };
}
async function readFileState(file: string): Promise<PortfolioState> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, workerLimit: PORTFOLIO_LIMIT_DEFAULT, paused: false, assignments: [] };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("Portfolio state is corrupt; refusing to overwrite it."); }
  if (!validState(parsed)) throw new Error("Portfolio state is invalid; refusing to overwrite it.");
  const state = parsed as Omit<PortfolioState, "paused"> & { paused?: boolean };
  return state.paused === undefined ? { ...state, paused: false } : state as PortfolioState;
}
async function safeFile(file: string): Promise<void> {
  const info = await lstat(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error("Portfolio state path must be a regular file, not a symlink or directory");
}
interface LockOwner { token: string; pid: number; host: string }
async function readLockOwner(lock: string): Promise<LockOwner | undefined> {
  try {
    const owner: unknown = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    if (!record(owner) || typeof owner.token !== "string" || !owner.token || typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || typeof owner.host !== "string") return undefined;
    return { token: owner.token, pid: owner.pid, host: owner.host };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function locked<T>(paths: { file: string; lock: string }, operation: (state: PortfolioState) => { state: PortfolioState; result: T }): Promise<T> {
  const started = Date.now();
  const token = randomUUID();
  for (;;) {
    try {
      await mkdir(paths.lock, { mode: 0o700 });
      await writeFile(join(paths.lock, "owner.json"), JSON.stringify({ token, pid: process.pid, host: hostname() }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const lockInfo = await lstat(paths.lock).catch((statError: unknown) => {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw statError;
      });
      if (lockInfo && (!lockInfo.isDirectory() || lockInfo.isSymbolicLink())) throw new Error("Portfolio lock path is unsafe", { cause: error });
      const owner = lockInfo ? await readLockOwner(paths.lock) : undefined;
      if (owner?.host === hostname() && !processIsAlive(owner.pid)) {
        const stale = `${paths.lock}.stale-${randomUUID()}`;
        try {
          await rename(paths.lock, stale);
          const movedOwner = await readLockOwner(stale);
          if (movedOwner?.token === owner.token && movedOwner.pid === owner.pid && movedOwner.host === owner.host) {
            await rm(stale, { recursive: true, force: true });
          } else {
            try { await rename(stale, paths.lock); } catch (restoreError) {
              if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") throw restoreError;
            }
          }
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
        }
        continue;
      }
      if (Date.now() - started > 10_000) throw new Error("Portfolio state is locked by another writer; retry shortly.", { cause: error });
      await sleep(10);
    }
  }
  let temp: string | undefined;
  try {
    await safeFile(paths.file);
    const state = await readFileState(paths.file);
    const changed = operation(state);
    if (!validState(changed.state)) throw new Error("Refusing to persist invalid portfolio state.");
    temp = join(paths.lock, `${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(changed.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, paths.file);
    return changed.result;
  } finally {
    if (temp) await rm(temp, { force: true });
    if ((await readLockOwner(paths.lock))?.token === token) await rm(paths.lock, { recursive: true, force: true });
  }
}
function now(): string { return new Date().toISOString(); }
function activeCount(state: PortfolioState): number { return state.assignments.filter((row) => WORKER_SLOTS.has(row.status)).length; }

export async function readPortfolioState(campRoot: string): Promise<PortfolioState> {
  const paths = await directory(campRoot, false);
  await safeFile(paths.file);
  return readFileState(paths.file);
}
export async function setPortfolioWorkerLimit(campRoot: string, limit: number): Promise<PortfolioState> {
  if (!Number.isInteger(limit) || limit < 1 || limit > PORTFOLIO_LIMIT_MAX) throw new RangeError(`worker limit must be an integer from 1 to ${PORTFOLIO_LIMIT_MAX}`);
  const paths = await directory(campRoot, true);
  return locked(paths, (state) => {
    const count = activeCount(state);
    if (limit < count) throw new Error(`worker limit ${limit} is below the ${count} active portfolio assignments`);
    const next = { ...state, workerLimit: limit };
    return { state: next, result: next };
  });
}
export async function setPortfolioPaused(campRoot: string, paused: boolean): Promise<PortfolioState> {
  const paths = await directory(campRoot, true);
  return locked(paths, (state) => {
    const next = { ...state, paused };
    return { state: next, result: next };
  });
}
export async function reservePortfolioAssignment(campRoot: string, input: Omit<PortfolioStateAssignment, "status" | "createdAt" | "updatedAt">): Promise<PortfolioStateAssignment> {
  const paths = await directory(campRoot, true);
  return locked(paths, (state) => {
    const existing = state.assignments.find((row) => row.id === input.id);
    if (existing) {
      if (existing.festival === input.festival && existing.task === input.task && existing.sessionId === input.sessionId &&
          existing.worker === input.worker && existing.workingDir === input.workingDir &&
          JSON.stringify(existing.files) === JSON.stringify(input.files)) return { state, result: existing };
      throw new Error(`Portfolio assignment ID already exists: ${input.id}`);
    }
    if (state.paused) throw new Error("Portfolio dispatch is paused; cannot reserve a new assignment.");
    if (state.assignments.some((row) => ACTIVE.has(row.status) && row.festival === input.festival && row.task === input.task)) {
      throw new Error(`Portfolio task is already active: ${input.festival}/${input.task}`);
    }
    const count = activeCount(state);
    if (count >= state.workerLimit) throw new Error(`Portfolio worker limit reached (${state.workerLimit})`);
    const timestamp = now();
    const assignment: PortfolioStateAssignment = { ...input, files: [...input.files], status: "assigned", createdAt: timestamp, updatedAt: timestamp };
    if (!validAssignment(assignment)) throw new Error("Invalid portfolio assignment input.");
    const next = { ...state, assignments: [...state.assignments, assignment] };
    return { state: next, result: assignment };
  });
}
export async function updatePortfolioAssignment(campRoot: string, id: string, status: PortfolioStateAssignment["status"], details?: { report?: string; review?: string; reviewSource?: PortfolioStateAssignment["reviewSource"]; failure?: string; festival?: string }): Promise<PortfolioStateAssignment> {
  const paths = await directory(campRoot, true);
  return locked(paths, (state) => {
    const index = state.assignments.findIndex((row) => row.id === id);
    const prior = state.assignments[index];
    if (!prior) throw new Error(`Unknown portfolio assignment: ${id}`);
    if (TERMINAL.has(prior.status)) {
      if (prior.status === status && (details?.report === undefined || details.report === prior.report) &&
          (details?.review === undefined || details.review === prior.review) &&
          (details?.reviewSource === undefined || details.reviewSource === prior.reviewSource) &&
          (details?.failure === undefined || details.failure === prior.failure) && (details?.festival === undefined || details.festival === prior.festival)) {
        return { state, result: prior };
      }
      throw new Error(`Portfolio assignment ${id} is terminal (${prior.status})`);
    }
    if (!STATUSES.has(status)) throw new Error(`Invalid portfolio assignment status: ${status}`);
    const festival = details?.festival ?? prior.festival;
    if (ACTIVE.has(status) && state.assignments.some((row) => row.id !== id && ACTIVE.has(row.status) && row.festival === festival && row.task === prior.task)) {
      throw new Error(`Portfolio task is already active: ${festival}/${prior.task}`);
    }
    const assignment: PortfolioStateAssignment = { ...prior, status, festival, updatedAt: now(), ...(details?.report !== undefined ? { report: details.report } : {}), ...(details?.review !== undefined ? { review: details.review } : {}), ...(details?.reviewSource !== undefined ? { reviewSource: details.reviewSource } : {}), ...(details?.failure !== undefined ? { failure: details.failure } : {}) };
    const assignments = [...state.assignments]; assignments[index] = assignment;
    const next = { ...state, assignments };
    if (activeCount(next) > state.workerLimit) throw new Error(`Portfolio worker limit reached (${state.workerLimit})`);
    return { state: next, result: assignment };
  });
}
export async function releasePortfolioAssignment(campRoot: string, id: string, reason: string): Promise<PortfolioStateAssignment> {
  if (typeof reason !== "string" || !reason.trim()) throw new Error("Portfolio release reason is required");
  return updatePortfolioAssignment(campRoot, id, "released", { failure: reason });
}
export async function updatePortfolioAssignmentRuntime(
  campRoot: string,
  id: string,
  runtime: { runtimeId?: string; runtimeStatus?: NonNullable<PortfolioStateAssignment["runtimeStatus"]>; runtimeObservedAt?: string },
): Promise<PortfolioStateAssignment> {
  const paths = await directory(campRoot, true);
  return locked(paths, (state) => {
    const index = state.assignments.findIndex((row) => row.id === id);
    const prior = state.assignments[index];
    if (!prior) throw new Error(`Unknown portfolio assignment: ${id}`);
    const assignment: PortfolioStateAssignment = { ...prior, ...runtime, updatedAt: now() };
    const assignments = [...state.assignments]; assignments[index] = assignment;
    const next = { ...state, assignments };
    return { state: next, result: assignment };
  });
}
export async function recordPortfolioFestivalDispatch(campRoot: string, festival: string): Promise<PortfolioState> {
  if (typeof festival !== "string" || !festival.trim()) throw new Error("festival is required");
  const paths = await directory(campRoot, true);
  return locked(paths, (state) => {
    const next = { ...state, lastFestival: festival };
    return { state: next, result: next };
  });
}
export async function listStalePortfolioAssignments(campRoot: string, olderThanMs: number, nowMs = Date.now()): Promise<PortfolioStateAssignment[]> {
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0 || !Number.isFinite(nowMs)) throw new RangeError("stale assignment cutoff must be finite and non-negative");
  const state = await readPortfolioState(campRoot);
  const cutoff = nowMs - olderThanMs;
  return state.assignments.filter((row) => ACTIVE.has(row.status) && Date.parse(row.updatedAt) < cutoff);
}
