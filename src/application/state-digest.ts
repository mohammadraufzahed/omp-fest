/**
 * Per-turn state digest: the ~4 lines injected into every turn so the model
 * always knows the live festival state and the non-negotiable rules — never
 * stale, survives compaction without a dedicated handler.
 */
import { basename } from "node:path";

import { summarizeProgress } from "../domain/progress.js";
import type { CampDetect } from "../ports.js";
import { claimedFestivalDir } from "./fest-resolve.js";
import type { LoopTracker } from "./loop-tracker.js";

export interface DigestDeps {
  detect: CampDetect;
  tracker: LoopTracker;
}

const RULES =
  "fest loop: fest_next → implement → fest_task_complete → fest_commit. Never run fest/camp in the shell — use the fest_*/camp_* tools (fest_raw for uncovered subcommands). Edits to project files need a unit open from fest_next. Parallel: group pending tasks by sequence → one subagent per lane.";

/** Returns the digest text, or undefined outside a camp (no injection). sessionId scopes the unit/festival pick to that agent. */
export async function buildStateDigest(deps: DigestDeps, cwd: string, sessionId = "default"): Promise<string | undefined> {
  const location = await deps.detect.locate(cwd);
  if (!location.campRoot) {
    return undefined;
  }
  // Resolution: cwd inside a festival > the festival this session claimed via
  // fest_* tools > the camp-wide active pick. Without the middle step two
  // agents on different festivals both see whichever festival sorts first.
  const festivalDir =
    location.festivalDir ??
    (await claimedFestivalDir(deps.tracker, deps.detect, sessionId, location.campRoot)) ??
    (await deps.detect.activeFestival(location.campRoot));
  if (!festivalDir) {
    const festivals = await deps.detect.listFestivals(location.campRoot);
    const names = festivals.map((f) => `${f.id} (${f.status})`).join(", ") || "none";
    return [
      `fest: camp=${location.campName ?? location.campRoot} — no active festival. festivals: ${names}.`,
      "Pick one (festival arg / /fest next <id>) or start the planning flow (/fest idea → /fest plan).",
      RULES,
    ].join("\n");
  }
  const [pending, events] = await Promise.all([
    deps.detect.pendingTasks(festivalDir),
    deps.detect.readProgress(festivalDir),
  ]);
  const progress = summarizeProgress(events);
  const unit = deps.tracker.openTaskPathFor(sessionId) ?? "none";
  const festivalId = location.festivalId ?? basename(festivalDir);
  const lines = [
    `fest: camp=${location.campName ?? "?"} festival=${festivalId} unit=${unit} pending=${pending.length} progress=${progress.completed}/${progress.total}`,
  ];
  if (progress.gatePending) {
    lines.push(
      "GATE PENDING — gather the evidence it asks for and STOP for human approval; never approve or skip it yourself.",
    );
  }
  lines.push(RULES);
  return lines.join("\n");
}
