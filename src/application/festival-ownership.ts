import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

const OWNER_FILE = ".omp-fest-owner.json";
const LOCK_DIR = ".omp-fest-owner.lock";
const LOCK_WAIT_MS = 25;
const LOCK_ATTEMPTS = 80;

export interface FestivalOwner {
  sessionId: string;
  claimedAt: string;
}

/** Snapshot shown to the human before confirming a transfer. Both fields are compared under lock. */
export type ExpectedFestivalOwner = Readonly<FestivalOwner>;

export type OwnershipResult =
  | { kind: "claimed"; owner: FestivalOwner; transferredFrom?: FestivalOwner }
  | { kind: "owned"; owner: FestivalOwner }
  | { kind: "busy"; owner?: FestivalOwner }
  | { kind: "changed"; owner?: FestivalOwner };

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
      return { sessionId: owner.sessionId, claimedAt: owner.claimedAt };
    }
  }
  throw new Error("Festival ownership record is invalid; refusing to replace it.");
}

async function withLock<T>(festivalDir: string, action: () => Promise<T>): Promise<T | undefined> {
  const lock = join(festivalDir, LOCK_DIR);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await setTimeout(LOCK_WAIT_MS);
      continue;
    }
    try {
      return await action();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
  return undefined;
}

/** Atomic claim; transfers require the exact owner snapshot that was explicitly confirmed. */
export async function claimFestivalOwnership(
  festivalDir: string,
  sessionId: string,
  expectedOwner?: ExpectedFestivalOwner,
): Promise<OwnershipResult> {
  const result = await withLock(festivalDir, async () => {
    const current = await readOwner(festivalDir);
    // Repeating a completed claim/transfer is a safe recovery path. It does
    // not authorize a new transfer: only the already-installed target owner
    // can match this branch; all other changes still require the exact CAS.
    if (current?.sessionId === sessionId) {
      return {
        kind: "claimed" as const,
        owner: current,
        ...(expectedOwner && expectedOwner.sessionId !== sessionId ? { transferredFrom: expectedOwner } : {}),
      };
    }
    if (expectedOwner && (current?.sessionId !== expectedOwner.sessionId || current.claimedAt !== expectedOwner.claimedAt)) {
      return { kind: "changed" as const, ...(current ? { owner: current } : {}) };
    }
    if (current && !expectedOwner) return { kind: "owned" as const, owner: current };
    const previousTime = current ? Date.parse(current.claimedAt) : Number.NaN;
    const owner: FestivalOwner = {
      sessionId,
      claimedAt: new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString(),
    };
    const temp = join(festivalDir, `${OWNER_FILE}.${process.pid}.tmp`);
    await writeFile(temp, `${JSON.stringify(owner)}\n`, "utf8");
    await rename(temp, join(festivalDir, OWNER_FILE));
    return { kind: "claimed" as const, owner, ...(current && current.sessionId !== sessionId ? { transferredFrom: current } : {}) };
  });
  return result ?? { kind: "busy" };
}

export async function festivalOwner(festivalDir: string): Promise<FestivalOwner | undefined> {
  return readOwner(festivalDir);
}
