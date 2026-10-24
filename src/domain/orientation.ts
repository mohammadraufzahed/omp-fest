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
  lines.push("Use the fest_* tools for the festival loop (fest_raw for uncovered commands) — never the shell.");
  return lines.join("\n");
}

export const PARALLEL_HINT =
  "Independent festival lanes: call fest_parallel for candidate sequences. Check dependencies and file overlap before bounded dispatch; workers return submissions to the supervisor, never run their own festival loop.";

export const RECOVERY_PLAYBOOK = [
  "fest_* tool recovery rules:",
  "- NEVER run `fest` or `camp` in the shell — the fest_*/camp_* tools handle cwd, --yes, and JSON",
  "- NEVER implement festival work ad hoc — once a festival exists, EVERY change goes through the",
  "  fest_next loop: call fest_next, implement ONLY the unit it returns, then fest_task_complete",
  "  + fest_commit. Editing project files outside the loop leaves tasks pending and gates unsatisfied.",
  "  After every successful fest_commit, immediately call fest_next and continue until kind 'complete';",
  "  do not stop after one task. Stop only at a human gate or a real blocker.",
  "- NEVER track festival work with ad hoc todo lists — the festival plan IS the task list; fest_next is the only source of what to do next",
  "- kind 'idle': at camp root with no festival — call camp_status to list festivals; for NEW work, start the plan workflow instead of writing your own todo list",
  "- kind 'blocked': fix the listed files/markers, then call fest_next again",
  "- kind 'gate_step': gather evidence and call fest_gate_submit — it asks the human directly; never approve",
  "- kind 'task': work in the returned working_dir only after fest_supervisor queue confirms the current task is eligible; if the queue reports a project reservation conflict, stop before edits/dispatch and do NOT mark the task completed or commit. Retry only after the reservation clears.",
  "- never run bare `git commit` in a linked project — use fest_commit",
].join("\n");


export const PLAN_GUIDE = [
  "Guided planning protocol (inspect first; ask only material unanswered questions; the human approves):",
  "1. Read the target repository before interviewing or drafting. Resolve the camp project/workingDir",
  "   from context and available files; inspect relevant implementation, reuse candidates, configuration",
  "   and test conventions. Record actual inspected paths and why they matter. Do not edit project code.",
  "   Ask only when repository evidence and the request cannot settle a material scope, behavior, risk",
  "   or tradeoff. Ask ONE concise grounded question per reply, then wait. Do not re-ask supplied facts,",
  "   demand expected phases, or manufacture questions to complete a questionnaire.",
  "2. Scale the plan to the work: one phase and one sequence are valid for a simple change.",
  "   Add phases only for real milestones and sequences only for distinct work lanes; parallelize only",
  "   genuinely independent work. Complex changes need explicit dependencies, boundaries and risks,",
  "   not arbitrary phase counts. Preserve every human constraint in scope/exclusions and rules.",
  "   Define observable acceptance criteria: what behavior/output proves done, under which conditions.",
  "   Every acceptance ID needs implementation and verification coverage; avoid vague 'works' checks.",
  "3. Build a StructuredPlan, not handwritten parser-specific Markdown:",
  "   {goal, scope:[], exclusions:[], acceptance:[{id,description}],",
  "    questions:[{question,blocking}], inspection:[{path,reason}],",
  "    phases:[{id,name,type,sequences:[{id,name,tasks:[{id,title,description,",
  "      dependsOn:[], implements:[], verifies:[], files:[{path,status:'existing'|'proposed'}],",
  "      verification:[{command,cwd,evidencePath?,expected}]}]}]}]}.",
  "   Use globally unique IDs across acceptance/phases/sequences/tasks. dependsOn names earlier task",
  "   IDs in phase/sequence/task order; implements/verifies name acceptance IDs. Record only existing",
  "   paths actually inspected in inspection. Task file paths are relative to workingDir;",
  "   existing means confirmed in the repository, proposed means an intentional new file, not a finding.",
  "   proposed paths must not already exist. Verification describes a runnable command, project-relative",
  "   cwd ('.' is allowed), optional evidencePath and observable expected result. If omitted, evidencePath",
  "   is inferred only from a declared package runner manifest or an explicit command target. Use package.json",
  "   for npm/pnpm/yarn/bun scripts; pytest/phpunit may use the existing directory named by the command.",
  "   Otherwise provide an existing project-relative file. Evidence is not a future result log.",
  "   Verification tasks need verification entries; package-script commands must reference declared",
  "   scripts at that cwd. Capture actual result evidence later during execution.",
  "   Planned verification is NOT proof that a check ran or passed. Mark limitations honestly.",
  "   Resolve blocking questions before preview; retain nonblocking unknowns explicitly. Scope, inspection,",
  "   acceptance and the executable hierarchy must be nonempty; exclusions/questions may be empty.",
  "   Phase names are normalized to parser-safe uppercase tokens; avoid normalized naming collisions.",
  "   NEVER name a sequence *_planning, *_research, *_requirements or *_docs: fest excludes those",
  "   suffixes from quality gates. Use implementation lanes that remain gated.",
  "4. Image attachments are evidence by default. Create wireframes and referencesDir only when",
  "   the planning request is explicitly a UI-visual change (page, screen, layout, component or styling).",
  "   PDF, document, backend, API and error/diagnostic images are not visual references and must not",
  "   be converted into wireframes or iframes. Omit referencesDir for those plans.",
  "5. Call fest_plan {action:'preview', name, spec:<StructuredPlan>,",
  "   plan:'<absolute camp>/.ompfest/plans/<name>.STRUCTURE.md', workingDir:'projects/<target>',",
  "   rules:'<every agreed constraint>'}. Add referencesDir only for an explicit UI-visual plan.",
  "   The tool validates semantics, writes deterministic STRUCTURE.md, persists the contract and returns planRevision.",
  "   Do not hand-write or patch generated STRUCTURE.md. Fix spec and preview again if invalid.",
  "   Show ONE concise approval preview: goal, scope/exclusions, inspected evidence, acceptance,",
  "   task/dependency outline, verification plan, unresolved nonblocking questions and visual links.",
  "   Ask the human to approve this revision; do not repeat the full plan or scaffold before approval.",
  "6. After human approval, call fest_plan {action:'scaffold', name, plan:<same absolute path>,",
  "   workingDir:<same project>, rules:<same constraints>, referencesDir:<same directory if visual>,",
  "   approvedRevision:<approved planRevision>}. It uses the persisted spec and checks that the",
  "   approved plan is unchanged. A changed spec, generated plan or approval inputs needs a fresh",
  "   preview and human approval; never bypass a revision mismatch or substitute handwritten Markdown.",
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
    "Create/update/read/list drafts through fest_plan; ask only for its missing blocking fields. Preview the persisted revision with fest_plan {action:'preview',draftId,draftRevision} instead of resending nested JSON. No festival is created before explicit plan approval.",
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
