/**
 * Shared festival-selector resolution: a user/agent-supplied selector matches
 * a festival id/name exactly first, then by unique substring. Ambiguous or
 * unknown selectors return their candidate lists — callers decide how to
 * surface them; nobody silently picks the wrong festival.
 */
import { stat } from "node:fs/promises";

import type { FestivalSummary } from "../domain/types.js";
import type { LoopTracker } from "./loop-tracker.js";
import type { CampDetect } from "../ports.js";
import type { FestivalOwner, OwnershipResult } from "./festival-ownership.js";

export type FestivalResolutionSource = "explicit-selector" | "session-claim";


export type FestivalMatch =
  | { kind: "match"; festival: FestivalSummary }
  | { kind: "ambiguous"; matches: FestivalSummary[] }
  | { kind: "unknown"; festivals: FestivalSummary[] };


export type FestivalResolution =
  | { kind: "ambiguous"; source: "explicit-selector"; selector: string; matches: FestivalSummary[] }
  | { kind: "unknown"; source: "explicit-selector"; selector: string; festivals: FestivalSummary[] }
  | { kind: "unselected"; source: "session-claim" }
  | { kind: "pending-creation"; source: "explicit-selector" | "session-claim"; festival: FestivalSummary }
  | {
      kind: "resolved";
      source: "explicit-selector" | "session-claim";
      festival: FestivalSummary;
      ownership: "owner" | "collaborator" | "missing-owner" | "changed" | "busy";
      owner?: FestivalOwner;
    };

export interface FestivalResolutionInput {
  selector?: string;
  /** Festival already claimed by this session; never inferred from a camp-wide active pick. */
  claimedFestival?: FestivalSummary;
  sessionId: string;
  pendingCreationIds?: readonly string[];
  ownershipAttempt?: OwnershipResult;
}

/** Resolve one explicit selector or this session's claim and attach role/repair metadata. */
export function resolveFestivalSelection(
  all: FestivalSummary[],
  input: FestivalResolutionInput,
): FestivalResolution {
  const explicit = input.selector !== undefined;
  const source = explicit ? "explicit-selector" as const : "session-claim" as const;
  let festival: FestivalSummary | undefined;
  if (input.selector !== undefined) {
    const selector = input.selector;
    const match = matchFestival(all, selector);
    if (match.kind === "ambiguous") {
      return { kind: "ambiguous", source: "explicit-selector", selector, matches: match.matches };
    }
    if (match.kind === "unknown") {
      return { kind: "unknown", source: "explicit-selector", selector, festivals: match.festivals };
    }
    festival = match.festival;
  } else {
    festival = input.claimedFestival;
    if (!festival) return { kind: "unselected", source: "session-claim" };
  }
  if (input.pendingCreationIds?.includes(festival.id)) {
    return { kind: "pending-creation", source, festival };
  }
  const attempt = input.ownershipAttempt;
  if (attempt?.kind === "busy") return { kind: "resolved", source, festival, ownership: "busy", ...(attempt.owner ? { owner: attempt.owner } : {}) };
  if (attempt?.kind === "changed") return { kind: "resolved", source, festival, ownership: "changed", ...(attempt.owner ? { owner: attempt.owner } : {}) };
  const owner = attempt?.kind === "claimed" || attempt?.kind === "owned"
    ? attempt.owner
    : undefined;
  if (!owner) return { kind: "resolved", source, festival, ownership: "missing-owner" };
  return {
    kind: "resolved",
    source,
    festival,
    ownership: owner.sessionId === input.sessionId ? "owner" : "collaborator",
    owner,
  };
}

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
