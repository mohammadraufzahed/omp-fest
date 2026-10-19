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
git submodule add https://github.com/mohammadraufzahed/omp-fest .omp/extensions/omp-fest
```

needs the fest toolchain (`npm i -g @obedience-corp/festival`) — that's it 🔥

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
- 🛠️ **10 tools + 10 slash commands** — `/fest-next`, `/fest-task`,
  `/fest-approve`, `/fest-doctor`, `/camp-idea`... all with **live
  autocomplete** pulled from `fest list` and `camp idea list`. nothing
  hardcoded, everything discovered ✨

## 🫵 what YOU get (the supervisor seat)

- 🛑 **gates actually stop** — `fest_gate_submit` freezes and waits for YOU.
  `/fest-approve` / `/fest-reject` run the real attestation. the model can
  *never* approve itself. your gates, your call. period. 🔒
- 🧘 **zero babysitting** — outside a camp? tools return `idle` and shut up.
  no fest installed? everything still works. graceful like a swan 🦢
- ⚙️ **`.ompfest.json`** — per-project knobs: gate notification channels
  (UI / camp-notify / webhook 📡), autonomy ceiling. you set the rules,
  the agent plays by them.

## 🔌 bonus: `fest omp`

`bin/fest-omp` is a PATH plugin — fest auto-discovers any `fest-*` binary,
so drop it on PATH and boom 💥 `fest omp status` / `fest omp next` work
*inside* the fest CLI itself.

## 🏗️ under the hood

hexagonal (ports & adapters), zero runtime deps, strict TypeScript,
`strictTypeChecked` ESLint, 28 vitest cases. clean enough to read for fun:

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
npm test           # 28 tests, all green ✅
npm run typecheck  # strict tsc 🧊
npm run lint       # strictTypeChecked eslint 🧹
```

---

built for people who'd rather ship festivals than run commands 🏕️🎪
