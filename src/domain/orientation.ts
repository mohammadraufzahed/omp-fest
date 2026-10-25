/**
 * Builds the compact orientation note injected into the session so the agent
 * starts already knowing the camp/festival/task context (~60 tokens).
 */
import type { CampLocation, FestivalProgress } from "./types.js";
import { SUPERVISOR_POLICY } from "../application/supervisor.js";

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

/** Agent policy: tools are exposed by the host, not installed or guessed by this extension. */
export const BROWSER_VERIFICATION_POLICY = [
  "Browser verification: prefer-playwright-mcp.",
  "For browser-relevant UI changes or UI-driven exports, discover exposed browser tools once per session and attempt Playwright MCP first when available; reuse the browser session.",
  "If its tools are absent or startup/connection fails, record the concrete limitation and use another exposed omp browser integration. Never install or assume an MCP server.",
  "Exercise the target route and requested interactions; capture rendered evidence. For screenshot matching use the reference viewport. For PDF exports inspect the actual exported PDF, not only a browser screenshot.",
  "Record tool, route, viewport, actions and observed result in verification proof. Fix application failures; never switch tools to hide them. With no usable browser, mark browser checks untested and state why.",
  "Backend-only work needs no browser. During planning record the verification approach, not fabricated results.",
].join(" ");

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
  lines.push("Use the fest_* tools for the festival loop (fest_raw for uncovered commands); create plans and scaffold only through fest_plan, never raw scaffold or the shell.");
  return lines.join("\n");
}

export const PARALLEL_HINT =
  "Parallel festival work: the coordinator uses fest_parallel/fest_supervisor with native omp subagents; independent omp sessions explicitly join via /fest join and coordinate exact-task claims, questions, and reports through fest_team. Do not cancel another plan or duplicate a claimed task. Same-project file locks exist only during native writes, not during idle task time.";

