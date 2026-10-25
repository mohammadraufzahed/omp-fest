/**
 * Per-turn state digest: the ~4 lines injected into every turn so the model
 * always knows the live festival state and the non-negotiable rules — never
 * stale, survives compaction without a dedicated handler.
 */
import { basename } from "node:path";

import { summarizeProgress } from "../domain/progress.js";
import type { CampDetect } from "../ports.js";
import { claimedFestivalDir } from "./fest-resolve.js";
import { festivalOwner } from "./festival-ownership.js";
import { campRules, campRulesCount } from "./festival-rules.js";
import type { LoopTracker } from "./loop-tracker.js";

export interface DigestDeps {
  detect: CampDetect;
  tracker: LoopTracker;
}

const RULES =
  "fest loop: fest_next → supervise implementation → review/integrate → fest_task_complete → fest_commit. Never run fest/camp in the shell — use the fest_*/camp_* tools. Parent owns festival mutations; workers return bounded submissions without claiming the festival. Parallel candidates need dependency and file-overlap checks before bounded dispatch.";

const COLLABORATOR_RULES =
  "festival collaborator: use fest_team queue → claim one eligible task → implement only that task → submit files and verification evidence → read inbox. Do not run fest_next, task mutations/completion, workflow/gate changes, promotion, integration or commits; leave those to the coordinator. Use native path-bearing write/edit tools so locks cover writes only.";

/** Returns the digest text, or undefined outside a camp (no injection). sessionId scopes the unit/festival pick to that agent. */
export async function buildStateDigest(deps: DigestDeps, cwd: string, sessionId = "default"): Promise<string | undefined> {
  const location = await deps.detect.locate(cwd);
  if (!location.campRoot) {
    return undefined;
  }
  // A new omp session is intentionally unselected. Never fall back to the
  // camp-wide active festival because that can expose another agent's work.
  const festivalDir = await claimedFestivalDir(deps.tracker, deps.detect, sessionId, location.campRoot);
  const rulesCount = campRulesCount(await campRules(location.campRoot));
  const rulesLine = rulesCount > 0 ? `camp rules: ${rulesCount} (camp RULES.md applies to every festival — violations fail gates)` : undefined;
  if (!festivalDir) {
    const festivals = await deps.detect.listFestivals(location.campRoot);
    const names = festivals.map((f) => `${f.id} (${f.status})`).join(", ") || "none";
    return [
      `fest: camp=${location.campName ?? location.campRoot} — no active festival. festivals: ${names}.`,
      "This session is explicitly unselected. Use /fest select <id> to coordinate (transfer requires confirmation) or /fest join <id> to collaborate without transfer; start /fest idea → /fest plan for new work.",
      ...(rulesLine ? [rulesLine] : []),
      RULES,
    ].join("\n");
  }
  const [pending, events, owner] = await Promise.all([
    deps.detect.pendingTasks(festivalDir),
    deps.detect.readProgress(festivalDir),
    festivalOwner(festivalDir),
  ]);
  const progress = summarizeProgress(events);
  const unit = deps.tracker.openTaskPathFor(sessionId) ?? "none";
  const festivalId = location.festivalId ?? basename(festivalDir);
  const coordinator = owner?.sessionId === sessionId;
  const lines = [
    `fest: camp=${location.campName ?? "?"} festival=${festivalId} unit=${unit} pending=${pending.length} progress=${progress.completed}/${progress.total}`,
  ];
  if (rulesLine) lines.push(rulesLine);
  if (progress.gatePending) {
    lines.push(
      coordinator
        ? "GATE PENDING — gather the evidence it asks for and call fest_gate_submit; it asks the human directly (approve/reject dialog). Never approve or skip it yourself."
        : `GATE PENDING — coordinator session ${owner?.sessionId ?? "unavailable"} owns gate actions; continue only with a claimed implementation task.`,
    );
  }
  lines.push(coordinator ? RULES : COLLABORATOR_RULES);
  return lines.join("\n");
}
