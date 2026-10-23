import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OWNER_FILE = ".omp-fest-owner.json";
const LOCK_DIR = ".omp-fest-owner.lock";
const LOCK_WAIT_MS = 25;
const LOCK_ATTEMPTS = 80;

export interface FestivalOwner {
  sessionId: string;
  claimedAt: string;
}

export type OwnershipResult =
  | { kind: "claimed"; owner: FestivalOwner; transferredFrom?: FestivalOwner }
  | { kind: "owned"; owner: FestivalOwner }
  | { kind: "busy"; owner?: FestivalOwner };

async function readOwner(festivalDir: string): Promise<FestivalOwner | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(festivalDir, OWNER_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const owner = parsed as Partial<FestivalOwner>;
    return typeof owner.sessionId === "string" && typeof owner.claimedAt === "string"
      ? { sessionId: owner.sessionId, claimedAt: owner.claimedAt }
      : undefined;
  } catch {
    return undefined;
  }
}

async function withLock<T>(festivalDir: string, action: () => Promise<T>): Promise<T | undefined> {
  const lock = join(festivalDir, LOCK_DIR);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await mkdir(lock);
      try {
        return await action();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  return undefined;
}

/** Atomic ownership claim. Transfer is never implicit and replaces an older owner only explicitly. */
export async function claimFestivalOwnership(
  festivalDir: string,
  sessionId: string,
  transfer = false,
): Promise<OwnershipResult> {
  const result = await withLock(festivalDir, async () => {
    const current = await readOwner(festivalDir);
    if (current && current.sessionId !== sessionId && !transfer) {
      return { kind: "owned" as const, owner: current };
    }
    const owner: FestivalOwner = { sessionId, claimedAt: new Date().toISOString() };
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