export const RECOVERY_PLAYBOOK = [
  "fest_* tool recovery rules:",
  "- NEVER run `fest` or `camp` in the shell — the fest_*/camp_* tools handle cwd, --yes, and JSON",
  "- NEVER implement festival work ad hoc — once a festival exists, EVERY change goes through its",
  "  assignment flow. The coordinator uses fest_next → fest_task_complete → fest_commit. A",
  "  collaborator first joins with /fest join, then uses fest_team queue/claim, implements only that",
  "  exact assignment, and submits actual evidence; collaborators never complete tasks or commit.",
  "  After every coordinator fest_commit, immediately call fest_next and continue until kind 'complete';",
  "  do not stop after one task. Stop only at a human gate or a real blocker.",
  "- NEVER track festival work with ad hoc todo lists — the festival plan IS the task list; use fest_next or the shared fest_team queue as appropriate",
  "- kind 'idle': no festival is selected in this session — call camp_status to list festivals; explicitly /fest select as coordinator or /fest join as collaborator; for NEW work, start planning",
  "- kind 'blocked': fix the listed files/markers, then refresh the relevant task queue",
  "- kind 'gate_step': coordinator gathers evidence and calls fest_gate_submit — it asks the human directly; never approve",
  "- task eligibility comes from fest_supervisor for the coordinator or fest_team for joined sessions; overlapping tasks may proceed because write locks cover only native write/edit calls. If a lock is live, refresh after it clears; reclaim only an orphaned lock after confirming the writer stopped.",
  "- never run bare `git commit` in a linked project — use fest_commit from the coordinator session",


].join("\n");
export const PLAN_GUIDE = [
  "Guided planning protocol (inspect first; ask only material unanswered questions; the human approves):",
  "1. Read the target repository before interviewing or drafting. Resolve the camp project/workingDir",
  "   from context and available files; inspect relevant implementation, reuse candidates, configuration",
  "   and test conventions. Record actual inspected paths and why they matter. Do not edit project code.",
  "   Ask only when repository evidence and the request cannot settle a material scope, behavior, risk",
  "   or tradeoff. Ask ONE concise grounded question per reply, then wait. Do not re-ask supplied facts,",
  "   demand expected phases, or manufacture questions to complete a questionnaire.",
  "2. Use the least structure the work needs: capture small work as a camp workitem/intent, compare",
  "   uncertain approaches in a design, use a standalone workflow for known repeatable steps, and",
  "   use a festival for multi-step execution with handoffs and review. Do not manufacture phases.",
  "   Native phase types have different structures: planning/ingest/research use workflows; review",
  "   and non_coding_action may be freeform; implementation uses cohesive sequences and tasks.",
  "   Hybrid phases may combine a workflow with sequences. Discover custom types with fest_authoring.",
  "   Each phase needs an objective, concrete deliverables and observable completionCriteria.",
  "   Decompose by cohesive outcomes and dependencies, not a fixed task count. Honor an explicitly",
  "   configured planning.maxAuthoredTasksPerPhase policy; native gate tasks are appended separately.",
  "   For implementation, acceptance IDs need implementation and verification coverage, with verification",
  "   after the work it verifies and explicit dependencies across sequences. Avoid vague 'works' checks.",
  "3. Build a StructuredPlan with goal, scope, exclusions, acceptance, questions, inspection and phases.",
  "   Phases carry id/name/type/objective/deliverables/completionCriteria and sequences or a workflow.",
  "   Tasks carry id/title/description/dependsOn/implements/verifies/files and verification entries.",
  "   Verification kinds are command, browser, manual or research. Command provenance is optional",
  "   provenancePath (not execution evidence); noncommand checks describe a concrete procedure.",
  "   Preserve any priority the human/request provides. Use urgent/high/normal/low only when the request",
  "   provides evidence for urgency; otherwise set priority to normal. Never invent urgency. Priority",
  "   is advisory dispatch order only; it does not change task dependencies, acceptance, task order or verification.",
  "   IDs in phase/sequence/task order; implements/verifies name acceptance IDs. Record only existing",
  "   paths actually inspected in inspection. Task file paths are relative to workingDir;",
  "   existing means confirmed in the repository, proposed means an intentional new file, not a finding.",
  "   proposed paths must not already exist. Command verification describes a runnable command,",
  "   project-relative cwd ('.' allowed), optional provenancePath and observable expected result.",
  "   Provenance supports the command definition: package.json for a package script, or the explicit",
  "   checked source/script target. It is not a future result log and does not prove execution.",
  "   Browser/manual/research checks specify a concrete procedure and expected observation instead",
  "   of inventing an npm command. Capture actual command output or observations only during execution.",
  "   If requirements remain uncertain, choose a planning/research workflow and retain open questions.",
  "   Such approval authorizes discovery only, not implementation. Obtain a new approved execution",
  "   contract before implementing. Requirements-ready plans may scaffold implementation directly.",
  "   Phase names are normalized to parser-safe uppercase tokens; avoid normalized naming collisions.",
  "   NEVER name a sequence *_planning, *_research, *_requirements or *_docs: fest excludes those",
  "   suffixes from quality gates. Use implementation lanes that remain gated.",
  "4. Image attachments are evidence by default. For an explicit UI-visual plan, finalize the festival slug",
  "   before generating any wireframes. Use outputDirectory .ompfest/plans/<name>.references/pages/<page>",
  "   and set the draft referencesDir to exactly .ompfest/plans/<same-name>.references.",
  "   If the plan slug changes, regenerate the bundle under the new slug; do not reuse a different plan's directory.",
  "5. Call fest_plan {action:'preview', name, spec:<StructuredPlan>,",
  "   plan:'<absolute camp>/.ompfest/plans/<name>.STRUCTURE.md', workingDir:'projects/<target>',",
  "   rules:'<every agreed constraint>'}. Add referencesDir only for an explicit UI-visual plan.",
  "   The tool validates semantics, writes deterministic STRUCTURE.md, persists the contract and returns planRevision.",
  "   Do not hand-write or patch generated STRUCTURE.md. Fix spec and preview again if invalid.",
  "   Show ONE concise approval preview: goal, scope/exclusions, inspected evidence, acceptance,",
  "   task/dependency outline, verification plan, unresolved nonblocking questions and visual links.",
  "   Ask the human to approve this revision; do not repeat the full plan or scaffold before approval.",
  "6. After human approval, call fest_plan {action:'scaffold', name, plan:<same absolute path>,",
  "   approvedRevision:<approved planRevision>}. Omit spec and referencesDir: the approved artifact",
  "   stores the target project, rules and visual references, and scaffolding reloads those exact inputs.",
  "   A changed spec, generated plan or saved reference needs a fresh preview and human approval;",
  "   never bypass a revision mismatch or substitute handwritten Markdown.",
  "   Compare scaffolded phases/sequences/tasks, dependencies, acceptance coverage and verification",
  "   with the approved contract. Empty or mismatching output is a failure, not a festival to activate.",
  "   Preserve the failure evidence and fix the cause; do not auto-promote or silently reduce scope.",
  "   Link each visual task to 'Visual reference: references/pages/<page>/PAGE.md' and",
  "   '- [ ] Acceptance: <page>/AC-01 — <Done-When>' for each agreed page acceptance check.",
  "   Every page AC needs a linked task; reference real IDs and do not link unrelated tasks to all pages.",
  "7. Use fest_markers to fill remaining markers from known context; ask only genuinely missing material",
  "   questions. Run fest_validate and inspect the scaffold comparison before promotion.",
  "   Human plan approval is not permission to ignore validation failures or approve execution gates.",
  "   Promote only a matching, nonempty, valid scaffold with human authorization to activate:",
  "   fest_promote twice (planning -> ready -> active), then fest_next. If activation was not authorized",
  "   in the approval, ask for it without repeating the whole planning interview.",
  "   Always pass festival:<name> because the session cwd may be the camp root.",
  "8. EXECUTION RULE: ALL implementation goes through fest_next. Implement ONLY the returned unit",
  "   in its working_dir, then fest_task_complete {evidence, visualEvidence:[...]} + fest_commit; repeat.",
  "   After each successful commit, immediately call fest_next and continue task-by-task until it returns",
  "   kind 'complete'. Never stop after one commit; gates and blockers are the only pauses.",
  "   Report only checks actually exercised. Failed and untested verification must remain explicit;",
  "   never turn a planned command, missing evidence or an inferred result into a passed check.",
  BROWSER_VERIFICATION_POLICY,
  "   Visual evidence per AC: page, check, status (verified/failed/untested), proof; verified checks",
  "   also need route, viewport and state. Never invent browser proof. Failed checks block completion",
  "   and gates; untested checks remain visible to humans.",
  "   At a gate, gather evidence and call fest_gate_submit, then STOP for the human; never self-approve.",
  "If an approved visual reference changes, preview its impact with fest_plan",
  "{referenceAction:'preview', festival:<existing>, ...}. After human approval, revise with",
  "{referenceAction:'revise', festival:<existing>, baseRevision, proposalRevision, ...}.",
  "Review affected tasks and reverify stale completed checks at fest_gate_submit; never silently",
  "rewrite references, reopen all completed tasks or claim untested checks as verified.",
].join("\n");

