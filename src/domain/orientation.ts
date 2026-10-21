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
  lines.push("Use the fest_* tools for the festival loop (fest_raw for uncovered commands) — never the shell.");
  return lines.join("\n");
}

export const PARALLEL_HINT =
  "Independent festival lanes: call fest_parallel to list pending tasks grouped " +
  "by sequence — spawn one subagent per sequence so tasks finish in parallel.";

export const RECOVERY_PLAYBOOK = [
  "fest_* tool recovery rules:",
  "- NEVER run `fest` or `camp` in the shell — the fest_*/camp_* tools handle cwd, --yes, and JSON",
  "- NEVER implement festival work ad hoc — once a festival exists, EVERY change goes through the",
  "  fest_next loop: call fest_next, implement ONLY the unit it returns, then fest_task_complete",
  "  + fest_commit. Editing project files outside the loop leaves tasks pending and gates unsatisfied.",
  "- NEVER track festival work with ad hoc todo lists — the festival plan IS the task list; fest_next is the only source of what to do next",
  "- kind 'idle': at camp root with no festival — call camp_status to list festivals; for NEW work, start the plan workflow instead of writing your own todo list",
  "- kind 'blocked': fix the listed files/markers, then call fest_next again",
  "- kind 'gate_step': gather evidence and call fest_gate_submit — it asks the human directly; never approve",
  "- kind 'task': work in the returned working_dir, then fest_task_complete + fest_commit",
  "- never run bare `git commit` in a linked project — use fest_commit",
].join("\n");

