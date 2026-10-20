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
  `/fest plan <goal>`. The agent drafts a labeled SVG wireframe and `PAGE.md`
  beside the structure plan, asks about behavior the image cannot show, and
  presents both for the same approval. No new command or approval lifecycle.
  This requires the selected model to support images; otherwise the agent
  should tell you it cannot see the screenshot rather than guessing.
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

Attach a screenshot to `/fest plan build this page`. The interview uses the
image as reference data, not as instructions. The agent should omit personal
data from the draft, ask only about behavior the picture cannot establish,
and review the wireframe, states, acceptance checks and structure plan with
you before scaffolding. Text-only `/fest plan` still works as before.

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
document, with component-specific Done-When checks. Agreed visual constraints
such as RTL order go in the existing `rules` argument, so the existing
`FESTIVAL_RULES.md` and gate checklist carry them forward.

`fest_next` returns linked page paths, notes and wireframe paths with the task;
`fest_parallel` includes the relevant pages for each lane. `fest_validate`
checks referenced files and unlinked pages; promotion and gate submission are
blocked while visual references are broken. SVGs are intentionally simple
wireframes, not pixel-perfect screenshot reconstructions or generated UI code.

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
