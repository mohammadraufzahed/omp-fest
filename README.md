# omp-fest

An [oh-my-pi](https://github.com/oh-my-pi) extension that makes omp fully
comply with [fest.build](https://fest.build): the Festival methodology by
Obedience Corp. The AI acts as the **worker** — it gets structured,
self-healing tools to run the fest loop — and the human acts as the
**supervisor** — plans and phase gates stop for your confirmation.

## Install

Add as a git submodule inside any omp project:

```bash
git submodule add https://github.com/mohammadraufzahed/omp-fest .omp/extensions/omp-fest
```

Requires the fest toolchain on PATH (`npm i -g @obedience-corp/festival`).

## What the agent gets

- **Orientation on session start** — camp/festival/task context injected once
  (~60 tokens), re-injected after compaction
- **Typed `fest_next`** — returns `task | wf_step | gate_step | blocked |
  complete | idle` so the model branches on `kind`, never parses prose.
  `blocked` includes the exact files and markers to fix
- **`fest_task_complete` with `evidence`** — the model must report proof
  against the task's Done-When checklist
- **Loop discipline** — task → `fest commit` (auto `[camp-id:fest-id]` tag),
  with a nudge when the model commits or wanders off-loop
- **Live status line** — `🏕 camp ▸ festival ▸ task N/M ▸ ⛔ gate`, driven by
  watching `.fest/progress_events.jsonl` (no polling)
- **10 tools** (`fest_next`, `fest_task_complete`, `fest_task_update`,
  `fest_commit`, `fest_validate`, `fest_workflow`, `fest_gate_submit`,
  `fest_status`, `fest_markers`, `camp_idea_add`) and 10 slash commands
  (`/fest`, `/fest-next`, `/fest-status`, `/fest-show`, `/fest-task`,
  `/fest-approve`, `/fest-reject`, `/fest-doctor`, `/camp-idea`) with live
  argument completion from `fest list` / `camp idea list`

## What the human gets

- **Gate cards stop the session** — `fest_gate_submit` returns
  `awaiting_human`; `/fest-approve` / `/fest-reject` run the attestation.
  The model never self-approves
- **Graceful degradation** — outside a camp the tools return `idle`, and
  everything works without `camp`/`fest` installed
- **`.ompfest.json`** — per-project config: `gateNotify` channels,
  `autonomyCeiling`, webhook URL

## `fest omp`

`bin/fest-omp` is a PATH plugin: any `fest-*` binary on PATH becomes a
`fest <name>` subcommand. Symlink or copy it onto PATH to get
`fest omp status` / `fest omp next` inside the fest CLI itself.

## Architecture

Hexagonal (ports & adapters), zero runtime dependencies:

```
index.ts                  composition root (wires everything onto the pi API)
src/domain/               pure logic: next-unit classifier, validation
                          parsing, progress summaries, orientation note,
                          config
src/application/          orientSession, LoopTracker
src/ports.ts              ExecRunner, FestCli, CampCli, CampDetect,
                          Notifier, GatePresenter
src/adapters/cli/         node-exec (execFile), fest-cli (--yes --json),
                          camp-cli
src/adapters/fs/          camp-fs detection + progress_events.jsonl watcher
src/adapters/omp/         tools, commands+completers, notify fan-out,
                          structural zod shim
tests/                    vitest, one file per module
```

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit (strict)
npm run lint      # eslint (strictTypeChecked)
```