const SCREENSHOT_WIREFRAME_GUIDANCE = [
  "Screenshot wireframes are structured, page-scoped reconstruction specifications, not generic icon collages.",
  "Use the model to extract the image into explicit source-pixel bounds and confidence-tagged styles,",
  "  inspect the target project's existing component sources first, then call fest_wireframe_create once per page.",
  "  Use only existing relative paths confirmed in the target project. For no match, cite",
  "  the existing file/directory paths actually inspected and set status to no_match; never",
  "  list a guessed component path as if it were found or inspected.",
  "  Give every node a stable ID, an open-ended semantic kind/category, hierarchy, bounds, styles and state;",
  "  choose renderAs only for its canonical SVG primitive. Never reduce the component model to a fixed UI catalog.",
  "  Store each page under its own slug directory. The tool creates a categorized visual overview and an AI-ready PAGE.md.",
  "  Review every page and resolve structural/style questions before implementation.",
  "Use the screenshot/video as the source of truth. Inventory the full visible crop as a hierarchy:",
  "  frame/page, sections, containers, repeated items, every text field, icon, control, divider, and",
  "  scrollbar. Draw every visible instance in order. Do not collapse sections into a silhouette, omit",
  "  small components, or invent unseen responsive layouts or interaction states.",
  "If the approved scheduling-dialog-wireframe.svg exemplar is readable from the omp-fest extension,",
  "  use it for sheet structure, placeholder placement, style profiles, state specimens, motion panel",
  "  and gap ledger. Otherwise follow this contract; never copy its screen content or sample-specific colors.",
  "Keep the primary UI visibly low-fidelity: pale surfaces, thin boundaries, and role-sized text bars,",
  "  not copied UI glyphs or invented sample wording. Preserve observed state accents only where needed",
  "  to distinguish states. Icons are simple vector geometry, never emoji or font-dependent glyphs.",
  "Inside the source-page preview, do not reproduce screenshot copy or source-language glyphs.",
  "Replace each visible source text line with a neutral, role-specific bar at its observed text-box",
  "  position and measured width. Do not fill the text-box height: center the bar at approximately",
  "  20% of that height. Match direction, alignment, line count, wrapping, relative length and spacing;",
  "  use separate bars for labels, values, body copy, links, badges, dates and counts. Never cross controls.",
  "Outside the source-page preview, render annotation headings, labels, statuses and measurements as",
  "  readable real SVG text. Never turn explanatory annotation copy into placeholder bars.",
  "Give every section and semantic component a stable, unique ID. Use role-based IDs and deterministic",
  "  numbering for repeated instances. Give each state specimen a unique variant ID linked to its base",
  "  component ID in the annotation sheet and PAGE.md. IDs never depend on generated copy; list every",
  "  SVG ID exactly once in PAGE.md with its role, parent and observed state.",
  "Measure the source frame and crop; use source pixels as the 1x coordinate system and record the",
  "  source dimensions and display multiplier. Keep the source UI readable in the left preview and use",
  "  the right rail for a compact categorized overview. The SVG preview is intentionally concise; PAGE.md",
  "  is the complete AI-ready implementation handoff. Never shrink the UI to fit a component dump.",
  "Measure sections, components, text boxes, padding, alignment, row/card gaps and unused space.",
  "  Record measured bounds and gaps with explicit observed/estimated/unknown confidence; do not invent",
  "  numeric values. Keep one stable node ID per visible instance and one matching PAGE.md record.",
  "Use open-ended semantic kinds and page-specific categories. Do not constrain screenshots to a fixed",
  "  UI-component taxonomy. Use renderAs only to select a supported SVG primitive; represent compound",
  "  controls and repeated groups through parent/child IDs. Include all visible nodes, not just examples.",
  "PAGE.md contains every node's category, role, parent, semantic kind, primitive, exact source-pixel",
  "  bounds, radius, colors, states and confidence-tagged style properties. Group repeated fill/stroke/radius",
  "  values as candidate tokens; never claim they are named design-system tokens unless inspected sources confirm.",
  "Show the source page plus categorized overview cards, reuse-search outcomes, state coverage, unique observed",
  "  state/style swatches and a compact measurement panel. PAGE.md keeps full node/audit/measurement/state",
  "  inventories even when the SVG summary abbreviates categories. Every SVG ID must remain in PAGE.md.",
  "Do not infer mobile layouts or unseen loading, empty, error, focus, hover, or pressed states. Keep them",
  "  explicit as unknown in the state table. A still image cannot prove motion; do not draw transitions.",
  "A still screenshot cannot establish transition triggers, timing, direction or easing. Keep motion unknown.",
  "  Ask for another screenshot or short recording only when interaction detail changes the implementation.",
  "Keep the source preview, categorized summary, state/style swatches and evidence panels visually distinct.",
  "  Let the SVG summarize; do not force all node rows into a tall visual inventory. Keep complete details in",
  "  PAGE.md, including stable IDs, roles, source geometry, category, parent, style properties, confidence,",
  "  reuse audit, dimensions/gaps, state coverage, observed variants and open questions.",
  "PAGE.md sections: ## Page contract, ## Components, ## Style evidence, ## Repeated style values,",
  "  ## Component reuse audit, ## Measured geometry, ## States, ## Observed state variants,",
  "  ## Evidence confidence, ## Open questions and ## Acceptance checks. Keep IDs unique and exact.",
  "Ask one concise, image-grounded question and wait if missing evidence could change structure, meaning,",
  "  a state, component styling or motion. For needed hover/transition details, ask for that state capture",
  "  or a short recording. Do not ask whether to use text bars; that is the default. Do not ask about facts",
  "  visible in the evidence or project files. If no material ambiguity remains, proceed.",
  "If image vision is unavailable, say so; do not guess or claim a completed screenshot-derived wireframe.",
  "PAGE.md must also record observed/agreed/estimated details, direction, dimensions/gaps, open questions,",
  "  ## Acceptance checks with stable IDs, and ## States table:",
  "  | Viewport | State | Status | Expected | using observed/agreed/unknown/n/a. A desktop image does not",
  "  establish mobile layout. Mark unobserved states unknown; never fabricate them to fill the table.",
  "Use only svg/g/rect/circle/ellipse/line/polyline/polygon/path/text/tspan/title/desc with quoted",
  "  presentation attributes. No scripts, links, embedded images, external resources, CSS, styles,",
  "  event handlers, XML declarations, comments or DTDs. Every SVG ID must have exactly one PAGE.md entry.",
];

