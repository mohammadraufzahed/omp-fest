# 🏕️⚡ omp-fest

**your AI agent + fest.build = an actual shipping machine 🚀**

`omp-fest` is an [oh-my-pi](https://github.com/oh-my-pi) extension that makes
your agent *natively fluent* in [fest.build](https://fest.build) — the Festival
methodology by Obedience Corp. No more "not inside a festival" errors. No more
forgotten commits. No more skipping the gate. Your agent runs the loop. You
just say yes. 😎

> 🧑‍💻 **the vibe:** the AI is the worker grinding through tasks —
> **you're the supervisor** who just approves the gates and takes the credit.

## 🎬 install in 10 seconds

```bash
omp plugin install github:mohammadraufzahed/omp-fest
```

that's it — omp handles the rest. want it only in one project?
`omp plugin install --scope project github:mohammadraufzahed/omp-fest`

needs the fest toolchain too (`npm i -g @obedience-corp/festival`) 🔥

<details>
<summary>hacking on it? install a local checkout instead</summary>

```bash
git clone https://github.com/mohammadraufzahed/omp-fest
omp install ./omp-fest   # symlinks it — edits go live instantly
```

</details>

## 🤖 what your agent gets (the superpowers)

- 🧭 **instant orientation** — session starts and your agent *already knows*
  the camp, the festival, and exactly which task it's on. ~60 tokens. no
  "let me explore the codebase" dance.
- 🎯 **typed `fest_next`** — returns `task | wf_step | gate_step | blocked |
  complete | idle`. your agent branches on `kind` like a pro, never parses
  prose like an amateur.
- 🔧 **self-healing on `blocked`** — gets the exact files + `[FILL:]` markers
  to fix and repairs itself instead of asking you what's wrong. *chef's kiss* 🤌
- 🧾 **evidence or it didn't happen** — `fest_task_complete` requires proof
  against the task's own Done-When checklist. no fake green checks, ever.
- 🔁 **loop discipline** — task → `fest commit` (auto `[camp-id:fest-id]` tag
  in every commit 🔖) → next task. it even gets nudged if it tries a raw
  `git commit` like a peasant.
- 📟 **live status line** — `🏕 camp ▸ festival ▸ task 22/30 ▸ ⛔ gate`
  always on screen, fed by the progress event log. zero prompts spent.
 - 🗺️ **fast native planning** — `/fest plan <goal>` inspects first, asks only blocking questions in at most two short rounds, then opens an omp-native proposal review. Approval is revision-locked; conflicts never cancel another plan.
 - 🧰 **repair-friendly plan inputs** — plan paths, project-relative inspection/verification paths, and common unstable IDs are normalized before validation. Failures return compact field-level diagnostics instead of dumping the fest CLI transcript.
 - 🖼️ **visual planning only for UI changes** — wireframes are generated only for explicit page, screen, layout, component, styling, or visual-interaction work. PDF/document/backend/API/error screenshots remain diagnostic evidence and are never converted into wireframes or iframes.
- 🎯 **session festival selection** — new omp sessions start unselected. `/fest select [festival]` claims coordinator ownership; `/fest join <festival>` joins an existing team without transfer. Only explicit selection/join binds the session.
- **native `/fest` flow** — planning, selection, approval, blockers, conflict handling, workers, evidence, login flows and release use omp tools/UI. `fest_plan` owns editable draft revisions and structured preview/scaffold; `fest_capabilities` reports actual host support.
 - 🌐 **the WHOLE CLI, not just the hits** — `fest_raw` / `camp_raw` run any subcommand (list, rules, chain, feedback, links, watch, jobs, idea claim/sync, ...) at the right dir, auto-inject `--yes` on task mutations, and return `{code, stdout, stderr}` typed. `/fest cmd` + `/fest camp` remain escape hatches.

### Session identity and authority

The selected main session is the festival supervisor. Ownership is per festival
and per omp session: `/fest select <festival>` explicitly claims coordinator
ownership; `/fest join <festival>` joins the team without transfer. New sessions
are unselected. A join never grants coordinator authority or expands the
supervisor's portfolio; a confirmed transfer is required to change owners.
After a confirmed transfer, the new owner’s supervisor view restores that
festival’s existing assignments by stable assignment ID, even when they were
created by the previous owner session. Transfer does not accept work, stop
workers, or relaunch runtimes; reconcile runtime state and review the work
explicitly.
Only the owning main session selects tasks, changes festival state, records final
integration, accepts worker reports, completes tasks, commits, submits gates,
and operates credential-backed browser flows. Subagents do scoped implementation
and return evidence or blockers through their native worker channel.

### The lifecycle path

Use one task loop: `fest_next` → implement the returned unit → `fest_task_complete`
with observed evidence → `fest_commit` → `fest_next`. Continue until `fest_next`
returns `complete`; for a gate, submit evidence and stop for human approval; for a
blocker, resolve it before continuing. `/fest next` and `/fest task done ...`
are native command alternatives for these steps, not a separate lifecycle.
`/fest workflow status|advance`, `/fest promote`, `/fest approve`, and
`/fest reject` expose lifecycle controls; mutation remains coordinator-only and
approval/rejection remains a human attestation. Planned checks are not results:
report only checks actually exercised.

### Supervisor execution

After human-authorized activation, the main agent immediately queries every
festival explicitly owned by this session and dispatches eligible work through
omp's native parallel/subagent tools in the same turn. The extension does not
launch an external runtime or run an autonomous background scheduler. The main
agent owns scope, integration, independent review, task completion, commits and
gate submission. `fest_capabilities.agentRole` identifies the current executor;
it does not indicate whether the main session can launch workers. Use the native
OMP agent tools exposed to the main session. Subagents cannot select or claim
supervisor work, change festival state, commit, approve gates, mutate plans, or
operate credential-backed browser flows; they return evidence and blockers
instead.

Festival and `.ompfest` document writes are explicitly path-checked but do not
take project-file reservations. The native write/edit tool remains responsible
for whether its target must already exist; an explicit target in these
non-project directories is not a missing lock target.

`xd://` device writes dispatch tools rather than modify project files, so they
bypass project-file reservations. Pathless filesystem writes remain blocked.

| Command | Behavior |
| --- | --- |
| `/fest portfolio` | Inspect owned festivals, fair task candidates, active/failed work, live write conflicts and advisory stale recovery candidates. No automatic release or relaunch. |
| `/fest portfolio limit N` | Set the camp-wide worker limit from 1 to 20 (default 20), only while owning at least one festival. |
| `/fest join <festival>` | Join an explicitly chosen festival team without changing its coordinator. |
| `/fest team [festival]` | Inspect shared participants, task claims, submissions and messages. |
| `/fest orphans` | Review incomplete scaffold transactions and legacy planning debris; rollback or quarantine only after confirmation, with quarantine reversible. |
| `/fest workers` | Show reported assignments separately from observed native lifecycle and review evidence. |
| `/fest dispatch` | Explicitly unpause portfolio dispatch for festivals owned by this session. Activation dispatches immediately by default. |
| `/fest pause` | Pause new portfolio assignments; existing workers continue and are not cancelled. |
| `/fest review [assignment-id]` | Independently inspect a submission, then accept with verification evidence or request changes. |
| `/fest resume` | Reconcile existing worker state without unpausing or relaunching an unfinished/unverified worker. |
| `/fest blockers` | Answer a retained worker question and hand the answer to the supervisor. |
| `/fest conflicts` | Inspect live per-file write locks; reclaim only after confirming the write process stopped. |
| `/fest finish` | Start the final integration/visual comparison pass; record actual results before the completion gate. |
| `/fest draft [draftId]` | Inspect and edit persisted planning fields, then request native preview approval. |
| `/fest release [patch\|minor\|major]` | Preview exact changed files, semantic version, branch and checks; request explicit authorization before versioning, verification, commit and push. |

`fest_supervisor` reports the dependency- and gate-eligible portfolio for owned
festivals. The main agent assigns exact candidates before starting native omp
workers. Selection is fair across owned festivals and respects file conflicts
and the durable camp-wide 20-worker maximum. Task priority metadata orders
eligible work within a festival; it does not bypass dependencies. Each
festival's task or planning failure stays local rather than cancelling unrelated
work.

The queue reports candidates; the main agent invokes omp's native subagent tools.
Only explicitly owned festivals enter its portfolio; joined-only festivals are
collaborator work through `fest_team`. Ownership is never inferred from an active
festival or transferred implicitly.

`/fest portfolio` displays owned-festival progress, candidates, active and failed
assignments, write locks, isolated errors and advisory stale work. The ledger is
private at `.ompfest/portfolio.json`. `/fest pause` blocks new reservations
portfolio-wide without cancelling current workers; `/fest resume` reconciles but
preserves pause; `/fest dispatch` explicitly unpauses. Reconciliation records
native observations and preserves uncertain assignments. A failed/exited
runtime is terminal and releases its task claim and capacity, but it must not be
relaunched; assign replacement work only after confirming the old runtime stopped.
Stale assignments are never automatically released or relaunched.

Cross-session team claims, submissions, reviews and messages persist under
`.ompfest/teams`. Native worker completion is not supervisor acceptance. If a
worker result is unavailable, a coordinator may use
`fest_supervisor(action:"accept_reviewed")` only after inspecting the shared
worktree, providing concrete verification evidence, confirming interactively that
no matching native worker is still running, and recording a separate
`coordinator-worktree` acceptance (not a fabricated worker report). Acceptance
does not complete the Festival task, commit changes or approve a gate.

Completion and supervisor acceptance are state transitions, not diagnostic probes.
Blocked transitions return a `reasonCode`, `missingRequirements`, and a structured
`nextAction`; resolve that prerequisite before retrying instead of rewording the
same evidence. Use normal acceptance for submitted worker results; reserve
`accept_reviewed` for unavailable worker results after native lifecycle recovery.
Independent review evaluates the implementation and existing evidence; it does
not inherently require rerunning verification. Repeat a check only for a concrete
coverage gap, contradictory result, or relevant change that invalidates its proof.

Exact-file locks are acquired only while native `write`/`edit` calls execute and
released when the call returns, including failed calls. Idle workers and
different files hold no lock; overlapping writes serialize at the write
boundary. `/fest conflicts` identifies live owners and paths. If a write process
stopped without returning, reclaim requires native confirmation and an exact
lock-token match; this releases the reservation but does not stop a worker.
Refresh the queue before retrying. Locks live in private per-checkout Git
metadata.

Shell file mutations are blocked except for one parsed install form:
`corepack pnpm install --filter <package>... --frozen-lockfile`, optionally
preceded by `cd <checkout-relative-path> &&`. The working directory must resolve
inside a real Git checkout; no extra command, pipeline, redirection, interpreter
or shell effect is accepted. The install holds a transient whole-checkout
reservation only while that bash invocation runs, conflicting with all native
writes and other installs; its result, including an error result, releases the
reservation. This is an omp tool-level guard, not an OS sandbox: external
processes can still modify files. Workers use path-bearing native write/edit
tools for other changes and return changed files, actual verification and
blockers through native results.
The supervisor independently reviews and verifies submissions; human gates
remain human-only.


### Reusable website login flows

`fest_flow` stores named, revisioned HTTPS-origin-bound browser procedures under
the camp's private `.ompfest/flows` directory. `/fest flows` lists, runs or removes
them; it also supports explicit keyring-credential deletion by opaque reference.
`fest_flow` supports create/read/update/list/delete/run/resume and confirmed
credential deletion. Subagents may only list or read; the main supervisor owns
flow mutation, execution and saved-credential deletion. Flow definitions contain
selectors and field metadata only, never usernames, passwords or OTP values.

Credentials and OTPs are requested through interactive omp native UI; secret and
OTP fields use masked terminal input. The browser receives these values directly;
they are not tool arguments or returned to the model. Optional password persistence
uses the operating system's `secret-tool` keyring provider. Without it, credentials
can be entered for a run but are not persisted. OTPs are requested only when the
configured challenge appears. CAPTCHA/MFA bypass is not supported.

Each run starts an isolated local Playwright browser context and closes it on
completion. Cookies and authenticated browser state are not persisted or reused.
An uncertain submission requires manual inspection and explicit confirmation
before retry; the extension never blindly repeats login or OTP submission.
`fest_capabilities` reports discovered browser/MCP tools and whether they are
active, but discovery is not execution permission. omp exposes no supported
secure secret-injection contract for MCP; login credentials are never sent
through MCP.

Before planning, pending plan artifacts with overlapping file boundaries are
reported as a conversational choice: sequence both plans, narrow one scope, or
use a separate worktree. The tool returns the options without opening a blocking
selection modal. Choosing sequential preserves both plans; neither is cancelled.

### Final integration, evidence and release

`/fest finish` queues an agent pass over approved acceptance, combined behavior,
layout, interactions, responsive sizes and console errors. The agent must actually
exercise the app, using Playwright MCP first when exposed, then record the six
checks with `fest_integration`. Referenced pages need comparison records with the
reference/capture paths, route, viewport, browser tool and concrete differences.
Unresolved differences cannot be marked verified. Missing browser access remains
untested with its limitation. Backend-only visual checks may be not applicable.

`fest_evidence` stores full reports and festival-relative attachments under private
`.ompfest/evidence` files. Model responses carry a short summary and artifact path,
not the entire log. Attachments have content hashes; paths outside the festival
are rejected. Integration reviews become stale when approved task/source evidence
changes; failed/stale reviews block gate submission.

`/fest release` requires an owning selected festival, settled workers and a current
verified final integration review. For a package at the Git checkout root, the
preview checks that the current branch has a configured upstream and shows the
semantic bump, exact changed files, and available `test`, `typecheck`, `lint`
and `build` scripts. It then requests explicit confirmation and a commit message;
approval is bound to the preview revision, so changed inputs require a fresh
preview. Execution updates npm version metadata, runs only those checks present in
the package scripts, stages the previewed files plus package metadata, commits
through fest and pushes normally without force. A failed check retains version
changes and stops before commit; a push failure preserves the local commit for
recovery. Monorepos must use root release scripts, not release from a nested
package. No unattended release is authorized by a plan.

### Persisted planning

`fest_plan` owns private `.draft.json` artifacts with `draftId` and `revision`.
Use `action:"create"`, then `read`/`update`/`list` on the same tool; stale
revisions reject concurrent overwrites. Missing runnable verification is an
explicit missing field, not invented test proof. `/fest draft` provides native
field editing and preview. Call `fest_plan` with `action:"preview"`, `draftId`
and `draftRevision` to consume persisted content without resending a nested spec.

Scaffolding renders festival/overview/phase/sequence/task documents from the
approved contract, retains independent user notes and constraints, and removes
obsolete template sections instead of substituting fake placeholder values.
Working directories are camp-relative, and hierarchy underscores remain literal.
The scaffold must validate before activation; real validation failures remain
failures and are not bypassed.

### Plan from an inspected repository

`/fest plan <goal>` starts by reading the target project's relevant implementation,
configuration, reusable components and test conventions without editing project code.
The agent records inspected paths and asks only about material choices that the
request and repository cannot answer. It does not ask you to restate known facts,
invent a questionnaire, or require you to design the phase hierarchy.

The plan is proportional: one phase, one sequence and an executable task are enough
for a simple change. Larger work uses real milestones and dependency-ordered tasks;
parallel lanes are optional and must be genuinely independent. Screenshots add the
visual extraction flow below; text-only plans do not need image artifacts.

The `StructuredPlan` contract is:

| Field | Contents |
| --- | --- |
| `goal` | The intended outcome. |
| `scope[]`, `exclusions[]` | Included work and explicit boundaries; preserve the human's constraints. |
| `acceptance[]` | `{id, description}` with observable behavior/output, not vague quality claims. |
| `questions[]` | `{question, blocking}`; resolve blocking questions before preview. |
| `inspection[]` | `{path, reason}` recording existing project-relative paths actually inspected. |
| `phases[]` | `{id, name, type, sequences}` for real milestones. |
| `sequences[]` | `{id, name, tasks}` for coherent work lanes within a phase. |
| `tasks[]` | `{id, title, description, dependsOn, implements, verifies, files, verification, priority?}`. |
| Task `dependsOn[]` | IDs of earlier tasks in phase/sequence/task order; no missing, forward or cyclic dependencies. |
| Task `priority?` | `urgent`, `high`, `normal` or `low`; defaults to `normal`. Use only when the request gives priority evidence. It orders eligible work within a festival; dependencies still gate dispatch. |
| Task `implements[]`, `verifies[]` | Acceptance IDs covered by implementation and verification respectively. |
| Task `files[]` | `{path, status: "existing" \| "proposed"}`; existing files must be confirmed, proposed files must not already exist. |
| Task `verification[]` | `{command, cwd, evidencePath?, expected}` specifying a runnable check, existing command evidence and observable expected result. |

IDs are unique across acceptance criteria, phases, sequences and tasks. Every
acceptance criterion needs both implementation and verification coverage; a task
may provide both. Verification tasks need concrete verification entries. Paths are
project-relative; verification `cwd` may be `"."`. An omitted `evidencePath` is
inferred from an npm/pnpm/yarn/bun package manifest or an explicit command target
such as `php -l path/to/check.php` or `pytest tests`. A supplied evidence path must
exist and substantiate the command: package scripts require `cwd/package.json`;
pytest/phpunit may name an existing test directory targeted by the command; direct
script commands may use the script file or its containing directory. A generic
directory does not substantiate a package script. Evidence is not a future result
log or proof that verification passed. Package-script commands must refer to scripts
declared in the package at that cwd. Actual result evidence is captured during
execution, not invented during planning. The contract needs nonempty
scope, inspection, acceptance and executable hierarchy; empty exclusions/questions
are valid. Phase names are normalized to parser-safe uppercase tokens, and naming
collisions are rejected. Sequence names must not end in `_planning`, `_research`,
`_requirements` or `_docs`, which the CLI excludes from quality gates.

Generate the plan through the tool, rather than writing parser-sensitive Markdown:

```ts
fest_plan({
  action: "preview",
  name: "feature",
  plan: "<absolute camp>/.ompfest/plans/feature.STRUCTURE.md",
  workingDir: "projects/<target>",
  spec, // StructuredPlan described above
  rules: "<agreed constraints>",
  // referencesDir: "<absolute camp>/.ompfest/plans/feature.references",
});
```
`workingDir` may also be an absolute path to a linked checkout outside the camp.
When the checkout is linked inside the camp, either its camp-relative link or its
absolute checkout path works. Inspection and task paths remain relative to that
working directory and must resolve inside the checkout.


Preview validates the contract, writes deterministic `STRUCTURE.md`, persists the
structured spec and returns a `planRevision` digest. The human sees one concise
approval preview: goal, scope/exclusions, inspection evidence, observable acceptance,
task/dependency outline, verification plan, nonblocking unknowns and any visual links.
The generated Markdown is an output, not a document to hand-patch.

After the human approves in the native review, the tool records an approval token
bound to that exact `planRevision`. Call `fest_plan` with `action: "scaffold"`, the
same `name`, `plan`, `workingDir`, `rules` and optional `referencesDir`, and
`approvedRevision: "<approved planRevision>"`. Scaffold requires both the persisted
approval token and a fresh digest match; edits, a new preview, or changed references
invalidate it. A revision string by itself is never proof of approval.

If a saved preview must be abandoned, a human can call
`fest_plan({action:"cancel", name, plan, approvedRevision})` for its current exact
revision. Human rejection during review records a rejected status automatically.
Both states preserve the Markdown, JSON and preview artifacts for inspection and
stop contributing to planning conflicts; cancellation cannot affect a newer or
different plan revision. Legacy previews without status remain active, and corrupt
status/artifact data fails closed rather than silently removing a conflict.

Compare the scaffold's phases, sequences, tasks, dependencies, acceptance coverage
and verification with the approved contract. Empty or mismatching output is a
failure: preserve the evidence and fix the cause, never silently shrink the plan or
autoactivate it. Fill remaining markers from known context, run `fest_validate`, and
promote only a matching, valid festival with human authorization to activate.
Authorization to activate does not approve later execution gates.

After activation, follow the single lifecycle path described above. Planned
verification commands are not passing results: report only exercised checks,
retain evidence, and make failed or untested checks explicit. Gate submission
always stops for the human; the agent never approves its own gate.

### Plan a page from a screenshot

Attach a screenshot to `/fest plan build this page`. The agent first inspects the
target project's component and style sources, then extracts the visible layout into
structured source-pixel coordinates before generating artifacts. It calls the model-callable
`fest_wireframe_create` tool with that typed extraction; it does not hand-assemble SVG.
The tool uses SVG.js with svgdom for headless Node generation and writes exactly
`wireframe.svg` and `PAGE.md` under the requested project-relative output directory.

The input contract carries source/display dimensions, direction, every visible node,
source-pixel geometry, parent hierarchy, open-ended semantic kinds and page-defined
categories. It does not restrict the UI to a small built-in component catalog:
`kind` describes the product component; optional `renderAs` selects a safe SVG
primitive. `PAGE.md` includes versioned front matter, categorized complete node
records, candidate repeated style values, confidence labels, reuse paths, measurements,
state coverage and acceptance checks. The SVG is a compact categorized overview;
`PAGE.md` is the full implementation handoff. Call once per page into its slug
directory. A plan can bundle up to 250 pages, bounded to 64 MiB total. The generator
validates IDs, bounds, colors, measurement references and project paths, redacts source
copy and sensitive values, and leaves unseen states explicitly unknown. Repeated
calls with the same structured input produce the same files.

For `text-bar`, geometry remains the measured text box in PAGE.md; the SVG keeps its width
but draws a thin, vertically centered bar at 20% of the box height, not a solid text-sized block.

Only source UI text is replaced by placeholder bars. The categorized annotation rail uses
readable SVG text for headings, labels, statuses and measurements.

Reuse audits may cite only existing relative paths confirmed in the target project. For
no match, cite existing files/directories actually inspected and mark `no_match`; never
provide a guessed candidate path as evidence.
Missing audit paths do not block wireframe output: the tool returns them as
`auditWarnings`, excludes them from verified evidence, and marks entries without any
verified path as `unverified` in PAGE.md and the SVG.

Audit entries use exactly `component`, `status`, `sourcePaths`, and `notes`.
`notes` must be nonempty and at most 300 characters; `sourcePaths` must contain
nonempty relative inspected paths. Audit input failures return all affected
field paths and diagnostic codes together, distinguishing missing paths, missing
notes, and overlong notes. Do not add `paths`/`inspectedPaths` aliases or search
installed binaries to repair an audit; fix only the fields named in diagnostics.

### Browser verification

Planning, task handoffs (`/fest next` and `fest_next`), and supervisor dispatch
instruct agents to discover exposed browser tools once per session and attempt
Playwright MCP first for browser-relevant verification. Reuse the browser session.
If those tools are absent or fail to connect/start, record the limitation and use
another exposed omp browser integration. No MCP server is installed automatically.

UI verification exercises the target route and requested interactions, recording
tool, route, viewport, actions, screenshots and observed results. Screenshot
matching uses the reference viewport. UI-driven PDF exports require inspecting
the exported PDF as well. Application failures must be fixed, not hidden by
switching tools; unavailable browser verification remains explicitly untested.
Backend-only work does not need a browser. This is an agent execution policy,
not a claim that the extension itself launches or verifies a browser.

SVG.js and svgdom are runtime dependencies for this headless renderer. The tool does
not perform image recognition itself: the calling model extracts the screenshot and
inspects the target project, then passes those findings through the stable schema.
Text-only `/fest plan` uses the structured flow above without visual fields. The approved [scheduling-dialog SVG](scheduling-dialog-wireframe.svg)
shows the expected detail; its screen content is an example, not a template to copy.
For plans that implement the reference in the app, record the target route/component,
source crop and original viewport, existing assets/fonts/components, requested controls
and interactions, and any responsive sizes to support. The image defines the visible
design: preserve its non-sensitive copy, hierarchy, wrapping, proportions and crops;
do not redesign, invent unseen sections or backend behavior, or silently substitute
missing assets. Placeholder bars in the generated wireframe are annotation/privacy
conventions, not a direction to replace real interface text.

Implementation verification requires a running capture at the same route and original
viewport after fonts and assets load. Compare to the reference, fix layout/proportions
before typography, spacing, color and asset differences, then render again. Check
requested sizes and controls. Mark visual evidence `verified` only with actual rendered
comparison proof; otherwise record `untested` and the limitation.


```text
<camp>/.ompfest/plans/feature.STRUCTURE.md
<camp>/.ompfest/plans/feature.references/pages/results/PAGE.md
<camp>/.ompfest/plans/feature.references/pages/results/wireframe.svg
```

`STRUCTURE.md` is generated from the same structured contract used for text-only
plans; the agent does not hand-assemble its hierarchy. Preview reports the planned
hierarchy, and scaffolding must match the approved contract.

After approval, the agent calls `fest_plan` with `action: "scaffold"`,
`approvedRevision` and `referencesDir` pointing to the reviewed `.references`
directory (omit it for text-only plans). The extension copies only the two
reviewed files per page into `<festival>/references/pages/<slug>/`, rejecting
symlinks, raw screenshots and active/external SVG content. The agent then adds
`Visual reference: references/pages/results/PAGE.md` to each relevant task's
document, with component-specific Done-When checks. Each page has a `## Components`
list of stable IDs (matching the SVG `id` attributes), a `## States` table with
`Viewport | State | Status | Expected` columns (desktop, mobile, initial,
loading, empty and error; `observed`/`agreed`/`unknown`/`n/a`), and unique
`## Acceptance checks` such as `- [AC-01] Search filters results in RTL`.
Every check must be linked to a task with a Done-When item like
`- [ ] Acceptance: results/AC-01 — Search filters results in RTL`. Unknown
behaviors stay `unknown` until discussed; duplicate, missing, or unlinked IDs
fail validation. Agreed visual constraints
such as RTL order go in the existing `rules` argument, so the existing
`FESTIVAL_RULES.md` and gate checklist carry them forward.

Before scaffolding, the agent calls `fest_plan` with `referenceAction: "preview"`
and `referencesDir` to write a local `feature.preview.html` beside the plan.
It shows the validated SVG beside escaped page notes, never the original image.
The same result suggests project-local reuse candidates from route, layout,
component, form, table, token and test file names for the agent to inspect;
it never edits project files. The preview is not copied into the Festival and
does not introduce a separate approval step.

`fest_next` returns linked page paths, notes and wireframe paths with the task,
plus exact acceptance checks, required evidence fields and recorded-evidence
validity. `fest_supervisor` assignment contracts include only references linked
to that task. `fest_validate` checks reference coverage and completed-task
verification. For visual tasks, `fest_task_complete` accepts one `visualEvidence`
item per acceptance ID:
`{page:"results", check:"AC-01", status:"verified", proof:"search test log",
route:"/results", viewport:"1280x800", state:"initial"}`. Use `untested`
with a reason if the interaction cannot be exercised; never invent browser
proof. `failed` checks block completion. Evidence is saved in
`references/verification.json`, bound to the reference revision and the approved
plan's declared source-file contents. Omitting `visualEvidence` reuses valid
recorded evidence without rewriting it; an explicit empty array does not.
Legacy records without a source fingerprint and records invalidated by reference
or declared-source changes require fresh evidence. Undeclared project files are
not covered by this fingerprint; keep the approved file list complete and
reverify when other relevant inputs change. `fest_gate_submit` can take new
evidence (including `task` for already completed tasks) to reverify checks.
Missing, failed, or stale evidence blocks submission; untested checks are
explicitly shown to the human. `/fest approve` also enforces these checks;
in headless mode it requires `--allow-untested` to attest to untested items.
Human approval remains the gate. Verification covers structure, behavior,
control presence, order, direction and states, not pixel-perfect matching.

For an approved reference change, preview the candidate with `fest_plan`
`referenceAction: "preview"` and `festival: "<festival path>"`. The response
lists changed/added/removed pages, affected acceptance IDs, affected tasks and
whether they are done. Apply only after review with `referenceAction: "revise"`,
`festival`, `referencesDir`, `baseRevision` and `proposalRevision` from the
preview. If either digest changed meanwhile, preview again. Completed tasks
stay completed, but old verification becomes stale and requires targeted
reverification or follow-up work before gate submission. A page still linked
to a task cannot be removed. Text-only plans need none of these visual fields.
These SVGs are detailed, annotated design specifications for implementation—not
production UI code and never embedded copies of the source screenshot.

## 🫵 what YOU get (the supervisor seat)

- 🛑 **gates actually stop** — `fest_gate_submit` freezes and waits for YOU.
  `/fest approve` / `/fest reject` run the real attestation. the model can
  *never* approve itself. your gates, your call. period. 🔒
- 🚄 **supervised parallel work** — `fest_supervisor` queues dependency-ready
  tasks across explicitly owned festivals, reserves exact task claims and
  coordinates omp-native workers within the camp-wide limit. The coordinator
  owns integration, review, completion, commits and human gates.
- 🧘 **zero babysitting** — outside a camp? tools return `idle` and shut up.
  no fest installed? everything still works. graceful like a swan 🦢
- ⚙️ **`.ompfest.json`** — per-project knobs: gate notification channels
  (UI / camp-notify / webhook 📡), autonomy ceiling. you set the rules,
  the agent plays by them.
- ✨ **it FLOATS** — `/fest`, `/fest show`, `/fest doctor` render in a
  floating overlay card (esc/q close, j/k/↑↓ scroll) instead of dumping
  walls of text. `/fest settings` opens an interactive picker — arrow to a
  key, hit enter, it toggles or lets you pick the value. `/fest approve`
  asks with a real confirm dialog, `/fest reject` prompts for the reason.
  ambiguous festival names? picker. a tiny ⛺ progress widget hovers above
  your editor while a festival runs (turn it off: `/fest settings
  progressWidget`). headless/RPC mode gets plain text, zero drama.

## 🔌 bonus: `fest omp`

`bin/fest-omp` is a PATH plugin — fest auto-discovers any `fest-*` binary,
so drop it on PATH and boom 💥 `fest omp status` / `fest omp next` work
*inside* the fest CLI itself.

## 🏗️ under the hood

hexagonal (ports & adapters), zero runtime deps, strict TypeScript,
`strictTypeChecked` ESLint, Vitest coverage. clean enough to read for fun:

```
index.ts            🧠 composition root — wires everything onto omp
src/domain/         🎯 pure logic — next-unit classifier, progress, config
src/application/    🔁 orientSession + LoopTracker (the loop nudge engine)
src/ports.ts        📜 interfaces — ExecRunner, FestCli, CampCli, CampDetect...
src/adapters/cli/   ⌨️  fest-cli (auto --yes --json), camp-cli, node-exec
src/adapters/fs/    👀 camp detection + progress_events.jsonl watcher
src/adapters/omp/   🛠️  tools, commands+completers, notifications
tests/              ✅ vitest, one file per module
```

## 💻 dev it yourself

```bash
npm install
npm install -g @obedience-corp/festival  # needed by the session-start smoke test
npm test           # automated tests ✅
npm run typecheck  # strict tsc 🧊
npm run lint       # strictTypeChecked eslint 🧹
```

---

built for people who'd rather ship festivals than run commands 🏕️🎪
