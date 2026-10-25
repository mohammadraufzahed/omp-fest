import { readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { LockBusyError, processIsAlive, withStaleAwareLock } from "./fs-lock.js";

const OWNER_FILE = ".omp-fest-owner.json";
const LOCK_DIR = ".omp-fest-owner.lock";
const LOCK_BUSY_MS = 2_000;
/** Heartbeats older than this mark an owner as stale (reported, not auto-cleared). */
export const OWNER_STALE_MS = 2 * 60 * 60_000;

export interface FestivalOwner {
  sessionId: string;
  claimedAt: string;
  /** Owning omp process — a dead pid on the same host means the owner is gone. */
  pid?: number;
  host?: string;
  heartbeatAt?: string;
}

/** Snapshot shown to the human before confirming a transfer. Both fields are compared under lock. */
export type ExpectedFestivalOwner = Readonly<FestivalOwner>;

export type OwnershipResult =
  | { kind: "claimed"; owner: FestivalOwner; transferredFrom?: FestivalOwner }
  | { kind: "owned"; owner: FestivalOwner }
  | { kind: "busy"; owner?: FestivalOwner }
  | { kind: "changed"; owner?: FestivalOwner };

/** True when the recorded owner process no longer exists on this host. */
export function festivalOwnerIsDead(owner: FestivalOwner): boolean {
  return typeof owner.pid === "number" && owner.host === hostname() && !processIsAlive(owner.pid);
}

/** True when the owner's heartbeat is older than the stale window (diagnostic only). */
export function festivalOwnerIsStale(owner: FestivalOwner, nowMs = Date.now()): boolean {
  return !!owner.heartbeatAt && Date.parse(owner.heartbeatAt) < nowMs - OWNER_STALE_MS;
}

async function readOwner(festivalDir: string): Promise<FestivalOwner | undefined> {
  let text: string;
  try {
    text = await readFile(join(festivalDir, OWNER_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed === "object" && parsed !== null) {
    const owner = parsed as Partial<FestivalOwner>;
    if (typeof owner.sessionId === "string" && owner.sessionId.length > 0 &&
        typeof owner.claimedAt === "string" && owner.claimedAt.length > 0) {
      return {
        sessionId: owner.sessionId,
        claimedAt: owner.claimedAt,
        ...(typeof owner.pid === "number" ? { pid: owner.pid } : {}),
        ...(typeof owner.host === "string" ? { host: owner.host } : {}),
        ...(typeof owner.heartbeatAt === "string" ? { heartbeatAt: owner.heartbeatAt } : {}),
      };
    }
  }
  throw new Error("Festival ownership record is invalid; refusing to replace it.");
}

async function writeOwner(festivalDir: string, owner: FestivalOwner): Promise<void> {
  const temp = join(festivalDir, `${OWNER_FILE}.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(owner)}\n`, "utf8");
  await rename(temp, join(festivalDir, OWNER_FILE));
}

async function withLock<T>(festivalDir: string, action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await withStaleAwareLock(join(festivalDir, LOCK_DIR), action, { label: "Festival ownership", busyMs: LOCK_BUSY_MS, staleMs: 30_000 });
  } catch (error) {
    if (error instanceof LockBusyError) return undefined;
    throw error;
  }
}

/** Atomic claim; transfers require the exact owner snapshot that was explicitly confirmed. */
export async function claimFestivalOwnership(
  festivalDir: string,
  sessionId: string,
  expectedOwner?: ExpectedFestivalOwner,
): Promise<OwnershipResult> {
  const result = await withLock(festivalDir, async () => {
    const current = await readOwner(festivalDir);
    const now = new Date().toISOString();
    // A dead owner never blocks a claim — the process is gone, so the lock is
    // free for whoever asks next without needing human confirmation.
    const deadOwner = current && current.sessionId !== sessionId && festivalOwnerIsDead(current);
    // Repeating a completed claim/transfer is a safe recovery path. It does
    // not authorize a new transfer: only the already-installed target owner
    // can match this branch; all other changes still require the exact CAS.
    if (current?.sessionId === sessionId) {
      // Idempotent: skip the write when the recorded owner is already this
      // process and the heartbeat is fresh — a re-claim must return the same
      // record, not rotate the timestamp.
      const fresh = current.pid === process.pid && current.host === hostname() &&
        !!current.heartbeatAt && Date.now() - Date.parse(current.heartbeatAt) < 60_000;
      const owner: FestivalOwner = fresh ? current : { ...current, pid: process.pid, host: hostname(), heartbeatAt: now };
      if (!fresh) await writeOwner(festivalDir, owner);
      return {
        kind: "claimed" as const,
        owner,
        ...(expectedOwner && expectedOwner.sessionId !== sessionId ? { transferredFrom: expectedOwner } : {}),
      };
    }
    if (expectedOwner && (current?.sessionId !== expectedOwner.sessionId || current.claimedAt !== expectedOwner.claimedAt)) {
      return { kind: "changed" as const, ...(current ? { owner: current } : {}) };
    }
    if (current && !expectedOwner && !deadOwner) return { kind: "owned" as const, owner: current };
    const previousTime = current ? Date.parse(current.claimedAt) : Number.NaN;
    const owner: FestivalOwner = {
      sessionId,
      claimedAt: new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString(),
      pid: process.pid,
      host: hostname(),
      heartbeatAt: now,
    };
    await writeOwner(festivalDir, owner);
    return { kind: "claimed" as const, owner, ...(current && current.sessionId !== sessionId ? { transferredFrom: current } : {}) };
  });
  return result ?? { kind: "busy" };
}

/** Refresh the liveness marker on an existing claim; a no-op when the session does not own it. */
export async function touchFestivalOwnership(festivalDir: string, sessionId: string): Promise<void> {
  await withLock(festivalDir, async () => {
    const current = await readOwner(festivalDir);
    if (current?.sessionId !== sessionId) return;
    await writeOwner(festivalDir, { ...current, pid: process.pid, host: hostname(), heartbeatAt: new Date().toISOString() });
  });
}

export async function festivalOwner(festivalDir: string): Promise<FestivalOwner | undefined> {
  return readOwner(festivalDir);
}