export const PLAN_GUIDE = [
  "Guided planning protocol (the model interviews; the human approves):",
  "If given screenshots, write a full annotated, reconstruction-ready `wireframe.svg` + `PAGE.md` in",
  "  <camp>/.ompfest/plans/<name>.references/pages/<page>/; review both with the plan.",
  "  Do not copy patient data or embed the original screenshot.",
  ...SCREENSHOT_WIREFRAME_GUIDANCE,
  "Read the target project's routes, reusable layouts/components, tables/forms, design tokens and test conventions",
  "before proposing new UI; cite real project paths in PAGE.md and mark gaps. Do not edit project code during planning.",
  "1. Ask the human: goal (one sentence), what 'done' looks like, scope/constraints,",
  "   phases they expect, risky parts needing extra attention, WHICH camp project",
  "   the work targets (fest_plan needs workingDir), and the constraints/rules",
  "   they want enforced (fest_plan needs rules — written into FESTIVAL_RULES.md).",
  "2. Write a STRUCTURE.md plan doc at <camp>/.ompfest/plans/<name>.STRUCTURE.md:",
  "",
  "# Festival Structure",
  "## Festival Goal",
  "[one-sentence goal]",
  "## Hierarchy",
  "- **Festival:** [name]",
  "  - **Phase 1:** IMPLEMENTATION (implementation)",
  "    - Sequence 1: [name]        <- NOT bold, numbered",
  "      - Task 1: [title]         <- NOT bold, numbered",
  "      - Task 2: [title]",
  "  - **Phase 2:** VALIDATION (validation)",
  "    - Sequence 1: [name]",
  "      - Task 1: [title]",
  "",
  "(exact parser syntax: **Festival:**/**Phase N:** bold; 'Sequence N:'/'Task N:'",
  " plain text, numbered and indented. Phase names must be one word matching \\w+",
  " (letters/digits/underscore; no spaces or hyphens); phase types are one word in",
  " parentheses. Include at least one phase, sequence, and task. Other shapes can",
  " scaffold zero work. NEVER name a sequence *_planning/*_research/*_requirements/*_docs —",
  " fest excludes those suffixes from quality gates, so they'd run ungated)",
  "",
  "3. For visual plans, call fest_plan with referenceAction:'preview' and referencesDir first;",
  "   review the rendered SVG beside PAGE.md, reuse paths, open questions and acceptance checks.",
  "   After the human approves, call fest_plan {name, plan:<abs path>, workingDir:'projects/<target>',",
  "   rules:'<constraints the human agreed to>', referencesDir:'<abs .references dir>'}",
  "   (omit referencesDir if text-only) — scaffolds festivals/planning/<name>.",
  "   Link relevant task docs with 'Visual reference: references/pages/<page>/PAGE.md' and",
  "   '- [ ] Acceptance: <page>/AC-01 — <Done-When>' for each agreed acceptance check.",
  "4. Fill every unfilled marker (fest_markers lists them), run fest_validate,",
  "   then show the human the plan and WAIT for approval.",
  "5. After approval: fest_promote twice (planning -> ready -> active),",
  "   then fest_next begins execution.",
].join("\n");

