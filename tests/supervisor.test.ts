import { describe, expect, it, vi } from "vitest";
import { Supervisor, SUPERVISOR_ENTRY } from "../src/application/supervisor.js";
import { supervisorCommands } from "../src/adapters/omp/supervisor-commands.js";
import { dispatchQueue, type DispatchTask } from "../src/application/supervisor-queue.js";
import type { NextUnit } from "../src/domain/types.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSupervisorTools } from "../src/adapters/omp/supervisor-tools.js";
import { supervisorQueue } from "../src/adapters/omp/supervisor-tools.js";
import { LoopTracker } from "../src/application/loop-tracker.js";
import type { PiLike, ToolDeps } from "../src/adapters/omp/tools.js";
import { listProjectReservations, reserveProjectFiles, releaseProjectFiles } from "../src/application/project-conflicts.js";
import { claimFestivalOwnership } from "../src/application/festival-ownership.js";
import { joinFestivalTeam, readFestivalTeam } from "../src/application/festival-team.js";
import { readPortfolioState, recordPortfolioFestivalDispatch, reservePortfolioAssignment, setPortfolioPaused, updatePortfolioAssignmentRuntime } from "../src/application/portfolio-state.js";
import { supervisorPortfolioQueue } from "../src/adapters/omp/supervisor-tools.js";
import { PAGE, SVG } from "./visual-fixture.js";

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
  it("records coordinator worktree attestation separately from worker submissions", () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("coordinator", "festival", "task.md", "Worker A", ["src/a.ts"]);
    expect(() => supervisor.update("coordinator", row.id, "accept_reviewed", "Tests passed")).toThrow("completed or explicitly unverifiable");
    supervisor.observeRuntime("coordinator", { assignmentId: row.id, status: "unverifiable" }, "unverified");
    const accepted = supervisor.update("coordinator", row.id, "accept_reviewed", "Inspected src/a.ts; npm test passed.");
    expect(accepted).toMatchObject({
      status: "accepted",
      report: "",
      review: "Inspected src/a.ts; npm test passed.",
      reviewSource: "coordinator-worktree",
    });
    const restored = new Supervisor();
    restored.restore("coordinator", [{ customType: SUPERVISOR_ENTRY, data: supervisor.state("coordinator") }]);
    expect(restored.state("coordinator").workers[0]).toMatchObject({ status: "accepted", reviewSource: "coordinator-worktree", report: "" });
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

  it("allows parallel task assignments without an arbitrary worker cap and preserves running work on pause", () => {
    const supervisor = new Supervisor();
    const first = supervisor.assign("s", "festival", "a.md", "A", ["src/a"]);
    supervisor.update("s", first.id, "running", "");
    const overlapping = supervisor.assign("s", "festival", "b.md", "B", ["src/a/child.ts"]);
    expect(overlapping.status).toBe("assigned");
    for (let index = 0; index < 20; index += 1) {
      expect(supervisor.assign("s", "festival", `${index}.md`, `worker-${index}`, [`src/${index}.ts`]).status).toBe("assigned");
    }
    supervisor.pause("s", true);
    expect(supervisor.state("s").workers[0]?.status).toBe("running");
    expect(() => supervisor.assign("s", "festival", "paused.md", "Paused", ["src/paused.ts"])).toThrow("paused");
    supervisor.update("s", first.id, "submit", "Completed during pause");
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
  it("frees worker capacity for blocked assignments but still holds their task", () => {
    const task: DispatchTask = { path: "001_BUILD/01_a/01_task.md", sequence: "001_BUILD/01_a", done: false, document: "Task ID: a\nDependencies: none" };
    const blocked = { id: "blocked", festival: "festival", task: task.path, worker: "A", files: [], status: "blocked" as const, report: "", review: "" };
    const queue = dispatchQueue({
      festivalDir: "/festival", festival: "festival",
      current: { kind: "task", path: task.path, doc: "", goals: [] },
      tasks: [task], workers: [blocked], paused: false, limit: 1,
    });
    expect(queue.capacity).toBe(1);
    expect(queue.candidates).toEqual([]);
    expect(queue.waiting.some((row) => row.task === task.path && row.reason.includes("owns this task"))).toBe(true);
  });

  it("surfaces overlapping candidate boundaries before launch", () => {
    const tasks = ["a", "b", "c", "d"].map((name, index) => ({
      path: `001_BUILD/0${index + 1}_${name}/01_task.md`, sequence: `001_BUILD/0${index + 1}_${name}`,
      done: false, document: `Task ID: ${name}\nDependencies: none\n- src/${name}.ts (existing)`,
    }));
    const input = { festivalDir: "/festival", festival: "festival", current: { kind: "task" as const, path: tasks[0]!.path, doc: "", goals: [] }, tasks, workers: [], paused: false };
    expect(dispatchQueue(input).candidates).toHaveLength(4);
    tasks[1]!.document = "Dependencies: none\n- src (existing)";
    const overlapping = dispatchQueue(input);
    expect(overlapping.candidates.map((row) => row.task)).not.toContain(tasks[1]!.path);
    expect(overlapping.waiting.find((row) => row.task === tasks[1]!.path)?.reason).toContain("overlaps");
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", tasks[0]!.path, "A", ["src/a.ts"]);
    supervisor.update("s", row.id, "running", "");
    supervisor.update("s", row.id, "submit", "Implemented");
    supervisor.update("s", row.id, "accept", "Independently checked");
    const acceptedQueue = dispatchQueue({ ...input, workers: supervisor.state("s").workers });
    expect(acceptedQueue.candidates.map((candidate) => candidate.task)).not.toContain(row.task);
    expect(acceptedQueue.waiting.find((waiting) => waiting.task === row.task)?.reason).toContain("awaits festival task completion");
    const failed = new Supervisor();
    const failedRow = failed.assign("s", "festival", tasks[0]!.path, "failed-worker", ["src/a.ts"]);
    failed.observeRuntime("s", { assignmentId: failedRow.id, runtimeId: "native-failed", status: "failed" });
    const retryQueue = dispatchQueue({ ...input, workers: failed.state("s").workers });
    expect(retryQueue.candidates.map((candidate) => candidate.task)).toContain(failedRow.task);
  });

  it("closes failed native assignments and permits a fresh retry without accepting the failure", () => {
    const supervisor = new Supervisor();
    const row = supervisor.assign("s", "festival", "task.md", "A", ["a.ts"]);
    supervisor.update("s", row.id, "running", "");
    const result = supervisor.observeNativeResult("s", { results: [{ assignmentId: row.id, agentId: "native-a", status: "failed" }] });
    expect(result.observed[0]).toMatchObject({ status: "failed", runtime: { source: "native_tool_result", runtimeId: "native-a", status: "failed" } });
    expect(() => supervisor.update("s", row.id, "submit", "Partial implementation report")).toThrow("terminal");
    expect(supervisor.reconcile("s").unfinished).toEqual([]);
    expect(supervisor.observeNativeResult("s", { status: "completed", text: "A succeeded" }).observed).toEqual([]);

    const retry = supervisor.assign("s", "festival", "task.md", "B", ["a.ts"]);
    supervisor.update("s", retry.id, "running", "");
    supervisor.observeRuntime("s", { assignmentId: retry.id, runtimeId: "native-b", status: "running" });
    expect(() => supervisor.observeRuntime("s", { assignmentId: retry.id, runtimeId: "duplicate", status: "running" })).toThrow("identity");
    supervisor.observeRuntime("s", { assignmentId: retry.id, runtimeId: "native-b", status: "completed" });
    supervisor.update("s", retry.id, "submit", "Implemented and verified");
    supervisor.update("s", retry.id, "accept", "Independent smoke passed");
    expect(supervisor.state("s").workers.map((worker) => worker.status)).toEqual(["failed", "accepted"]);
  });

  it("restores failed assignments without allowing stale durable state to revive them", () => {
    const original = new Supervisor();
    const row = original.assign("s", "festival", "task.md", "A", ["a.ts"]);
    original.observeRuntime("s", { assignmentId: row.id, runtimeId: "native-a", status: "failed" });
    const restored = new Supervisor();
    restored.restore("s", [{ customType: SUPERVISOR_ENTRY, data: original.state("s") }]);
    restored.restoreAssignments("s", [{
      ...row, status: "running",
      runtime: { status: "running", runtimeId: "native-a", source: "unverified", observedAt: new Date().toISOString() },
    }]);
    expect(restored.state("s").workers[0]).toMatchObject({ status: "failed", runtime: { status: "failed" } });
    expect(() => restored.update("s", row.id, "running", "")).toThrow("Failed assignments are terminal");
  });

  it("reconciles a durable blocked state over stale local running state", () => {
    const original = new Supervisor();
    const row = original.assign("s", "festival", "task.md", "A", ["a.ts"]);
    original.update("s", row.id, "running", "");
    const restored = new Supervisor();
    restored.restore("s", [{ customType: SUPERVISOR_ENTRY, data: original.state("s") }]);
    restored.restoreAssignments("s", [{ ...row, status: "blocked", review: "Waiting for coordinator input" }]);
    expect(restored.state("s").workers[0]).toMatchObject({ status: "blocked", review: "Waiting for coordinator input" });
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
    await workerCommands.dispatch.run([], ctx);
    await workerCommands.resume.run([], ctx);
    expect(supervisor.state("s").paused).toBe(true);
    expect(sendUserMessage).toHaveBeenCalledOnce();
  });

  it("persists compact native worker submissions without reserving files for task lifetime", async () => {
    const root = await mkdtemp(join(tmpdir(), "fest-supervisor-"));
    try {
      const festival = join(root, "festival"), project = join(root, "project");
      const sequence = "001_BUILD/01_a", task = `${sequence}/01_task.md`;
      const pageDir = join(festival, "references", "pages", "results");
      await mkdir(join(festival, sequence), { recursive: true });
      await mkdir(pageDir, { recursive: true });
      await mkdir(project);
      await writeFile(join(pageDir, "PAGE.md"), PAGE);
      await writeFile(join(pageDir, "wireframe.svg"), SVG);
      await writeFile(join(festival, task), "Task ID: a\nDependencies: none\nVisual reference: references/pages/results/PAGE.md\n- src/a.ts (proposed)");
      const ownership = await claimFestivalOwnership(festival, "s");
      if (ownership.kind !== "claimed") throw new Error(`Cannot select supervisor test festival: ${ownership.kind}`);
      await joinFestivalTeam(root, festival, "s", "s");
      const current: NextUnit = { kind: "task", path: task, workingDir: project, doc: "", goals: [] };
      const deps = {
        detect: {
          locate: () => Promise.resolve({ campRoot: root }),
          listFestivals: () => Promise.resolve([{ id: "festival", name: "festival", path: festival }]),
          pendingTasks: () => Promise.resolve([{ path: task, sequence, done: false }]),
        },
        fest: { next: () => Promise.resolve(current) },
        tracker: { taskOpened: vi.fn(), taskPaused: vi.fn(), taskResumed: vi.fn() },
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
      registerSupervisorTools(pi, deps, supervisor, { isMainSession: (context) => context.agent?.kind !== "sub" });
      const ctx = { cwd: root, sessionManager: { getSessionId: () => "s" }, getAsyncJobSnapshot: () => ({ running: [{ id: "native-a", type: "task", status: "running", label: "task", agentId: "A" }] }) };
      const call = async (params: Record<string, unknown>) => {
        const result = await tools.get("fest_supervisor")!("id", { festival: "festival", ...params }, undefined, undefined, ctx);
        return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      };
      const denied = await tools.get("fest_supervisor")!("id", { action: "portfolio" }, undefined, undefined, { ...ctx, agent: { kind: "sub" } });
      const deniedPayload = JSON.parse(denied.content[0]!.text) as Record<string, unknown>;
      expect(deniedPayload.error).toContain("main-session only");
      const assigned = await call({ action: "assign", task, worker: "A" });
      const contract = assigned.contract as { document: string; visualReferences?: { page: string; content: string }[] };
      expect(contract.document).toContain("Task ID: a");
      expect(contract.visualReferences?.map((reference) => reference.page)).toEqual(["results"]);
      expect(contract.visualReferences?.[0]?.content).toContain("Search works in RTL");
      const assignment = supervisor.state("s").workers[0]!;
      expect(assignment).toMatchObject({ worker: "A", status: "assigned" });
      expect(await listProjectReservations(project)).toEqual([]);
      expect(await call({ action: "running", assignment: assignment.id })).toMatchObject({ kind: "supervisor_blocked" });
      expect(supervisor.state("s").workers[0]?.status).toBe("assigned");
      await call({ action: "running", assignment: assignment.id, runtimeId: "native-a" });
      expect(supervisor.state("s").workers[0]?.runtime).toMatchObject({ runtimeId: "native-a", status: "running" });
      const details = "Worker implementation evidence ".repeat(100);
      await call({ action: "submit", assignment: assignment.id, evidence: details });
      const submitted = supervisor.state("s").workers[0]!;
      expect(submitted.report.length).toBeLessThanOrEqual(600);
      expect(JSON.parse(await readFile(submitted.reportArtifact!, "utf8"))).toMatchObject({ kind: "worker", details });
      const restarted = new Supervisor();
      const resumedPortfolio = await supervisorPortfolioQueue(deps, restarted, "s", root);
      expect(restarted.state("s").workers[0]).toMatchObject({ id: assignment.id, status: "ready_for_review", report: submitted.report });
      expect(resumedPortfolio.queue.waiting.some((row) => row.festival === "festival" && row.task === task && row.reason.includes("owns this task"))).toBe(true);
      const accepted = await call({ action: "accept", assignment: assignment.id, evidence: "Independently exercised the integrated behavior" });
      expect(accepted).toMatchObject({ assignment: { status: "accepted" }, next: { kind: "dispatch_queue", candidates: [] } });
      const reviewedSupervisor = new Supervisor();
      await supervisorPortfolioQueue(deps, reviewedSupervisor, "s", root);
      expect(reviewedSupervisor.state("s").workers[0]).toMatchObject({
        id: assignment.id, status: "accepted", review: "Independently exercised the integrated behavior",
      });
      expect(await listProjectReservations(project)).toEqual([]);
      expect(appendEntry).toHaveBeenCalled();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("lets a coordinator attest to inspected work after an unverifiable worker stops", async () => {
    const root = await mkdtemp(join(tmpdir(), "fest-supervisor-attest-"));
    try {
      const festival = join(root, "festivals", "active", "festival");
      const project = join(root, "project");
      const sequence = "001_BUILD/01_implement";
      const task = `${sequence}/01_task.md`;
      await mkdir(join(festival, sequence), { recursive: true });
      await mkdir(project, { recursive: true });
      await writeFile(join(festival, "fest.yaml"), "id: festival\n");
      await writeFile(join(festival, task), "Task ID: implementation\nDependencies: none\n- src/a.ts (proposed)");
      await writeFile(join(festival, sequence, "SEQUENCE_GOAL.md"), `---\nfest_working_dir: ${JSON.stringify(project)}\n---\n`);
      const ownership = await claimFestivalOwnership(festival, "coordinator");
      if (ownership.kind !== "claimed") throw new Error(`Could not claim test festival: ${ownership.kind}`);
      await joinFestivalTeam(root, festival, "coordinator", "coordinator");
      const current: NextUnit = { kind: "task", path: task, workingDir: project, doc: "", goals: [] };
      const deps = {
        detect: {
          locate: () => Promise.resolve({ campRoot: root }),
          listFestivals: () => Promise.resolve([{ id: "festival", name: "festival", path: festival }]),
          pendingTasks: () => Promise.resolve([{ path: task, sequence, done: false }]),
        },
        fest: { next: () => Promise.resolve(current) },
        tracker: { taskOpened: vi.fn(), taskPaused: vi.fn(), taskResumed: vi.fn() },
      } as unknown as ToolDeps;
      const schema = (): { optional(): unknown } => ({ optional: schema });
      type Execute = (id: string, params: Record<string, unknown>, signal: unknown, update: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }>;
      const tools = new Map<string, Execute>(), supervisor = new Supervisor();
      const appendEntry = vi.fn();
      const pi = {
        zod: { object: schema, string: schema, enum: schema } as never,
        registerTool: (tool: Record<string, unknown>) => { tools.set(String(tool.name), tool.execute as Execute); },
        appendEntry,
      } satisfies PiLike;
      registerSupervisorTools(pi, deps, supervisor, { isMainSession: (context) => context.agent?.kind !== "sub" });
      let running: { id: string; type: string; status: string; label: string }[] = [];
      const confirm = vi.fn(() => Promise.resolve(true));
      const ctx = {
        cwd: root,
        sessionManager: { getSessionId: () => "coordinator" },
        getAsyncJobSnapshot: () => ({ running }),
        ui: { confirm },
      };
      const call = async (params: Record<string, unknown>) => {
        const result = await tools.get("fest_supervisor")!("id", { festival: "festival", ...params }, undefined, undefined, ctx);
        return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      };
      await call({ action: "assign", task, worker: "Worker A" });
      const assignment = supervisor.state("coordinator").workers[0]!;
      supervisor.observeRuntime("coordinator", {
        assignmentId: assignment.id, status: "unverifiable", detail: "No native job currently observed",
      }, "unverified");

      const workerSubmit = await call({ action: "submit", assignment: assignment.id, evidence: "Coordinator's review" });
      expect(workerSubmit.error).toContain("accept_reviewed");
      running = [{ id: "still-writing", type: "task", status: "running", label: "Worker A" }];
      const active = await call({ action: "accept_reviewed", assignment: assignment.id, evidence: "Reviewed files and checks" });
      expect(active.error).toContain("still has a running native job");
      expect(confirm).not.toHaveBeenCalled();

      running = [];
      await updatePortfolioAssignmentRuntime(root, assignment.id, {
        runtimeStatus: "unverifiable", runtimeObservedAt: new Date().toISOString(),
      });
      const recoveredSupervisor = new Supervisor();
      registerSupervisorTools(pi, deps, recoveredSupervisor, { isMainSession: (context) => context.agent?.kind !== "sub" });
      const accepted = await call({
        action: "accept_reviewed",
        assignment: assignment.id,
        evidence: "Inspected src/a.ts; 173/173 tests, TypeScript, build and ESLint passed.",
      });
      expect(accepted).toMatchObject({
        assignment: { status: "accepted", report: "", reviewSource: "coordinator-worktree" },
        sharedAssignment: { status: "accepted", reviewSource: "coordinator-worktree" },
      });
      expect((accepted.sharedAssignment as { report?: string }).report).toBeUndefined();
      expect(confirm).toHaveBeenCalledOnce();
      const taskSelectorFallback = await call({
        action: "accept_reviewed",
        assignment: "7",
        task,
        evidence: "Reviewed via exact task path.",
      });
      expect(taskSelectorFallback.error).toContain("cannot replace an existing accepted assignment");
      const portfolioAssignment = (await readPortfolioState(root)).assignments[0];
      expect(portfolioAssignment).toMatchObject({ status: "accepted", reviewSource: "coordinator-worktree" });
      expect(portfolioAssignment?.report).toBeUndefined();
      const sharedAssignment = (await readFestivalTeam(root, festival))?.assignments[0];
      expect(sharedAssignment).toMatchObject({ status: "accepted", reviewSource: "coordinator-worktree" });
      expect(sharedAssignment?.report).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("suppresses completion nudges while the current task is reserved by another session", async () => {
    const root = await mkdtemp(join(tmpdir(), "fest-supervisor-conflict-"));
    try {
      const festival = join(root, "festivals", "active", "festival");
      const project = join(root, "project");
      const sequence = "001_BUILD/01_implement";
      const task = `${sequence}/01_task.md`;
      await mkdir(join(festival, sequence), { recursive: true });
      await mkdir(project);
      await writeFile(join(festival, task), "Task ID: implementation\nDependencies: none\n- src/a.php (existing)");
      await writeFile(join(festival, sequence, "SEQUENCE_GOAL.md"), `---\nfest_working_dir: ${JSON.stringify(project)}\n---\n`);
      const current: NextUnit = { kind: "task", path: task, workingDir: project, doc: "", goals: [] };
      const tracker = new LoopTracker();
      tracker.taskOpened("session-current", task);
      const deps = {
        detect: {
          locate: () => Promise.resolve({ campRoot: root }),
          listFestivals: () => Promise.resolve([{ id: "festival", name: "festival", status: "active", path: festival }]),
          pendingTasks: () => Promise.resolve([{ path: task, sequence, done: false }]),
        },
        fest: { next: () => Promise.resolve(current) },
        tracker,
      } as unknown as ToolDeps;
      const reservation = await reserveProjectFiles(project, {
        sessionId: "session-owner", assignmentId: "other-festival-worker", festival: "another-festival",
        task: "another-task", worker: "Worker", files: ["src/a.php"],
      });
      expect(reservation.kind).toBe("reserved");

      const blocked = await supervisorQueue(deps, new Supervisor(), "session-current", root, "festival");
      const waiting = blocked.queue.waiting.find((item) => item.task === task);
      expect(waiting?.reason).toContain("/fest conflicts reclaim");
      expect(waiting?.writeLocks).toEqual([expect.objectContaining({
        sessionId: "session-owner", assignmentId: "other-festival-worker", worker: "Worker",
        festival: "another-festival", task: "another-task", files: ["src/a.php"],
      })]);
      expect(tracker.nudge("session-current")).toContain("Do not mark it completed or commit");
      expect(await listProjectReservations(project)).toHaveLength(1);

      await releaseProjectFiles(project, "session-owner", "other-festival-worker");
      const available = await supervisorQueue(deps, new Supervisor(), "session-current", root, "festival");
      expect(available.queue.candidates.map((candidate) => candidate.task)).toContain(task);
      expect(tracker.nudge("session-current")).toContain("fest task completed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("builds a fair owned-festival portfolio, isolates errors and excludes conflicting writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "fest-portfolio-"));
    try {
      const festivals: { id: string; name: string; status: string; path: string }[] = [];
      const taskRows = new Map<string, { path: string; sequence: string; done: boolean }[]>();
      const currentRows = new Map<string, NextUnit>();
      for (let index = 0; index < 23; index++) {
        const id = `f${String(index).padStart(2, "0")}`, festival = join(root, "festivals", "active", id);
        const project = join(root, "projects", id);
        await mkdir(project, { recursive: true });
        await mkdir(festival, { recursive: true });
        const ownership = await claimFestivalOwnership(festival, index === 22 ? "other" : "s");
        if (ownership.kind !== "claimed") throw new Error(`Cannot claim ${id}`);
        festivals.push({ id, name: id, status: "active", path: festival });
        if (index === 22) continue;
        const tasks = [];
        for (let taskIndex = 0; taskIndex < 2; taskIndex++) {
          const sequence = `001_BUILD/0${taskIndex + 1}_work`, task = `${sequence}/01_task.md`;
          await mkdir(join(festival, sequence), { recursive: true });
          await writeFile(join(festival, sequence, "SEQUENCE_GOAL.md"), `---\nfest_working_dir: ${JSON.stringify(project)}\n---\n`);
          const priority = taskIndex === 0 ? "invalid-priority" : "urgent";
          const file = index === 0 ? "src/shared.ts" : `src/${id}-${taskIndex}.ts`;
          await writeFile(join(festival, task), `Task ID: ${id}-${taskIndex}\nDependencies: none\nPriority: ${priority}\n- ${file} (proposed)\n`);
          tasks.push({ path: task, sequence, done: false });
          if (taskIndex === 0) currentRows.set(festival, { kind: "task", path: task, workingDir: project, doc: "", goals: [] });
        }
        taskRows.set(festival, tasks);
      }
      const conflict = await reserveProjectFiles(join(root, "projects", "f00"), {
        sessionId: "writer", assignmentId: "active-write", festival: "elsewhere",
        task: "write", worker: "Writer", files: ["src/shared.ts"],
      });
      expect(conflict.kind).toBe("reserved");
      await recordPortfolioFestivalDispatch(root, "f00");
      const deps = {
        detect: {
          locate: () => Promise.resolve({ campRoot: root }),
          listFestivals: () => Promise.resolve(festivals),
          pendingTasks: (dir: string) => dir.endsWith("f21")
            ? Promise.reject(new Error("broken festival"))
            : Promise.resolve(taskRows.get(dir) ?? []),
        },
        fest: { next: (dir: string) => Promise.resolve(currentRows.get(dir)!) },
        tracker: { taskOpened: vi.fn(), taskPaused: vi.fn(), taskResumed: vi.fn() },
      } as unknown as ToolDeps;
      const portfolio = await supervisorPortfolioQueue(deps, new Supervisor(), "s", root);
      expect(portfolio.queue.candidates).toHaveLength(20);
      expect(new Set(portfolio.queue.candidates.map((candidate) => candidate.festival)).size).toBe(20);
      expect(portfolio.queue.candidates[0]).toMatchObject({ festival: "f01", task: "001_BUILD/02_work/01_task.md", priority: "urgent" });
      expect(portfolio.queue.candidates.every((candidate) => candidate.priority === "urgent")).toBe(true);
      expect(portfolio.queue.waiting.some((row) => row.festival === "f00" && row.task === "001_BUILD/01_work/01_task.md" && row.reason.includes("overlapping files"))).toBe(true);
      expect(portfolio.errors.some((row) => row.festival === "f21" && row.error.includes("broken festival"))).toBe(true);
      expect(portfolio.festivals.map((row) => row.id)).not.toContain("f22");
      expect(portfolio.locks).toEqual(expect.arrayContaining([expect.objectContaining({ assignmentId: "active-write", workingDir: join(root, "projects", "f00") })]));
      expect(portfolio.queue).toMatchObject({ lastFestival: "f00", workerLimit: 20 });
      await setPortfolioPaused(root, true);
      const paused = await supervisorQueue(deps, new Supervisor(), "s", root, "f01");
      expect(paused.queue.candidates).toEqual([]);
      expect(paused.queue.waiting.every((row) => row.reason.includes("paused"))).toBe(true);
      await releaseProjectFiles(join(root, "projects", "f00"), "writer", "active-write");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes portfolio reservations at the global worker cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "fest-portfolio-cap-"));
    try {
      const project = join(root, "project");
      await mkdir(project);
      const attempts = await Promise.allSettled(Array.from({ length: 21 }, (_, index) => reservePortfolioAssignment(root, {
        id: `assignment-${index}`, festival: `festival-${index}`, task: "001_BUILD/01_task.md",
        sessionId: "s", worker: `worker-${index}`, workingDir: project, files: [],
      })));
      expect(attempts.filter((row) => row.status === "fulfilled")).toHaveLength(20);
      expect(attempts.filter((row) => row.status === "rejected")).toHaveLength(1);
      expect((await readPortfolioState(root)).assignments).toHaveLength(20);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("rolls back a team claim when a concurrent portfolio reservation consumes the final capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "fest-portfolio-rollback-"));
    try {
      const festival = join(root, "festivals", "active", "festival"), project = join(root, "project");
      const sequence = "001_BUILD/01_work", task = `${sequence}/01_task.md`;
      await mkdir(join(festival, sequence), { recursive: true });
      await mkdir(project);
      await writeFile(join(festival, sequence, "SEQUENCE_GOAL.md"), `---\nfest_working_dir: ${JSON.stringify(project)}\n---\n`);
      await writeFile(join(festival, task), "Task ID: task\nDependencies: none\n- src/task.ts (proposed)\n");
      const owner = await claimFestivalOwnership(festival, "s");
      if (owner.kind !== "claimed") throw new Error("Cannot claim rollback test festival");
      const current: NextUnit = { kind: "task", path: task, workingDir: project, doc: "", goals: [] };
      let pendingCalls = 0;
      const deps = {
        detect: {
          locate: () => Promise.resolve({ campRoot: root }),
          listFestivals: () => Promise.resolve([{ id: "festival", name: "festival", status: "active", path: festival }]),
          pendingTasks: async () => {
            pendingCalls++;
            if (pendingCalls === 2) {
              await Promise.all(Array.from({ length: 20 }, (_, index) => reservePortfolioAssignment(root, {
                id: `racer-${index}`, festival: `racer-${index}`, task: "task", sessionId: "other",
                worker: `worker-${index}`, workingDir: project, files: [],
              })));
            }
            return [{ path: task, sequence, done: false }];
          },
        },
        fest: { next: () => Promise.resolve(current) },
        tracker: { taskOpened: vi.fn(), taskPaused: vi.fn(), taskResumed: vi.fn() },
      } as unknown as ToolDeps;
      const schema = (): { optional(): unknown } => ({ optional: schema });
      type Execute = (id: string, params: Record<string, unknown>, signal: unknown, update: unknown, ctx: unknown) => Promise<{ content: { text: string }[] }>;
      const tools = new Map<string, Execute>();
      const pi = {
        zod: { object: schema, string: schema, enum: schema } as never,
        registerTool: (tool: Record<string, unknown>) => { tools.set(String(tool.name), tool.execute as Execute); },
      } satisfies PiLike;
      const supervisor = new Supervisor();
      registerSupervisorTools(pi, deps, supervisor);
      const response = await tools.get("fest_supervisor")!("id", { action: "assign", task, worker: "Worker" }, undefined, undefined, {
        cwd: root, sessionManager: { getSessionId: () => "s" },
      });
      expect(response.content[0]?.text).toContain("Portfolio worker limit reached");
      expect(supervisor.state("s").workers).toEqual([]);
      expect((await readPortfolioState(root)).assignments).toHaveLength(20);
      expect((await readFestivalTeam(root, festival))?.assignments.every((row) => row.status === "released")).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
