/**
 * Festival claim persistence: the session's festival pick is stored as a
 * custom session entry (omp's durable per-session state — it survives resume,
 * compaction, branch, and tree navigation) and restored from the transcript
 * branch on session lifecycle events. In-memory tracking lives in LoopTracker;
 * this module is only the transcript seam.
 */
import type { LoopTracker } from "./loop-tracker.js";

/** customType of the transcript entry — package-qualified per omp convention. */
export const FESTIVAL_CLAIM_ENTRY = "com.github.mohammadraufzahed.omp-fest.festival";

export interface FestivalClaimData {
  festivalId?: string;
  festivalDir?: string;
  campRoot?: string;
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
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  return data;
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
  let latest: FestivalClaimData | undefined;
  for (const entry of entries) {
    const data = claimDataOf(entry);
    if (data && (data.festivalId !== undefined || data.festivalDir !== undefined)) {
      latest = data;
    }
  }
  if (!latest) {
    return undefined;
  }
  return tracker.restoreClaim(sessionId, latest.festivalId, latest.festivalDir);
}
