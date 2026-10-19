/**
 * Builds the compact orientation note injected into the session so the agent
 * starts already knowing the camp/festival/task context (~60 tokens).
 */
import type { CampLocation, FestivalProgress } from "./types.js";

export interface OrientationInput {
  location: CampLocation;
  festivalName?: string;
  status?: string;
  progress?: FestivalProgress;
  currentTask?: string;
  workingDir?: string;
  unfilledMarkers?: number;
  pendingGate?: string;
}

export function buildOrientationNote(input: OrientationInput): string {
  const { location } = input;
  if (location.kind === "outside") {
    return "";
  }
  const lines: string[] = [];
  lines.push(`Camp: ${location.campName ?? location.campRoot ?? "unknown"}`);
  if (location.festivalId) {
    const status = input.status ? ` — ${input.status}` : "";
    const pct =
      input.progress && input.progress.total > 0 ? `, ${input.progress.percent}%` : "";
    lines.push(`Festival: ${location.festivalId}${input.festivalName ? ` "${input.festivalName}"` : ""}${status}${pct}`);
  }
  if (input.currentTask) {
    lines.push(`Current: ${input.currentTask}`);
  }
  if (input.workingDir) {
    lines.push(`Working dir for tasks: ${input.workingDir}`);
  }
  if (input.unfilledMarkers && input.unfilledMarkers > 0) {
    lines.push(`Unfilled markers: ${input.unfilledMarkers} (fest next will refuse until filled)`);
  }
  if (input.pendingGate) {
    lines.push(`Pending gate: ${input.pendingGate} — requires human approval`);
  }
  lines.push("Use the fest_* tools for the festival loop; run `fest rules` before the first task.");
  return lines.join("\n");
}

export const PARALLEL_HINT =
  "Independent festival lanes: call fest_parallel to list pending tasks grouped " +
  "by sequence — spawn one subagent per sequence so tasks finish in parallel.";

export const RECOVERY_PLAYBOOK = [
  "fest_* tool recovery rules:",
  "- NEVER run `fest` or `camp` in the shell — the fest_*/camp_* tools handle cwd, --yes, and JSON",
  "- kind 'idle': at camp root with no festival — call camp_status to list festivals; for NEW work, start the plan workflow instead of writing your own todo list",
  "- kind 'blocked': fix the listed files/markers, then call fest_next again",
  "- kind 'gate_step': present evidence and STOP — do not approve; wait for the human",
  "- kind 'task': work in the returned working_dir, then fest_task_complete + fest_commit",
  "- never run bare `git commit` in a linked project — use fest_commit",
].join("\n");

export const PLAN_GUIDE = [
  "Guided planning protocol (the model interviews; the human approves):",
  "1. Ask the human: goal (one sentence), what 'done' looks like, scope/constraints,",
  "   phases they expect, risky parts needing extra attention.",
  "2. Write a STRUCTURE.md plan doc at <camp>/.ompfest/plans/<name>.STRUCTURE.md:",
  "",
  "# Festival Structure",
  "## Festival Goal",
  "[one-sentence goal]",
  "## Hierarchy",
  "- **Festival:** [name]",
  "  - **Phase 1:** [name] (implementation|planning|research|validation)",
  "    - Sequence 1: [name]        <- NOT bold, numbered",
  "      - Task 1: [title]         <- NOT bold, numbered",
  "      - Task 2: [title]",
  "  - **Phase 2:** [name] (type)",
  "    - Sequence 1: [name]",
  "      - Task 1: [title]",
  "",
  "(exact syntax: **Festival:**/**Phase N:** bold; 'Sequence N:'/'Task N:'",
  " plain text — verified: other shapes scaffold 0 sequences/tasks)",
  "",
  "3. Call fest_plan {name, plan:<abs path>} — scaffolds festivals/planning/<name>.",
  "4. Fill every unfilled marker (fest_markers lists them), run fest_validate,",
  "   then show the human the plan and WAIT for approval.",
  "5. After approval: fest_promote twice (planning -> ready -> active),",
  "   then fest_next begins execution.",
].join("\n");
