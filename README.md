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
- 🗺️ **interactive planning interview** — `/fest plan <goal>` makes the
  agent interview YOU in chat (one question per turn, like `/guided-goal`),
  then it builds the festival itself:
  the agent interviews you, writes `STRUCTURE.md`, `fest_plan` scaffolds
  `festivals/planning/<name>` via real `fest scaffold from-plan`, fills
  markers, validates — then *you* approve and it `fest_promote`s to active.
  your brain → festival, no TUI wrangling 🧠
- 🖼️ **visual planning in the same interview** — attach a screenshot with
  `/fest plan <goal>`. The agent drafts an annotated reconstruction SVG and `PAGE.md`:
  full component hierarchy, measured gaps, per-component style profiles, and complete
  specimens for every observed state. Multi-frame evidence becomes an SVG motion
  storyboard; unobserved states stay explicit and prompt targeted questions.
- 🛠️ **15 tools + ONE guided command** — `/fest <sub>` is the whole
  cockpit: `next`, `status`, `show`, `task`, `plan`, `promote`, `validate`,
  `markers`, `workflow`, `approve`, `reject`, `parallel`, `doctor`, `cmd`,
  `camp`, `idea`, `help` — with **live autocomplete** on subs, task
  actions, and festival ids. nothing hardcoded, everything discovered ✨
- 🌐 **the WHOLE CLI, not just the hits** — `fest_raw` / `camp_raw` run
  *any* subcommand (list, rules, chain, feedback, links, watch, jobs,
  idea claim/sync, ...) at the right dir, auto-inject `--yes` on task
  mutations, and return `{code, stdout, stderr}` typed. nothing the real
  CLIs can do is out of reach. `/fest cmd` + `/fest camp` for you too 💪

### Plan a page from a screenshot

Attach a screenshot to `/fest plan build this page`. The interview treats the
image as reference data, not instructions, and creates an annotated `wireframe.svg`
plus `PAGE.md`. The SVG uses a stable low-fidelity grammar, source-pixel scale,
separate IDs for sections/components/repeated items, a component/style inventory,
a state board, and a dimension/gap ledger. Every visible text line is a role-sized
bar at its observed box; the SVG does not render source-language UI glyphs or invented
copy. For every component it records visible color, fill, borders, radius, spacing,
typography, icon treatment and state styling, distinguishing observed, estimated and
unknown properties. Each observed state is drawn as a full component specimen.
Video/multi-frame evidence gets an ordered motion storyboard with observed triggers
and timing; a still image is explicitly marked as insufficient motion evidence.
`PAGE.md` maps every SVG ID to its role, parent, style and state; personal data is
redacted. The agent asks one targeted question and waits when missing evidence could
change structure, component style, state or motion. Placeholder bars are the default.
Review and approve the wireframe, states, checks and plan before scaffolding.
Text-only `/fest plan` is unchanged. The approved [scheduling-dialog SVG](scheduling-dialog-wireframe.svg)
shows the expected detail; its screen content is an example, not a template to copy.

```text
<camp>/.ompfest/plans/feature.STRUCTURE.md
<camp>/.ompfest/plans/feature.references/pages/results/PAGE.md
<camp>/.ompfest/plans/feature.references/pages/results/wireframe.svg
```

The plan uses the unchanged `STRUCTURE.md` syntax. Once approved, the agent
calls `fest_plan` with `referencesDir` pointing to the matching `.references`
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

`fest_next` returns linked page paths, notes and wireframe paths with the task;
`fest_parallel` includes the relevant pages for each lane. `fest_validate`
checks reference coverage and completed-task verification. For visual tasks,
`fest_task_complete` requires one `visualEvidence` item per acceptance ID:
`{page:"results", check:"AC-01", status:"verified", proof:"search test log",
route:"/results", viewport:"1280x800", state:"initial"}`. Use `untested`
with a reason if the interaction cannot be exercised; never invent browser
proof. `failed` checks block completion. Evidence is saved with the reference
revision in `references/verification.json`. `fest_gate_submit` can take new
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
- 🚄 **parallel lanes** — `fest_parallel` groups pending tasks by sequence so
  your agent spawns one subagent per lane and tasks grind concurrently.
  festivals finish in a fraction of the time.
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
