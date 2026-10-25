/**
 * Crash-safe file lock — one primitive for every omp-fest lock.
 *
 * The lock is a directory holding `owner.json` ({token, pid, host,
 * acquiredAt}). When `mkdir` fails with EEXIST the owner record decides:
 * same-host dead pid → CAS-move aside and reclaim; missing/corrupt owner or
 * a legacy lock file/directory → reclaim once the entry is older than
 * `staleMs`; anything else → wait until `busyMs` then throw LockBusyError.
 * A killed process can therefore never brick the resource — worst case is a
 * short wait.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface FsLockOwner {
  token: string;
  pid: number;
  host: string;
  acquiredAt: string;
}

export interface StaleAwareLockOptions {
  /** Milliseconds to wait for a live owner before failing. Default 10_000. */
  busyMs?: number;
  /** Ownerless/legacy lock entries older than this may be reclaimed. Default 60_000. */
  staleMs?: number;
  /** Reclaim locks owned by a different host after this age. Default 15 minutes. */
  foreignStaleMs?: number;
  /** Label used in the busy error. */
  label?: string;
}

export class LockBusyError extends Error {
  readonly label: string;
  constructor(label: string, cause?: unknown) {
    super(`${label} is busy; retry shortly.`, cause === undefined ? undefined : { cause });
    this.name = "LockBusyError";
    this.label = label;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export async function readFsLockOwner(lock: string): Promise<FsLockOwner | undefined> {
  try {
    const owner: unknown = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    if (!record(owner) || typeof owner.token !== "string" || !owner.token ||
        typeof owner.pid !== "number" || !Number.isInteger(owner.pid) ||
        typeof owner.host !== "string" || typeof owner.acquiredAt !== "string") return undefined;
    return { token: owner.token, pid: owner.pid, host: owner.host, acquiredAt: owner.acquiredAt };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function entryInfo(path: string) {
  const info = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  return info;
}

/** Remove a verified-stale entry via CAS rename; only deletes what we inspected. */
async function reclaimStale(path: string, expectedMtimeMs: number): Promise<boolean> {
  const stale = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  try {
    const moved = await entryInfo(stale);
    if (!moved || Math.abs(moved.mtimeMs - expectedMtimeMs) > 1) {
      try {
        await rename(stale, path);
      } catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") throw restoreError;
      }
      return false;
    }
    await rm(stale, { recursive: true, force: true });
    return true;
  } catch (error) {
    await rename(stale, path).catch(() => undefined);
    throw error;
  }
}

/**
 * Run `action` under a mkdir lock at `dir`. Returns the action result.
 * Stale locks are reclaimed transparently; a live foreign owner past
 * `busyMs` throws LockBusyError.
 */
export async function withStaleAwareLock<T>(dir: string, action: () => Promise<T>, options: StaleAwareLockOptions = {}): Promise<T> {
  const busyMs = options.busyMs ?? 10_000;
  const staleMs = options.staleMs ?? 60_000;
  const foreignStaleMs = options.foreignStaleMs ?? 15 * 60_000;
  const label = options.label ?? dir;
  const token = randomUUID();
  const start = Date.now();
  for (;;) {
    let acquired = false;
    try {
      await mkdir(dir, { mode: 0o700 });
      acquired = true;
      const owner: FsLockOwner = { token, pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString() };
      await writeFile(join(dir, "owner.json"), JSON.stringify(owner), { encoding: "utf8", mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if (acquired) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await entryInfo(dir);
      if (!info) continue;
      if (info.isSymbolicLink()) throw new Error(`Lock path is unsafe: ${dir}`, { cause: error });
      if (Date.now() - info.mtimeMs > staleMs) {
        if (await reclaimStale(dir, info.mtimeMs)) continue;
      }
      if (info.isDirectory()) {
        const owner = await readFsLockOwner(dir);
        if (owner?.host === hostname() && !processIsAlive(owner.pid)) {
          if (await reclaimStale(dir, info.mtimeMs)) continue;
        } else if (owner && owner.host !== hostname() && Date.now() - info.mtimeMs > foreignStaleMs) {
          if (await reclaimStale(dir, info.mtimeMs)) continue;
        }
      }
      if (Date.now() - start >= busyMs) throw new LockBusyError(label, error);
      await sleep(Math.min(25, Math.max(5, busyMs / 40)));
    }
  }
  try {
    return await action();
  } finally {
    if ((await readFsLockOwner(dir))?.token === token) {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
