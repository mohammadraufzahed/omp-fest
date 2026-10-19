/**
 * Shared festival-selector resolution: a user/agent-supplied selector matches
 * a festival id/name exactly first, then by unique substring. Ambiguous or
 * unknown selectors return their candidate lists — callers decide how to
 * surface them; nobody silently picks the wrong festival.
 */
import type { FestivalSummary } from "../domain/types.js";

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