export function planInterviewKickoff(goal: string, visualGuidance?: string): string {
  return [
    "Start a fast omp-native planning interview. Inspect the repository first.",
    "",
    goal ? `Rough goal: <rough-goal>${goal}</rough-goal>` : "No goal supplied: determine the desired outcome from the current omp context.",
    ...(visualGuidance ? ["", visualGuidance] : []),
    "",
    "Ask only blocking questions. Batch related choices in one prompt and ask at most two rounds.",
    "Use repository evidence to resolve everything else. Do not implement before approval.",
    SUPERVISOR_POLICY,
    BROWSER_VERIFICATION_POLICY,
    "Choose proportionate structure before drafting: camp workitem for small work; design for unresolved architecture; standalone workflow for recurring steps; festival for multi-step execution.",
    "Create/update/read/list drafts through fest_plan. Preview the persisted draftRevision without resending nested JSON. Native planning/research workflows may preserve unresolved questions; no implementation is authorized by discovery approval.",
    "Read the persisted draft and verify phase modes, hierarchy, acceptance, procedures, provenance and target project before requesting approval. Repair only the named diagnostics; never replace behavioral checks with syntax checks merely to satisfy validation.",
    "When the human approves, scaffold with the exact planRevision. Omit spec and referencesDir; the approved artifact preserves both and scaffolding revalidates the saved references.",
    "When the native review returns approval:'approved', call fest_plan action:'scaffold' with its planRevision.",
    "New planning is independent of selected festivals: create a new name and continue even when another session owns an existing festival. Only existing-festival work (tasks, promotion, or reference revisions) requires ownership; never cancel or reset another plan.",
  ].join("\n");
}

export const IDEA_INTERVIEW = [
  "Run a quick idea-capture interview now.",
  "Ask ONE question per reply, max 2: what the idea is and what outcome it should produce.",
  "Then call camp_idea_add {text: '<one-line title — short body>'} and confirm in one sentence.",
  "If the human already gave a complete idea in one go, capture it without asking.",
].join("\n");

export function markerInterviewKickoff(listing: string): string {
  return [
    "Fill the unfilled fest markers by interviewing the human — one marker question per reply.",
    "For each marker: ask for the value (explain what it controls in one line), then edit the file.",
    "When every marker is filled, run fest_validate {festival:<name>} and report the score.",
    "",
    "Unfilled markers:",
    listing,
  ].join("\n");
}
