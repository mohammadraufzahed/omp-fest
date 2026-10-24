import { describe, expect, it, vi } from "vitest";
import { Supervisor } from "../src/application/supervisor.js";
import { supervisorCommands, type PortfolioCommandData } from "../src/adapters/omp/supervisor-commands.js";

const assignment = (festival: string, task: string, status: "assigned" | "failed" = "assigned") => ({
  id: `${festival}-${task}`, festival, task, sessionId: "session", worker: "worker-a", workingDir: "/work",
  files: ["src/file.ts"], status, createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
  ...(status === "failed" ? { failure: "worker failed" } : {}),
});

function harness(data: PortfolioCommandData) {
  const sent: string[] = [];
  const pi = { registerCommand: vi.fn(), sendMessage: vi.fn((message: { content: string }) => sent.push(message.content)), sendUserMessage: vi.fn() };
  const ctx = { cwd: "/camp", sessionManager: { getSessionId: () => "session" }, ui: { notify: vi.fn() } };
  const commands = supervisorCommands(pi, new Supervisor(), { portfolio: vi.fn(() => Promise.resolve(data)) });
  return { sent, pi, ctx, commands };
}

describe("/fest portfolio command", () => {
  it("renders portfolio dashboard sections and marks stale recovery advisory", async () => {
    const { sent, commands, ctx } = harness({
      workerLimit: 4, activeWorkers: 1, availableSlots: 3, festivalRows: [{ festival: "alpha", status: "active", progress: "2/4" }],
      candidates: [{ festival: "alpha", task: "task-a", sequence: "seq", files: ["a.ts"], dependencies: [], workingDir: "/work", priority: "high" }],
      waiting: [{ festival: "beta", task: "task-b", reason: "dependency pending" }],
      errors: [{ festival: "beta", error: "queue unavailable" }], activeAssignments: [assignment("alpha", "running")],
      failedTasks: [assignment("beta", "broken", "failed")],
      fileLockConflicts: [{ festival: "alpha", task: "task-c", files: ["shared.ts"], reason: "held by another worker" }],
      staleAssignments: [assignment("beta", "stale")],
    });
    await commands.portfolio.run([], ctx);
    const output = sent.join("\n");
    for (const section of ["Workers:", "Festivals:", "Fair candidates:", "Waiting / festival errors:", "Active workers:", "Failed tasks:", "Current file-lock conflicts:", "Stale assignment recovery candidates"])
      expect(output).toContain(section);
    expect(output).toContain("beta/task-b: dependency pending");
    expect(output).toContain("beta: queue unavailable");
    expect(output).toContain("Stale recovery is advisory only; assignments are never auto-released or relaunched.");
  });
  it("renders dashboard dispatch pause state", async () => {
    const { sent, commands, ctx } = harness({ workerLimit: 4, activeWorkers: 1, availableSlots: 3, paused: true });
    await commands.portfolio.run([], ctx);
    expect(sent.join("\n")).toContain("dispatch paused");
  });
  it("pauses the portfolio without cancelling existing workers", async () => {
    const sent: string[] = [];
    const pi = { registerCommand: vi.fn(), sendMessage: vi.fn((message: { content: string }) => sent.push(message.content)), sendUserMessage: vi.fn() };
    const ctx = { cwd: "/camp", sessionManager: { getSessionId: () => "session" }, ui: { notify: vi.fn() } };
    const supervisor = new Supervisor();
    const setPaused = vi.fn((_ctx, _paused: boolean) => Promise.resolve());
    const commands = supervisorCommands(pi, supervisor, { setPortfolioPaused: setPaused });
    await commands.pause.run([], ctx);
    expect(supervisor.state("session").paused).toBe(true);
    expect(setPaused).toHaveBeenCalledTimes(1);
    expect(sent.join("\n")).toContain("Existing workers are not cancelled");
  });

  it("dispatch explicitly resumes global pause and fails closed when persistence fails", async () => {
    const sent: string[] = [];
    const pi = { registerCommand: vi.fn(), sendMessage: vi.fn((message: { content: string }) => sent.push(message.content)), sendUserMessage: vi.fn() };
    const ctx = { cwd: "/camp", sessionManager: { getSessionId: () => "session" }, ui: { notify: vi.fn() } };
    const setPaused = vi.fn((_ctx, _paused: boolean) => Promise.resolve());
    const supervisor = new Supervisor();
    const commands = supervisorCommands(pi, supervisor, { setPortfolioPaused: setPaused });
    await commands.dispatch.run([], ctx);
    expect(supervisor.state("session").paused).toBe(false);
    expect(setPaused).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);

    const failingPi = { ...pi, sendUserMessage: vi.fn() };
    const failing = supervisorCommands(failingPi, new Supervisor(), { setPortfolioPaused: vi.fn(() => Promise.reject(new Error("ledger locked"))) });
    await failing.dispatch.run([], ctx);
    expect(failingPi.sendUserMessage).not.toHaveBeenCalled();
    expect(sent.join("\n")).toContain("No portfolio dispatch was requested");
  });

  it("resume reconciles without changing local or global pause", async () => {
    const sent: string[] = [];
    const pi = { registerCommand: vi.fn(), sendMessage: vi.fn((message: { content: string }) => sent.push(message.content)), sendUserMessage: vi.fn() };
    const ctx = { cwd: "/camp", sessionManager: { getSessionId: () => "session" }, ui: { notify: vi.fn() } };
    const supervisor = new Supervisor();
    supervisor.pause("session", true);
    const setPaused = vi.fn();
    const commands = supervisorCommands(pi, supervisor, { setPortfolioPaused: setPaused });
    await commands.resume.run([], ctx);
    expect(supervisor.state("session").paused).toBe(true);
    expect(setPaused).not.toHaveBeenCalled();
  });


  it("dispatches through portfolio action without transferring ownership or cancelling work", async () => {
    const { pi, ctx, commands } = harness({ workerLimit: 4, activeWorkers: 1, availableSlots: 3 });
    await commands.dispatch.run([], ctx);
    const prompt = String(pi.sendUserMessage.mock.calls[0]?.[0] ?? "");
    expect(prompt).toContain("fest_supervisor with the portfolio action");
    expect(prompt).toContain("every explicitly owned festival");
    expect(prompt).toContain("available slots are filled (maximum 20 workers)");
    expect(prompt).toContain("never select unowned, joined, or unrelated festivals");
    expect(prompt).toContain("never transfer ownership");
    expect(prompt).toContain("Do not cancel unrelated work");
    expect(prompt).toContain("festival-local dependency, gate, and file-lock checks");
    expect(prompt).not.toContain("fest_supervisor queue");
  });

  it("rejects out-of-range and malformed limits without calling the setting hook", async () => {
    const sent: string[] = [];
    const pi = { registerCommand: vi.fn(), sendMessage: vi.fn((message: { content: string }) => sent.push(message.content)) };
    const ctx = { cwd: "/camp", sessionManager: { getSessionId: () => "session" }, ui: { notify: vi.fn() } };
    const setLimit = vi.fn(() => Promise.resolve(undefined));
    const commands = supervisorCommands(pi, new Supervisor(), { setPortfolioWorkerLimit: setLimit });
    await commands.portfolio.run(["limit", "21"], ctx);
    await commands.portfolio.run(["limit", "2.5"], ctx);
    expect(sent.join("\n")).toContain("integer from 1 to 20");
    expect(setLimit).not.toHaveBeenCalled();
  });

  it("reports errors from the limit hook and never auto-recovers stale assignments", async () => {
    const stale = assignment("alpha", "stale");
    const data = { workerLimit: 2, activeWorkers: 1, availableSlots: 1, staleAssignments: [stale] };
    const { sent, commands, ctx } = harness(data);
    const setLimit = vi.fn(() => Promise.reject(new Error("ledger locked")));
    const withLimit = supervisorCommands({ registerCommand: vi.fn(), sendMessage: vi.fn((message: { content: string }) => sent.push(message.content)) }, new Supervisor(), {
      portfolio: vi.fn(() => Promise.resolve(data)), setPortfolioWorkerLimit: setLimit,
    });
    await withLimit.portfolio.run(["limit", "3"], ctx);
    expect(sent.join("\n")).toContain("Portfolio worker limit was not changed: Error: ledger locked");
    await commands.portfolio.run([], ctx);
    expect(sent.join("\n")).toContain("alpha/stale · worker-a · assigned");
    expect(sent.join("\n")).toContain("never auto-released or relaunched");
  });
});
