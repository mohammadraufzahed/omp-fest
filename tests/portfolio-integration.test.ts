import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimFestivalOwnership } from "../src/application/festival-ownership.js";
import { readPortfolioState } from "../src/application/portfolio-state.js";
import { LoopTracker } from "../src/application/loop-tracker.js";
import { registerCommands } from "../src/adapters/omp/commands.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(sessionId: string, existingRoot?: string) {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), "fest-portfolio-command-"));
  if (!existingRoot) {
    roots.push(root);
    const festival = join(root, "festivals", "active", "portfolio-test");
    const project = join(root, "projects", "app");
    const sequence = "001_BUILD/01_implement";
    const task = `${sequence}/01_task.md`;
    await mkdir(join(festival, sequence), { recursive: true });
    await mkdir(project, { recursive: true });
    await writeFile(join(festival, "fest.yaml"), "festival: portfolio-test\n");
    await writeFile(join(festival, sequence, "SEQUENCE_GOAL.md"), "---\nfest_working_dir: projects/app\n---\n");
    await writeFile(join(festival, task), "Task ID: implementation\nDependencies: none\nPriority: high\n- src/feature.ts (proposed)\n");
    const owner = await claimFestivalOwnership(festival, "coordinator");
    if (owner.kind !== "claimed") throw new Error(`Unable to claim test festival: ${owner.kind}`);
  }
  const festival = join(root, "festivals", "active", "portfolio-test");
  const project = join(root, "projects", "app");
  const sequence = "001_BUILD/01_implement";
  const task = `${sequence}/01_task.md`;
  const sent: { content: string }[] = [];
  const userMessages: string[] = [];
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const pi = {
    registerCommand: (name: string, options: { handler(args: string, ctx: unknown): Promise<void> }) => commands.set(name, options),
    sendMessage: (message: { content: string }) => sent.push(message),
    sendUserMessage: (text: string) => userMessages.push(text),
    appendEntry: vi.fn(),
  };
  const detect = {
    locate: () => Promise.resolve({ kind: "camp", campRoot: root, festivalDir: undefined }),
    listFestivals: () => Promise.resolve([{ id: "portfolio-test", name: "Portfolio Test", status: "active", path: festival }]),
    pendingTasks: () => Promise.resolve([{ path: task, sequence, done: false }]),
  };
  const deps = {
    detect,
    fest: { next: () => Promise.resolve({ kind: "task", path: task, workingDir: project, doc: "", goals: [] }) },
    camp: {},
    tracker: new LoopTracker(),
  };
  registerCommands(pi, deps as never);
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => sessionId },
    ui: { notify: vi.fn() },
  };
  return { root, commands, ctx, sent, userMessages };
}

describe("portfolio commands integrated with owned festival state", () => {
  it("renders the owned-festival portfolio and persists limit, pause, and explicit dispatch resume", async () => {
    const app = await harness("coordinator");
    const command = app.commands.get("fest")!;
    await command.handler("portfolio", app.ctx);
    expect(app.sent.map((message) => message.content).join("\n")).toContain("portfolio-test");
    expect(app.sent.map((message) => message.content).join("\n")).toContain("high");

    await command.handler("portfolio limit 5", app.ctx);
    expect((await readPortfolioState(app.root)).workerLimit).toBe(5);
    await command.handler("pause", app.ctx);
    expect((await readPortfolioState(app.root)).paused).toBe(true);
    await command.handler("dispatch", app.ctx);
    expect((await readPortfolioState(app.root)).paused).toBe(false);
    expect(app.userMessages.join("\n")).toContain("fest_supervisor with the portfolio action");
  });

  it("does not let an unowned session alter global portfolio settings", async () => {
    const coordinator = await harness("coordinator");
    const other = await harness("another-session", coordinator.root);
    const coordinatorState = await readPortfolioState(coordinator.root);
    expect(coordinatorState.workerLimit).toBe(20);
    const otherCommand = other.commands.get("fest")!;
    await otherCommand.handler("portfolio limit 3", other.ctx);
    expect((await readPortfolioState(coordinator.root)).workerLimit).toBe(20);
    expect(other.sent.map((message) => message.content).join("\n")).toContain("Only a session that owns at least one festival");
  });
});
