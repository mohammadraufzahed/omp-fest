/**
 * Startup reconcile: clears state a crashed session could leave behind —
 * stale plan locks/tmp debris, expired plan previews, stale scaffold
 * journals, dead-pid write reservations, and over-age quarantine entries.
 * Everything is idempotent and best-effort; failures are collected, never thrown.
 */
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { clearStaleCreationJournal, classifyCreationOrphan, listFestivalCreationOrphans, listQuarantinedFestivals } from "./festival-creation.js";
import { expireStalePlanPreviews } from "./plan-artifacts.js";
import { sweepPlanDraftDebris } from "./plan-drafts.js";
import { sweepProjectReservations } from "./project-conflicts.js";

const QUARANTINE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

export interface ReconcileSummary {
  planDebris: number;
  expiredPreviews: number;
  clearedJournals: number;
  sweptReservations: number;
  collectedQuarantine: number;
  errors: string[];
  describe(): string;
  readonly total: number;
}

export async function reconcileCamp(campRoot: string, projectDirs: (campRoot: string) => Promise<string[]>): Promise<ReconcileSummary> {
  const counts = { planDebris: 0, expiredPreviews: 0, clearedJournals: 0, sweptReservations: 0, collectedQuarantine: 0 };
  const errors: string[] = [];
  const attempt = async (label: string, run: () => Promise<number>): Promise<void> => {
    try {
      const done = await run();
      if (label === "planDebris") counts.planDebris += done;
      else if (label === "expiredPreviews") counts.expiredPreviews += done;
      else if (label === "clearedJournals") counts.clearedJournals += done;
      else if (label === "sweptReservations") counts.sweptReservations += done;
      else counts.collectedQuarantine += done;
    } catch (error) {
      errors.push(`${label}: ${String(error)}`);
    }
  };

  await attempt("planDebris", async () => (await sweepPlanDraftDebris(campRoot)).length);
  await attempt("expiredPreviews", async () => (await expireStalePlanPreviews(campRoot)).length);
  await attempt("clearedJournals", async () => {
    let cleared = 0;
    for (const orphan of await listFestivalCreationOrphans(campRoot)) {
      if (classifyCreationOrphan(orphan) !== "stale") continue;
      await clearStaleCreationJournal(campRoot, orphan);
      cleared += 1;
    }
    return cleared;
  });
  await attempt("sweptReservations", async () => {
    let swept = 0;
    for (const project of await projectDirs(campRoot)) {
      swept += await sweepProjectReservations(project);
    }
    return swept;
  });
  await attempt("collectedQuarantine", async () => {
    const camp = await realpath(campRoot);
    const orphans = join(camp, ".ompfest", "orphans");
    const quarantined = new Set((await listQuarantinedFestivals(campRoot)).map((item) => item.id));
    let collected = 0;
    for (const id of await readdir(orphans).catch(() => [] as string[])) {
      const target = join(orphans, id);
      const info = await lstat(target).catch(() => undefined);
      if (!info?.isDirectory() || !quarantined.has(id)) continue;
      if (Date.now() - info.mtimeMs <= QUARANTINE_MAX_AGE_MS) continue;
      await rm(target, { recursive: true, force: true });
      collected += 1;
    }
    return collected;
  });

  const total = counts.planDebris + counts.expiredPreviews + counts.clearedJournals + counts.sweptReservations + counts.collectedQuarantine;
  return {
    ...counts,
    errors,
    total,
    describe() {
      const parts = [
        counts.planDebris ? `${counts.planDebris} plan file(s)` : "",
        counts.expiredPreviews ? `${counts.expiredPreviews} preview(s) expired` : "",
        counts.clearedJournals ? `${counts.clearedJournals} stale scaffold journal(s)` : "",
        counts.sweptReservations ? `${counts.sweptReservations} dead write reservation(s)` : "",
        counts.collectedQuarantine ? `${counts.collectedQuarantine} aged quarantine entr${counts.collectedQuarantine === 1 ? "y" : "ies"}` : "",
      ].filter(Boolean);
      return parts.length ? `cleared ${parts.join(", ")}` : "nothing stale";
    },
  };
}
