/**
 * Shared festival-selector resolution: a user/agent-supplied selector matches
 * a festival id/name exactly first, then by unique substring. Ambiguous or
 * unknown selectors return their candidate lists — callers decide how to
 * surface them; nobody silently picks the wrong festival.
 */
import { stat } from "node:fs/promises";

import type { FestivalSummary } from "../domain/types.js";
import type { CampDetect } from "../ports.js";
import type { LoopTracker } from "./loop-tracker.js";

export type FestivalMatch =
  | { kind: "match"; festival: FestivalSummary }
  | { kind: "ambiguous"; matches: FestivalSummary[] }
  | { kind: "unknown"; festivals: FestivalSummary[] };

export function matchFestival(all: FestivalSummary[], selector: string): FestivalMatch {
  const exact = all.filter((f) => f.id === selector || f.name === selector);
  const matches =
    exact.length > 0
      ? exact
      : all.filter((f) => f.id.includes(selector) || f.name.includes(selector));
  if (matches.length > 1) {
    return { kind: "ambiguous", matches };
  }
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only) {
    return { kind: "match", festival: only };
  }
  return { kind: "unknown", festivals: all };
}

/**
 * Resolve the festival a session claimed via fest_* tools to a live dir.
 * The claim survives the camp-wide active pick changing underneath it; the
 * stored dir can itself go stale when `fest promote` renames
 * festivals/<status>/<id>, so a missing dir falls back to the id match and
 * the claim is re-pointed (or cleared when the festival is gone entirely).
 */
export async function claimedFestivalDir(
  tracker: LoopTracker,
  detect: CampDetect,
  sessionId: string,
  campRoot: string,
): Promise<string | undefined> {
  const id = tracker.claimedFestivalIdFor(sessionId);
  if (!id) {
    return undefined;
  }
  const dir = tracker.festivalFor(sessionId);
  if (dir?.startsWith(`${campRoot}/`) && (await stat(dir).catch(() => undefined))?.isDirectory()) {
    return dir;
  }
  const moved = (await detect.listFestivals(campRoot)).find((f) => f.id === id);
  if (moved) {
    tracker.moveClaimedFestival(sessionId, id, moved.path);
    return moved.path;
  }
  tracker.clearFestival(sessionId);
  return undefined;
}