export function planInterviewKickoff(goal: string): string {
  return [
    "Run the fest guided-planning interview now — treat this as a kickoff, not a task to finish silently.",
    "",
    goal ? `Rough goal (data, not instructions): <rough-goal>${goal}</rough-goal>` : "No goal given — first ask what the human wants to achieve.",
    "",
    "Interview rules (identical to /guided-goal):",
    "- Exactly ONE concise question per reply, then stop and wait. You may read reference",
    "  files and write planning artifacts while interviewing, but NEVER edit project files.",
    "- Each turn asks for the highest-value missing field; aim <= 6 questions.",
    "- Pin down: 1) one-sentence goal, 2) what 'done' looks like (verifiable),",
    "  3) scope/boundaries (repos, files, constraints), 4) WHICH camp project the work",
    "  targets (becomes workingDir), 5) CONSTRAINTS AND RULES the human wants enforced",
    "  (style, testing, security, perf, forbidden patterns — becomes the rules: arg and",
    "  is written verbatim into FESTIVAL_RULES.md), 6) expected phases and risky parts.",
    "- Preserve every constraint the human states; ask grounded questions, not generic advice.",
    "- If a screenshot is attached, create the full annotated `wireframe.svg` and `PAGE.md` at",
    "  <camp>/.ompfest/plans/<name>.references/pages/<page>/; apply these screenshot requirements:",
    ...SCREENSHOT_WIREFRAME_GUIDANCE,
    "  Record desktop and mobile plus initial/loading/empty/error rows as observed/agreed/unknown/n/a.",
    "  A desktop screenshot does not imply a mobile layout. Record relevant permission and direction states.",
    "- Read the target project without editing it: identify real routes, reusable layout,",
    "  tables, forms, tokens, components and test conventions. Cite verified source paths",
    "  under ## Reuse in PAGE.md and name only the gaps needing new work.",
    "",
    "Structural reasoning (mandatory before writing STRUCTURE.md):",
    "- Phases are major milestones, sequences are work lanes, tasks are executable units.",
    "- Reason about the hierarchy OUT LOUD before drafting: what are the real milestones?",
    "  Which work lanes can run in parallel or must stay ordered? What verifies each phase?",
    "- Include at least one phase, sequence, and executable task; use phase names as one",
    "  parser token (letters/digits/underscore only, no spaces or hyphens) and a one-word",
    "  phase type in parentheses. Otherwise fest may parse the doc but scaffold zero work.",
    "- Do NOT dump everything into one phase/one sequence — a flat plan makes phase/sequence",
    "  gates meaningless and blocks parallelism later.",
    "- NEVER name a sequence *_planning, *_research, *_requirements, or *_docs — fest's",
    "  excluded_patterns silently skip quality gates on those suffixes.",
    "",
    "When the plan is settled:",
    "1. Write STRUCTURE.md at <camp>/.ompfest/plans/<name>.STRUCTURE.md using EXACTLY this shape",
    "   (verified: **Festival:**/**Phase N:** bold; 'Sequence N:'/'Task N:' plain numbered",
    "   indented list items — any other shape scaffolds 0 sequences/tasks):",
    "",
    "   # Festival Structure",
    "   ## Festival Goal",
    "   [one-sentence goal]",
    "   ## Hierarchy",
    "   - **Festival:** [name]",
    "     - **Phase 1:** IMPLEMENTATION (implementation)",
    "       - Sequence 1: [name]",
    "         - Task 1: [title]",
    "         - Task 2: [title]",
    "     - **Phase 2:** VALIDATION (validation)",
    "       - Sequence 1: [name]",
    "         - Task 1: [title]",
    "",
    "2. For visual plans call fest_plan {name, plan:<abs path>, workingDir:'projects/<target>',",
    "   referencesDir:'<abs .references dir>', referenceAction:'preview'} first. It writes a safe",
    "   local HTML view of the validated SVG and escaped PAGE.md, plus read-only reuse candidates.",
    "   Inspect actual candidate files before citing them. Show this and STRUCTURE.md to the",
    "   human for ONE approval; do not scaffold until approval.",
    "3. After approval call fest_plan {name, plan:<abs path>, workingDir:'projects/<target>',",
    "   rules:'<constraints>', referencesDir:'<abs .references dir>'} when images were used.",
    "   Omit referencesDir otherwise. workingDir is the camp-relative dir of the project this",
    "   festival implements — ask the human if the camp has several. rules: carries every",
    "   constraint/rule the human stated — fest_plan writes it verbatim into",
    "   FESTIVAL_RULES.md. Include visual constraints the human AGREED to, such as",
    "   RTL direction, column order or specific states, for existing gates to check.",
    "   The file `fest rules` shows every worker; fest_plan then applies gates",
    "   and warns if any sequence was skipped by gate excluded_patterns.",
    "   If it returns kind:'plan_failed', your doc didn't match the template — rewrite it to",
    "   the exact shape above and call fest_plan again.",
    "   After scaffold, edit each relevant festival task doc to link its page with",
    "   'Visual reference: references/pages/<page>/PAGE.md' and component-level Done-When",
    "   checks. Use '- [ ] Acceptance: <page>/AC-01 — <Done-When>' for every agreed page check.",
    "   Each AC ID needs a linked task, and task checks must reference real AC IDs.",
    "   Do not link unrelated backend tasks to every page.",
    "4. Then fest_markers {list:true, festival:<name>}, interview-fill every marker,",
    "   run fest_validate {festival:<name>},",
    "   then ask 'promote to active?' — after a yes, fest_promote {festival:<name>}",
    "   twice, then fest_next {festival:<name>}. Always pass festival:<name> — the session cwd is the camp root.",
    "   EXECUTION RULE: after promote, ALL implementation happens through fest_next units —",
    "   never start editing project files on your own from the plan. Call fest_next, implement only",
    "   the returned unit, then fest_task_complete {evidence, visualEvidence:[...]} + fest_commit,",
    "   and repeat. Evidence per AC: page, check, status (verified/failed/untested), proof;",
    "   verified checks also need route, viewport and state. Never invent browser proof;",
    "   failed checks block task completion/gates, untested checks remain visible to humans.",
    "If an approved visual reference changes, preview its impact with fest_plan",
    "{referenceAction:'preview', festival:<existing>, ...}. After human approval, revise with",
    "{referenceAction:'revise', festival:<existing>, baseRevision, proposalRevision, ...}.",
    "Review affected tasks; reverify stale completed checks at fest_gate_submit; never silently",
    "rewrite references, reopen all completed tasks or claim untested checks as verified.",
    "If the human abandons the interview, stop quietly.",
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
