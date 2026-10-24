import { describe, expect, it, vi } from "vitest";
import { Supervisor, SUPERVISOR_ENTRY } from "../src/application/supervisor.js";
import { supervisorCommands } from "../src/adapters/omp/supervisor-commands.js";
import { dispatchQueue, filesOverlap, type DispatchTask } from "../src/application/supervisor-queue.js";
import type { NextUnit } from "../src/domain/types.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSupervisorTools } from "../src/adapters/omp/supervisor-tools.js";
import type { PiLike, ToolDeps } from "../src/adapters/omp/tools.js";
import { listProjectReservations } from "../src/application/project-conflicts.js";

describe("festival supervisor", () => {
  it("requires a real dispatch and independent review before acceptance", () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "task.md", "Implementation", ["src/a.ts"]);
    expect(() => supervisor.update("s", row.id, "submit", "Tests passed")).toThrow("running worker");
    expect(() => supervisor.update("s", row.id, "accept", "Reviewed")).toThrow("submitted results");
    supervisor.update("s", row.id, "running", "");
    supervisor.update("s", row.id, "submit", "Changed src/a.ts; command npm test passed");
    expect(() => supervisor.update("s", row.id, "accept", " ")).toThrow("evidence");
    supervisor.update("s", row.id, "revise", "Handle the empty state");
    supervisor.update("s", row.id, "running", "");
    supervisor.update("s", row.id, "submit", "Empty state now verified");
    expect(supervisor.update("s", row.id, "accept", "Independently exercised empty state").status).toBe("accepted");
    expect(() => supervisor.update("s", row.id, "running", "")).toThrow("cannot be changed");
  });

  it("returns compact status deltas for known revisions and a full reset for expired revisions", () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "task.md", "A", ["src/a.ts"]);
    const first = supervisor.snapshot("s");
    supervisor.update("s", row.id, "running", "");
    const delta = supervisor.snapshot("s", first.revision);
    expect(delta).toMatchObject({ full: false, delta: { workers: [{ id: row.id, status: "running" }] } });
    expect(supervisor.snapshot("s", "expired")).toMatchObject({ full: true, reset: true });
  });

  it("bounds independent work, prevents overlap and preserves running work on pause", () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "a.md", "A", ["src/a"]);
    supervisor.update("s", row.id, "running", "");
    expect(() => supervisor.assign("s", "festival", "b.md", "B", ["src/a/child.ts"])).toThrow("overlaps");
    expect(() => supervisor.assign("s", "festival", "b.md", "B", [])).toThrow("unknown");
    supervisor.assign("s", "festival", "b.md", "B", ["src/b.ts"]);
    supervisor.assign("s", "festival", "c.md", "C", ["src/c.ts"]);
    expect(() => supervisor.assign("s", "festival", "d.md", "D", ["src/d.ts"])).toThrow("Three assignments");
    supervisor.pause("s", true);
    expect(supervisor.state("s").workers[0]?.status).toBe("running");
    expect(() => supervisor.assign("s", "festival", "d.md", "D", ["src/d.ts"])).toThrow("paused");
    supervisor.update("s", row.id, "submit", "Completed during pause");
    expect(supervisor.state("s").workers[0]?.status).toBe("ready_for_review");
  });

  it("restores only this session branch and isolates worker authority", () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "task.md", "A", ["a.ts"]);
    expect(() => supervisor.update("worker-session", row.id, "accept", "self approval")).toThrow("Unknown assignment");
    supervisor.pause("s", true);
    const snapshot = supervisor.state("s");
    const resumed = new Supervisor();
    resumed.restore("s", [{ customType: SUPERVISOR_ENTRY, data: snapshot }]);
    expect(resumed.state("s")).toEqual(snapshot);
    resumed.restore("s", []);
    expect(resumed.state("s")).toEqual({ paused: false, workers: [] });
  });

  it("native review cancellation preserves submission; acceptance records evidence only", async () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "task.md", "A", ["a.ts"]);
    supervisor.update("s", row.id, "running", "");
    supervisor.update("s", row.id, "submit", "Worker reported test passed");
    const messages: string[] = [];
    const commands = supervisorCommands({ registerCommand: vi.fn(), sendMessage: (message) => { messages.push(String(message.content)); } }, supervisor);
    const ctx = {
      cwd: "/camp", sessionManager: { getSessionId: () => "s" },
      ui: { notify: vi.fn(), select: () => Promise.resolve("Keep pending"), input: () => Promise.resolve("Independent smoke passed") },
    };
    await commands.review.run([row.id], ctx);
    expect(supervisor.state("s").workers[0]?.status).toBe("ready_for_review");
    ctx.ui.select = () => Promise.resolve("Accept after verification");
    await commands.review.run([row.id], ctx);
    expect(supervisor.state("s").workers[0]).toMatchObject({ status: "accepted", review: "Independent smoke passed" });
    expect(messages.at(-1)).toContain("must still integrate");
  });

  it("queues only current-phase sequence heads with completed dependencies and no gate bypass", () => {
    const tasks: DispatchTask[] = [
      { path: "001_BUILD/01_a/01_first.md", sequence: "001_BUILD/01_a", done: false, document: "Task ID: a\nDependencies: setup\n- src/a.ts (existing)" },
      { path: "001_BUILD/01_a/02_second.md", sequence: "001_BUILD/01_a", done: false, document: "Task ID: b\nDependencies: none\n- src/b.ts (existing)" },
      { path: "001_BUILD/02_b/01_first.md", sequence: "001_BUILD/02_b", done: false, document: "Task ID: c\nDependencies: none\n- src/c.ts (existing)" },
      { path: "002_SHIP/01_a/01_first.md", sequence: "002_SHIP/01_a", done: false, document: "Task ID: d\nDependencies: none\n- src/d.ts (existing)" },
    ];
    const current: NextUnit = { kind: "task", path: tasks[0]!.path, doc: "", goals: [] };
    const input = { festivalDir: "/festival", festival: "festival", current, tasks, workers: [], paused: false };
    expect(dispatchQueue(input).candidates.map((row) => row.task)).toEqual([tasks[2]!.path]);
    tasks.push({ path: "000_SETUP/01_a/01_setup.md", sequence: "000_SETUP/01_a", done: true, document: "Task ID: setup" });
    expect(dispatchQueue(input).candidates.map((row) => row.task)).toEqual([tasks[0]!.path, tasks[2]!.path]);
    expect(dispatchQueue({ ...input, current: { kind: "gate_step", phase: "001_BUILD", step: 1, totalSteps: 1, question: "Approve?", doc: "" } }).candidates).toEqual([]);
    expect(dispatchQueue({ ...input, paused: true }).candidates).toEqual([]);
  });

  it("bounds queued candidates and serializes overlapping or unknown boundaries", () => {
    const tasks = ["a", "b", "c", "d"].map((name, index) => ({
      path: `001_BUILD/0${index + 1}_${name}/01_task.md`, sequence: `001_BUILD/0${index + 1}_${name}`,
      done: false, document: `Task ID: ${name}\nDependencies: none\n- src/${name}.ts (existing)`,
    }));
    const input = { festivalDir: "/festival", festival: "festival", current: { kind: "task" as const, path: tasks[0]!.path, doc: "", goals: [] }, tasks, workers: [], paused: false };
    expect(dispatchQueue(input).candidates).toHaveLength(3);
    tasks[1]!.document = "Dependencies: none\n- src (existing)";
    expect(dispatchQueue(input).candidates.map((row) => row.task)).not.toContain(tasks[1]!.path);
    expect(filesOverlap(["src/./a.ts"], ["src/a.ts"])).toBe(true);
    expect(filesOverlap([], ["src/a.ts"])).toBe(true);
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", tasks[0]!.path, "A", ["src/a.ts"]);
    supervisor.update("s", row.id, "running", "");
    supervisor.update("s", row.id, "submit", "Implemented");
    supervisor.update("s", row.id, "accept", "Independently checked");
    const acceptedQueue = dispatchQueue({ ...input, workers: supervisor.state("s").workers });
    expect(acceptedQueue.candidates.map((candidate) => candidate.task)).not.toContain(row.task);
    expect(acceptedQueue.waiting.find((waiting) => waiting.task === row.task)?.reason).toContain("awaits festival task completion");
  });

  it("separates observed lifecycle from reported status and never accepts native failures", () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "task.md", "A", ["a.ts"]);
    supervisor.update("s", row.id, "running", "");
    const result = supervisor.observeNativeResult("s", { results: [{ assignmentId: row.id, agentId: "native-a", status: "failed" }] });
    expect(result.observed[0]).toMatchObject({ status: "running", runtime: { source: "native_tool_result", runtimeId: "native-a", status: "failed" } });
    supervisor.update("s", row.id, "submit", "Partial implementation report");
    expect(() => supervisor.update("s", row.id, "accept", "Reviewed")).toThrow("reconcile");
    expect(supervisor.observeNativeResult("s", { status: "completed", text: "A succeeded" }).observed).toEqual([]);
    expect(() => supervisor.observeRuntime("s", { assignmentId: row.id, runtimeId: "duplicate", status: "running" })).toThrow("identity");
    supervisor.observeRuntime("s", { assignmentId: row.id, runtimeId: "native-a", status: "completed" });
    expect(supervisor.state("s").workers[0]?.status).toBe("ready_for_review");
    supervisor.update("s", row.id, "accept", "Independent smoke passed");
    expect(supervisor.state("s").workers[0]?.status).toBe("accepted");
  });

  it("durably restores paused unfinished assignments and refuses duplicate resume launches", () => {
    const original = new Supervisor();
    const row = original.assign("s", "festival", "task.md", "A", ["a.ts"]);
    original.observeRuntime("s", { assignmentId: row.id, runtimeId: "native-a", status: "running" });
    original.pause("s", true);
    const resumed = new Supervisor();
    resumed.restore("s", [{ customType: SUPERVISOR_ENTRY, data: original.state("s") }]);
    const result = resumed.reconcile("s");
    expect(result).toMatchObject({ paused: true, unfinished: [{ assignment: { id: row.id }, launchAllowed: false }] });
    expect(resumed.state("s").workers).toHaveLength(1);
    expect(resumed.state("s").workers[0]?.runtime).toMatchObject({ status: "unverifiable", source: "unverified", runtimeId: "native-a" });
    expect(() => resumed.update("s", row.id, "running", "")).toThrow("Reconcile native lifecycle");
    resumed.pause("s", false);
    expect(() => resumed.assign("s", "festival", "task.md", "A2", ["a.ts"])).toThrow("outstanding");
  });

  it("retains cancelled blocker questions and hands recorded answers to a native supervisor turn", async () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "task.md", "A", ["a.ts"]);
    const blocker = supervisor.question("s", row.id, "Which API contract?");
    const sendUserMessage = vi.fn();
    const commands = supervisorCommands({ registerCommand: vi.fn(), sendMessage: vi.fn(), sendUserMessage }, supervisor);
    const ctx = { cwd: "/camp", sessionManager: { getSessionId: () => "s" }, ui: { notify: vi.fn(), input: (): Promise<string | undefined> => Promise.resolve(undefined) } };
    await commands.blockers.run([blocker.id], ctx);
    expect(supervisor.state("s").blockers?.[0]?.answer).toBeUndefined();
    expect(sendUserMessage).not.toHaveBeenCalled();
    ctx.ui.input = () => Promise.resolve("Use the approved contract");
    await commands.blockers.run([blocker.id], ctx);
    expect(supervisor.state("s").blockers?.[0]).toMatchObject({ question: "Which API contract?", answer: "Use the approved contract" });
    expect(sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("never relaunch a duplicate"));
    expect(supervisor.state("s").workers[0]?.status).toBe("blocked");
  });

  it("resume preserves pause, triggers a native turn and rejects worker-session commands", async () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "task.md", "A", ["a.ts"]);
    supervisor.pause("s", true);
    const sendUserMessage = vi.fn();
    const pi = { registerCommand: vi.fn(), sendMessage: vi.fn(), sendUserMessage };
    const ctx = { cwd: "/camp", sessionManager: { getSessionId: () => "s" }, ui: { notify: vi.fn() } };
    const commands = supervisorCommands(pi, supervisor, { runtimeObservations: () => Promise.resolve([{ assignmentId: row.id, runtimeId: "native", status: "running" }]) });
    await commands.resume.run([], ctx);
    expect(supervisor.state("s").paused).toBe(true);
    expect(supervisor.state("s").workers[0]?.runtime?.source).toBe("native_runtime");
    expect(sendUserMessage).toHaveBeenCalledOnce();
    const workerCommands = supervisorCommands(pi, supervisor, { isMainSession: () => false });
    workerCommands.dispatch.run([], ctx);
    await workerCommands.resume.run([], ctx);
    expect(supervisor.state("s").paused).toBe(true);
    expect(sendUserMessage).toHaveBeenCalledOnce();
  });

  it("persists compact native worker submissions, returns the next queue and releases accepted boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "fest-supervisor-"));
    try {
      const festival = join(root, "festival"), project = join(root, "project");
      const sequence = "001_BUILD/01_a", task = `${sequence}/01_task.md`;
      await mkdir(join(festival, sequence), { recursive: true });
      await mkdir(project);
      await writeFile(join(festival, task), "Task ID: a\nDependencies: none\n- src/a.ts (proposed)");
      await writeFile(join(festival, sequence, "SEQUENCE_GOAL.md"), `---\nfest_working_dir: ${JSON.stringify(project)}\n---\n`);
      const current: NextUnit = { kind: "task", path: task, workingDir: project, doc: "", goals: [] };
      const deps = {
        detect: {
          locate: () => Promise.resolve({ campRoot: root }),
          listFestivals: () => Promise.resolve([{ id: "festival", name: "festival", path: festival }]),
          pendingTasks: () => Promise.resolve([{ path: task, sequence, done: false }]),
        },
        fest: { next: () => Promise.resolve(current) },
        tracker: { taskOpened: vi.fn() },
      } as unknown as ToolDeps;
      const schema = (): { optional(): unknown } => ({ optional: schema });
      type Execute = (id: string, params: Record<string, unknown>, signal: unknown, update: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }>;
      const tools = new Map<string, Execute>(), appendEntry = vi.fn();
      const pi = {
        zod: { object: schema, string: schema, enum: schema } as never,
        registerTool: (tool: Record<string, unknown>) => { tools.set(String(tool.name), tool.execute as Execute); },
        appendEntry,
      } satisfies PiLike;
      const supervisor = new Supervisor();
      registerSupervisorTools(pi, deps, supervisor);
      const ctx = { cwd: root, sessionManager: { getSessionId: () => "s" }, getAsyncJobSnapshot: () => ({ running: [{ id: "native-a", type: "task", status: "running", label: "task", agentId: "A" }] }) };
      const call = async (params: Record<string, unknown>) => {
        const result = await tools.get("fest_supervisor")!("id", { festival: "festival", ...params }, undefined, undefined, ctx);
        return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      };
      await call({ action: "assign", task, worker: "A" });
      const assignment = supervisor.state("s").workers[0]!;
      expect(assignment).toMatchObject({ worker: "A", status: "assigned" });
      expect(await listProjectReservations(project)).toHaveLength(1);
      expect(await call({ action: "running", assignment: assignment.id })).toMatchObject({ kind: "supervisor_blocked" });
      expect(supervisor.state("s").workers[0]?.status).toBe("assigned");
      await call({ action: "running", assignment: assignment.id, runtimeId: "native-a" });
      expect(supervisor.state("s").workers[0]?.runtime).toMatchObject({ runtimeId: "native-a", status: "running" });
      const details = "Worker implementation evidence ".repeat(100);
      await call({ action: "submit", assignment: assignment.id, evidence: details });
      const submitted = supervisor.state("s").workers[0]!;
      expect(submitted.report.length).toBeLessThanOrEqual(600);
      expect(JSON.parse(await readFile(submitted.reportArtifact!, "utf8"))).toMatchObject({ kind: "worker", details });
      const accepted = await call({ action: "accept", assignment: assignment.id, evidence: "Independently exercised the integrated behavior" });
      expect(accepted).toMatchObject({ assignment: { status: "accepted" }, next: { kind: "dispatch_queue", candidates: [] } });
      expect(await listProjectReservations(project)).toEqual([]);
      expect(appendEntry).toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
