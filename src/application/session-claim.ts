/**
 * Festival claim persistence: the session's festival pick is stored as a
 * custom session entry (omp's durable per-session state — it survives resume,
 * compaction, branch, and tree navigation) and restored from the transcript
 * branch on session lifecycle events. In-memory tracking lives in LoopTracker;
 * this module is only the transcript seam.
 */
import type { FestivalResolutionSource } from "./fest-resolve.js";
import type { LoopTracker } from "./loop-tracker.js";

/** customType of the transcript entry — package-qualified per omp convention. */
export const FESTIVAL_CLAIM_ENTRY = "com.github.mohammadraufzahed.omp-fest.festival";

export interface FestivalClaimData {
  festivalId?: string;
  festivalDir?: string;
  campRoot?: string;
  /** Origin of the persisted selection; absent on historical branch entries. */
  source?: FestivalResolutionSource;
}

/** Entries from ctx.sessionManager.getBranch(), loosely typed at the seam. */
interface BranchEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

function claimDataOf(entry: unknown): FestivalClaimData | undefined {
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const { type, customType, data } = entry as BranchEntryLike;
  if (type !== "custom" || customType !== FESTIVAL_CLAIM_ENTRY) {
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const claim = data as FestivalClaimData;
  return {
    ...(typeof claim.festivalId === "string" ? { festivalId: claim.festivalId } : {}),
    ...(typeof claim.festivalDir === "string" ? { festivalDir: claim.festivalDir } : {}),
    ...(typeof claim.campRoot === "string" ? { campRoot: claim.campRoot } : {}),
    ...(claim.source === "explicit-selector" || claim.source === "session-claim" ? { source: claim.source } : {}),
  };
}

/** Return the latest usable selection record, retaining its explicit origin metadata. */
export function claimDataFromBranch(entries: unknown[]): FestivalClaimData | undefined {
  let latest: FestivalClaimData | undefined;
  for (const entry of entries) {
    const data = claimDataOf(entry);
    if (data && (data.festivalId !== undefined || data.festivalDir !== undefined)) {
      latest = data;
    }
  }
  return latest;
}

/**
 * Restore the session's claimed festival from its transcript branch — the
 * latest claim entry wins. Returns the restored festival id, or undefined
 * when the branch carries no usable claim.
 */
export function restoreClaimFromBranch(
  tracker: LoopTracker,
  sessionId: string,
  entries: unknown[],
): string | undefined {
  const latest = claimDataFromBranch(entries);
  if (!latest) {
    return undefined;
  }
  return tracker.restoreClaim(sessionId, latest.festivalId, latest.festivalDir);
}
