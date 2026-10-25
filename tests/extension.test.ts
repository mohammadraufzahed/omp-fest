/**
 * End-to-end smoke test: drives the real extension factory with a mock
 * ExtensionAPI matching @oh-my-pi/pi-coding-agent's actual signatures
 * (verified against upstream types), so API drift is caught here.
 */
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import ompFest from "../index.js";
import { festivalOwner } from "../src/application/festival-ownership.js";
import { claimFestivalOwnership } from "../src/application/festival-ownership.js";
import { claimFestivalTask, joinFestivalTeam, readFestivalTeam, releaseFestivalTask, reviewFestivalTask, submitFestivalTask } from "../src/application/festival-team.js";
import { listProjectReservations } from "../src/application/project-conflicts.js";
import { integrationReviewStatus } from "../src/application/integration-review.js";
import { readPortfolioState, reservePortfolioAssignment, updatePortfolioAssignment } from "../src/application/portfolio-state.js";
import { SUPERVISOR_ENTRY } from "../src/application/supervisor.js";
import { beginFestivalCreation, listQuarantinedFestivals, recordFestivalCreation, rollbackFestivalCreation } from "../src/application/festival-creation.js";
import { processIsAlive } from "../src/application/fs-lock.js";

interface AutocompleteItem {
  value: string;
  label: string;
}

interface RegisteredCommand {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function zodNode(kind: string): Record<string, unknown> {
  return {
    kind,
    optional: () => zodNode(kind),
    describe: () => zodNode(kind),
    default: () => zodNode(kind),
  };
}

interface SentMessage {
  message: { customType: string; content: string; display: boolean };
  options?: { triggerTurn?: boolean };
}

interface ToolOutput {
  content: { type: string; text: string }[];
}
type ToolExecute = (id: string, params: Record<string, unknown>, signal: unknown, update: unknown, ctx: unknown) => Promise<ToolOutput>;

function mockPi(cwd: string) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, RegisteredCommand>();
  const tools: { name: string }[] = [];
  const toolExecutors = new Map<string, ToolExecute>();
  const sent: SentMessage[] = [];
  const userMessages: string[] = [];
  const statuses: Record<string, string | undefined> = {};
  const ctx = {
    cwd,
    ui: {
      notify: vi.fn(),
      setStatus: (key: string, text: string | undefined) => {
        statuses[key] = text;
      },
    },
  };
  const pi = {
    zod: {
      object: (shape: Record<string, unknown>) => ({ ...zodNode("object"), shape }),
      string: () => zodNode("string"),
      enum: (values: string[]) => ({ ...zodNode("enum"), values }),
      array: (item: unknown) => ({ ...zodNode("array"), item }),
      boolean: () => zodNode("boolean"),
      number: () => zodNode("number"),
    },
    logger: { warn: vi.fn() },
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, handler);
    },
    registerTool: (tool: { name: string; execute?: unknown }) => {
      tools.push({ name: tool.name });
      if (typeof tool.execute === "function") toolExecutors.set(tool.name, tool.execute as ToolExecute);
    },
    registerCommand: (name: string, options: RegisteredCommand) => commands.set(name, options),
    sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
      sent.push({ message, options });
    },
    sendUserMessage: (text: string) => {
      userMessages.push(text);
    },
    setLabel: vi.fn(),
  };
  return { pi, handlers, commands, tools, toolExecutors, sent, userMessages, statuses, ctx };
}
it("keeps festival mutations and supervision under the main agent", async () => {
  const root = await makeCamp();
  const { pi, toolExecutors } = mockPi(root);
  ompFest(pi as never);
  const ctx = { cwd: root, agent: { kind: "sub" }, sessionManager: { getSessionId: () => "worker-session" } };
  const attempts: { name: string; params: Record<string, unknown>; kind: string }[] = [
    { name: "fest_next", params: {}, kind: "supervisor_authority_required" },
    { name: "fest_task_complete", params: { evidence: "verified" }, kind: "supervisor_authority_required" },
    { name: "fest_task_update", params: { action: "unblock" }, kind: "supervisor_authority_required" },
    { name: "fest_commit", params: { message: "worker commit" }, kind: "supervisor_authority_required" },
    { name: "fest_gate_submit", params: { evidence: "verified" }, kind: "supervisor_authority_required" },
    { name: "fest_promote", params: {}, kind: "supervisor_authority_required" },
    { name: "fest_plan", params: { action: "create", name: "worker-plan" }, kind: "supervisor_authority_required" },
    { name: "fest_flow", params: { action: "run", id: "login" }, kind: "flow_blocked" },
    { name: "fest_team", params: { action: "claim", task: "task.md" }, kind: "team_blocked" },
    { name: "fest_supervisor", params: { action: "portfolio" }, kind: "supervisor_blocked" },
  ];
  for (const attempt of attempts) {
    const execute = toolExecutors.get(attempt.name);
    if (!execute) throw new Error(`Missing registered tool ${attempt.name}`);
    const result = await execute("test", attempt.params, undefined, undefined, ctx);
    const payload = JSON.parse(result.content[0]!.text) as { kind?: string };
    expect(payload.kind, attempt.name).toBe(attempt.kind);
  }
});

async function makeCamp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ompfest-ext-"));
  await mkdir(join(root, "festivals", "active"), { recursive: true });
  await mkdir(join(root, "projects"), { recursive: true });
  return root;
}

describe("ompFest extension", () => {

  it("/fest orphans lists and restores quarantined failed creations", async () => {
    const root = await makeCamp(), planning = join(root, "festivals", "planning");
    await mkdir(planning, { recursive: true });
    const receipt = await beginFestivalCreation(root, "failed-scaffold", "plan.md", "session-1");
    const festival = join(planning, receipt.name);
    await mkdir(festival);
    await writeFile(join(festival, "fest.yaml"), "id: failed-scaffold\n");
    await recordFestivalCreation(receipt, festival);
    await writeFile(join(festival, "user.txt"), "preserved");
    await expect(rollbackFestivalCreation(receipt, festival)).resolves.toBeUndefined();
    const [archive] = await listQuarantinedFestivals(root);
    expect(archive?.name).toBe(receipt.name);
    const { pi, commands, sent, ctx } = mockPi(root);
    Object.assign(ctx.ui, { confirm: vi.fn(() => Promise.resolve(true)) });
    ompFest(pi as never);
    await commands.get("fest")?.handler("orphans", ctx);
    expect(sent.at(-1)?.message.content).toContain(`${archive!.id} · failed-scaffold`);
    await commands.get("fest")?.handler(`orphans restore ${archive!.id}`, ctx);
    expect(sent.at(-1)?.message.content).toContain("Restored failed-scaffold.");
    expect(await readFile(join(festival, "user.txt"), "utf8")).toBe("preserved");
  });

  it("/fest orphans finalizes a validated creation without quarantining its festival", async () => {
    const root = await makeCamp(), planning = join(root, "festivals", "planning");
    await mkdir(planning, { recursive: true });
    const planPath = ".ompfest/plans/finalized.STRUCTURE.md";
    const receipt = await beginFestivalCreation(root, "finalized", planPath, "session-1");
    const festival = join(planning, receipt.name);
    await mkdir(festival);
    await writeFile(join(festival, "fest.yaml"), "id: finalized\n");
    await recordFestivalCreation(receipt, festival);
    await mkdir(join(root, ".ompfest", "plans"), { recursive: true });
    await writeFile(join(root, planPath), "# Approved plan\n");
    await writeFile(join(root, `${planPath}.status.json`), JSON.stringify({ state: "scaffolded", festivalDir: festival }));
    const { pi, commands, sent, ctx } = mockPi(root);
    Object.assign(ctx.ui, { confirm: vi.fn(() => Promise.resolve(true)) });
    ompFest(pi as never);
    await commands.get("fest")?.handler(`orphans rollback ${receipt.id}`, ctx);
    expect(sent.at(-1)?.message.content).toContain("Finalized validated festival finalized");
    expect(await readFile(join(festival, "fest.yaml"), "utf8")).toBe("id: finalized\n");
    await expect(readFile(join(festival, ".omp-fest-creation.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(receipt.journalPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await listQuarantinedFestivals(root)).toEqual([]);
  });

  it("keeps a new omp session unselected even when the camp contains an active festival", async () => {
    const root = await makeCamp();
    const active = join(root, "festivals", "active", "other-session-festival");
    await mkdir(active, { recursive: true });
    await writeFile(join(active, "fest.yaml"), "id: other-session-festival\nname: Other session festival\n");
    const { pi, handlers, ctx } = mockPi(root);
    ompFest(pi as never);
    const hook = handlers.get("before_agent_start") as (
      event: unknown,
      ctx: unknown,
    ) => Promise<{ message?: { customType: string; content: string; display: boolean } } | undefined>;
    const result = await hook({}, ctx);
    expect(result?.message?.customType).toBe("fest-state");
    expect(result?.message?.content).toContain("no active festival");
    expect(result?.message?.content).toContain("This session is explicitly unselected.");
    expect(result?.message?.content).not.toContain("festival=other-session-festival");
  });

  it("before_agent_start digest stays silent outside a camp", async () => {
    const { pi, handlers, ctx } = mockPi("/tmp");
    ompFest(pi as never);
    const hook = handlers.get("before_agent_start") as (
      event: unknown,
      ctx: unknown,
    ) => Promise<unknown>;
    expect(await hook({}, ctx)).toBeUndefined();
  });

  it("completers return AutocompleteItem-shaped results or null outside camps", async () => {
    const root = await makeCamp();
    const { pi, commands } = mockPi(root);
    ompFest(pi as never);
    const festNext = commands.get("fest-next");
    const result = await festNext?.getArgumentCompletions?.("");
    if (result !== null && result !== undefined) {
      for (const item of result) {
        expect(item).toHaveProperty("value");
        expect(item).toHaveProperty("label");
      }
    }
    const festCmd = commands.get("fest");
    const actions = await festCmd?.getArgumentCompletions?.("d");
    const values = actions?.map((a) => a.value) ?? [];
    expect(values).toContain("done");
    expect(values).toContain("defer");
    expect(values).toContain("doctor");
  });

  it("/fest plan kicks off a guided interview instead of a static guide", async () => {
    const root = await makeCamp();
    const { pi, commands, userMessages, ctx } = mockPi(root);
    ompFest(pi as never);
    const handler = commands.get("fest")?.handler;
    await handler?.("plan restructure prenatal form", ctx);
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]).toContain("interview");
    expect(userMessages[0]).toContain("New planning is independent");
  });

  it("passes images through the input hook when /fest plan has an attachment", async () => {
    const root = await makeCamp();
    const { pi, handlers, ctx, userMessages } = mockPi(root);
    ompFest(pi as never);
    const hook = handlers.get("input") as (event: unknown, context: unknown) => { text: string } | undefined;
    const screenshot = { type: "image", data: "opaque-image" };
    const event = { type: "input", text: "/fest plan build this page", images: [screenshot], source: "interactive" };
    const result = hook(event, ctx);
    expect(result?.text).toContain("build this page");
    expect(result?.text).toContain("wireframe.svg");
    expect(result?.text).toContain("original viewport");
    expect(result?.text).toContain("same route at the original viewport");
    expect(event.images).toEqual([screenshot]);
    expect(userMessages).toEqual([]);
    expect(hook({ ...event, text: "/fest next" }, ctx)).toBeUndefined();
    expect(hook({ ...event, images: [] }, ctx)).toBeUndefined();
  });

  it("does not turn PDF or diagnostic images into wireframe plans", async () => {
    const root = await makeCamp();
    const { pi, handlers, ctx } = mockPi(root);
    ompFest(pi as never);
    const hook = handlers.get("input") as (event: unknown, context: unknown) => { text: string } | undefined;
    const pdfEvent = { type: "input", text: "/fest plan fix this PDF export", images: [{ type: "image", data: "opaque-image" }], source: "interactive" };
    const pdfResult = hook(pdfEvent, ctx);
    expect(pdfResult?.text).toContain("Classified image role: document_or_pdf");
    expect(pdfResult?.text).toContain("Do not call fest_wireframe_create");
    expect(pdfResult?.text).toContain("prohibited");
    const errorEvent = { type: "input", text: "/fest plan investigate this error screenshot", images: [{ type: "image", data: "opaque-image" }], source: "interactive" };
    expect(hook(errorEvent, ctx)?.text).toContain("Classified image role: bug_diagnostic");
  });
  it("/fest select claims a festival and requires confirmation before transfer", async () => {
    const root = await makeCamp();
    const festival = join(root, "festivals", "active", "chosen");
    await mkdir(festival, { recursive: true });
    await writeFile(join(festival, "fest.yaml"), "id: chosen\nname: Chosen\n");
    const first = mockPi(root);
    (first.ctx as Record<string, unknown>).sessionManager = { getSessionId: () => "session-a" };
    ompFest(first.pi as never);
    await first.commands.get("fest")?.handler("select chosen", first.ctx);
    expect(first.sent.at(-1)?.message.content).toContain("Selected chosen");

    const second = mockPi(root);
    (second.ctx as Record<string, unknown>).sessionManager = { getSessionId: () => "session-b" };
    const confirm = vi.fn(() => Promise.resolve(false));
    (second.ctx.ui as Record<string, unknown>).confirm = confirm;
    ompFest(second.pi as never);
    await second.commands.get("fest")?.handler("select chosen", second.ctx);
    expect(second.sent.at(-1)?.message.content).toContain("Ownership unchanged");
    expect(confirm).toHaveBeenCalled();
    await second.commands.get("fest")?.handler("join chosen", second.ctx);
    expect(second.sent.at(-1)?.message.content).toContain("Joined chosen");
    expect((await festivalOwner(festival))?.sessionId).toBe("session-a");
    const start = second.handlers.get("before_agent_start") as (event: unknown, context: unknown) => Promise<{ message?: { content: string } } | undefined>;
    const prompt = await start({}, second.ctx);
    expect(prompt?.message?.content).toContain("festival collaborator");
    expect(prompt?.message?.content).toContain("fest_team queue");
  });

  it("/fest idea without text interviews the user first", async () => {
    const root = await makeCamp();
    const { pi, commands, userMessages, ctx } = mockPi(root);
    ompFest(pi as never);
    await commands.get("fest")?.handler("idea", ctx);
    expect(userMessages[0]).toContain("idea-capture interview");
  });

  it("/fest settings lists keys and toggles booleans into .ompfest.json", async () => {
    const root = await makeCamp();
    const { pi, commands, sent, ctx } = mockPi(root);
    ompFest(pi as never);
    const handler = commands.get("fest")?.handler;
    await handler?.("settings", ctx);
    expect(sent.at(-1)?.message.content).toContain("statusLine");
    expect(sent.at(-1)?.message.content).toContain("watchTransitions");
    await handler?.("settings statusLine", ctx);
    expect(sent.at(-1)?.message.content).toContain("statusLine = false");
    const saved = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(join(root, ".ompfest.json"), "utf8")),
    ) as Record<string, unknown>;
    expect(saved.statusLine).toBe(false);
    await handler?.("settings gateNotify none", ctx);
    expect(sent.at(-1)?.message.content).toContain("gateNotify = []");
    await handler?.("settings bogus", ctx);
    expect(sent.at(-1)?.message.content).toContain("Unknown setting");
  });

  it("/fest dashboard floats via ui.custom when available, text otherwise", async () => {
    const root = await makeCamp();
    const { pi, commands, sent, ctx } = mockPi(root);
    ompFest(pi as never);
    const handler = commands.get("fest")?.handler;
    // No ui.custom → plain transcript fallback
    await handler?.("", ctx);
    expect(sent.at(-1)?.message.content).toContain("No festivals yet");
    // With ui.custom the dashboard goes to the overlay instead of the transcript
    const customCalls: unknown[] = [];
    (ctx.ui as Record<string, unknown>).custom = (factory: unknown, options: unknown) => {
      customCalls.push(options);
      (factory as (t: null, th: null, k: null, done: (r: string) => void) => unknown)(null, null, null, () => "closed");
      return Promise.resolve("closed");
    };
    const before = sent.length;
    await handler?.("", ctx);
    expect(customCalls.length).toBe(1);
    expect(sent.length).toBe(before);
  });

  it("/fest settings interactive loop toggles a bool via ui.select", async () => {
    const root = await makeCamp();
    const { pi, commands, ctx } = mockPi(root);
    ompFest(pi as never);
    const picks = ["statusLine", "done"];
    const select = vi.fn(() => Promise.resolve(picks.shift()));
    (ctx.ui as Record<string, unknown>).select = select;
    await commands.get("fest")?.handler("settings", ctx);
    expect(select).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(join(root, ".ompfest.json"), "utf8")),
    ) as Record<string, unknown>;
    expect(saved.statusLine).toBe(false);
  });

  it("before_agent_start sets the progress widget in a camp and clears it outside", async () => {
    const root = await makeCamp();
    const { pi, handlers, ctx } = mockPi(root);
    const widgets: Record<string, unknown> = {};
    (ctx.ui as Record<string, unknown>).setWidget = (key: string, content: unknown) => {
      widgets[key] = content;
    };
    ompFest(pi as never);

    await handlers.get("before_agent_start")?.({}, ctx);
    expect(String(widgets.ompfest)).toContain("camp=");
    const outer = { cwd: "/tmp", ui: ctx.ui };
    await handlers.get("before_agent_start")?.({}, outer);
    expect(widgets.ompfest).toBeUndefined();
  });
  it("mirrors native worker failures and releases the failed team claim", async () => {
    const root = await makeCamp();
    const festival = join(root, "festivals", "active", "festival-a");
    await mkdir(festival, { recursive: true });
    await writeFile(join(festival, "fest.yaml"), "id: festival-a\n");
    const owner = await claimFestivalOwnership(festival, "portfolio-session");
    if (owner.kind !== "claimed") throw new Error(`Cannot claim test festival: ${owner.kind}`);
    await joinFestivalTeam(root, festival, "portfolio-session", "portfolio-session");
    const teamAssignment = await claimFestivalTask(root, festival, "portfolio-session", "task-a", root, "worker-a");
    const id = teamAssignment.id;
    const { pi, handlers, ctx } = mockPi(root);
    const branch = [{
      type: "custom",
      customType: SUPERVISOR_ENTRY,
      data: {
        paused: false,
        workers: [{
          id, festival: "festival-a", task: "task-a", worker: "worker-a", files: [],
          status: "running", report: "", review: "",
          runtime: {
            status: "running", source: "native_runtime", runtimeId: "native-job-a",
            observedAt: "2026-01-01T00:00:00.000Z",
          },
        }],
      },
    }];
    (ctx as Record<string, unknown>).sessionManager = {
      getSessionId: () => "portfolio-session",
      getBranch: () => branch,
    };
    (ctx as Record<string, unknown>).getAsyncJobSnapshot = () => ({
      running: [],
      recent: [{ id: "native-job-a", type: "task", status: "failed", label: "worker-a" }],
    });
    await reservePortfolioAssignment(root, {
      id, festival: "festival-a", task: "task-a", sessionId: "portfolio-session",
      worker: "worker-a", workingDir: root, files: [],
    });
    await updatePortfolioAssignment(root, id, "running");
    ompFest(pi as never);
    await handlers.get("session_tree")?.({}, ctx);
    await handlers.get("before_agent_start")?.({}, ctx);
    const assignment = (await readPortfolioState(root)).assignments.find((row) => row.id === id);
    expect(assignment?.status).toBe("failed");
    expect(assignment?.runtimeId).toBe("native-job-a");
    expect(assignment?.runtimeStatus).toBe("failed");
    expect(assignment?.runtimeObservedAt).not.toBe("2026-01-01T00:00:00.000Z");
    expect((await readFestivalTeam(root, festival))?.assignments.every((row) => row.status === "released")).toBe(true);
  });

  it.each([
    ["claimed", true],
    ["submitted", true],
    ["released", false],
    ["accepted", false],
  ] as const)("/fest task done gates only active team assignments (%s)", async (status, blocked) => {
    const root = await makeCamp();
    const festival = join(root, "festivals", "active", "team-completion");
    await mkdir(festival, { recursive: true });
    await writeFile(join(festival, "fest.yaml"), "id: team-completion\n");
    const coordinator = "team-coordinator";
    const owner = await claimFestivalOwnership(festival, coordinator);
    if (owner.kind !== "claimed") throw new Error(`Cannot claim test festival: ${owner.kind}`);
    await joinFestivalTeam(root, festival, coordinator, coordinator);
    const assignment = await claimFestivalTask(root, festival, coordinator, "task-a", root, "worker-a");
    if (status === "submitted" || status === "accepted") {
      await submitFestivalTask(root, festival, coordinator, assignment.id, "verified worker evidence");
    }
    if (status === "accepted") await reviewFestivalTask(root, festival, coordinator, assignment.id, "accept", "reviewed evidence");
    if (status === "released") await releaseFestivalTask(root, festival, coordinator, assignment.id, "no longer needed");
    const { pi, commands, toolExecutors, sent, ctx } = mockPi(root);
    (ctx as Record<string, unknown>).agent = { kind: "main" };
    (ctx as Record<string, unknown>).sessionManager = { getSessionId: () => coordinator };
    ompFest(pi as never);
    await commands.get("fest")?.handler("select team-completion", ctx);
    await commands.get("fest")?.handler("task done --evidence verified", ctx);
    const message = sent.at(-1)?.message.content ?? "";
    expect(message.includes("a joined worker still owns or has submitted this task")).toBe(blocked);
    const complete = toolExecutors.get("fest_task_complete");
    if (!complete) throw new Error("Missing fest_task_complete tool");
    const result = await complete("test", { task: "task-a", evidence: "verified" }, undefined, undefined, ctx);
    const payload = JSON.parse(result.content[0]!.text) as { kind?: string; hint?: string };
    expect(payload.kind === "completion_blocked" && payload.hint?.includes("joined session still owns")).toBe(blocked);
    expect((await readFestivalTeam(root, festival))?.assignments[0]?.status).toBe(status);
  });

  it("/fest reports dormant state when no festival exists", async () => {
    const root = await makeCamp();
    await writeFile(join(root, "AGENTS.md"), "# camp");
    const { pi, commands, sent, ctx } = mockPi(root);
    ompFest(pi as never);
    const handler = commands.get("fest")?.handler;
    await handler?.("", ctx);
    expect(sent.at(-1)?.message.content).toContain("Camp:");
    expect(sent.at(-1)?.message.content).toContain("No festivals yet");
  });

  it("restores the session's claimed festival on session_start — status line follows it", async () => {
    const root = await makeCamp();
    for (const id of ["fest-a", "fest-b"]) {
      const dir = join(root, "festivals", "active", id);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "fest.yaml"), `id: ${id}\n`);
    }
    const { pi, handlers, ctx, statuses } = mockPi(root);
    ompFest(pi as never);
    const sessionCtx = {
      ...ctx,
      sessionManager: {
        getSessionId: () => "sess-1",
        getBranch: () => [
          {
            type: "custom",
            customType: "com.github.mohammadraufzahed.omp-fest.festival",
            data: { festivalId: "fest-b", festivalDir: "/stale/path/fest-b" },
          },
        ],
      },
    };
    const start = handlers.get("session_start") as (e: unknown, c: unknown) => Promise<void>;
    await start({}, sessionCtx);
    // fest-b was claimed even though fest-a wins the camp-wide alphabetical pick.
    expect(statuses["omp-fest"]).toContain("fest-b");
  });
});

it("registers no session_compact handler — the per-turn digest covers it", async () => {
  const root = await makeCamp();
  const { pi, handlers } = mockPi(root);
  ompFest(pi as never);
  expect(handlers.get("session_compact")).toBeUndefined();
});

it("continues the festival after each successful task commit", async () => {
  const root = await makeCamp();
  const { pi, handlers, ctx } = mockPi(root);
  ompFest(pi as never);
  const hook = handlers.get("tool_result") as (
    event: unknown,
    ctx: unknown,
  ) => Promise<{ additionalContext?: string } | undefined>;

  const next = await hook({ toolName: "fest_commit", isError: false }, ctx);
  const failed = await hook({ toolName: "fest_commit", isError: true }, ctx);

  expect(next?.additionalContext?.toLowerCase()).toContain("immediately call fest_next");
  expect(next?.additionalContext).toContain("kind 'complete'");
  expect(next?.additionalContext).toContain("human approval");
  expect(failed).toBeUndefined();
});

it("tool_result hook warns on untracked edits and dedupes per path", async () => {
  const root = await makeCamp();
  const festivalDir = join(root, "festivals", "active", "fest-A1");
  await mkdir(join(festivalDir, "001_P", "01_seq"), { recursive: true });
  await writeFile(join(festivalDir, "fest.yaml"), "festival: fest-A1\n");
  await writeFile(
    join(festivalDir, "001_P", "01_seq", "01_task.md"),
    "---\nfest_type: task\n---\n# Task\n",
  );
  const { pi, handlers, commands, ctx } = mockPi(root);
  ompFest(pi as never);
  await commands.get("fest")?.handler("select fest-A1", ctx);
  const hook = handlers.get("tool_result") as (
    event: unknown,
    ctx: unknown,
  ) => Promise<{ additionalContext?: string } | undefined>;
  const edit = { toolName: "edit", input: { path: join(root, "projects", "p", "x.ts") }, isError: false };
  const first = await hook(edit, ctx);
  expect(first?.additionalContext).toContain("fest_next");
  expect(await hook(edit, ctx)).toBeUndefined();
  const inside = { toolName: "edit", input: { path: join(festivalDir, "001_P", "01_seq", "01_task.md") }, isError: false };
  expect(await hook(inside, ctx)).toBeUndefined();
  const wireframe = { toolName: "write", input: { path: join(root, ".ompfest", "plans", "new.references", "pages", "results", "wireframe.svg") }, isError: false };
  expect(await hook(wireframe, ctx)).toBeUndefined();
  const failed = { ...edit, isError: true };
  expect(await hook(failed, ctx)).toBeUndefined();
});

it("locks exact files only during native write tool execution", async () => {
  const root = await makeCamp();
  const project = join(root, "projects", "app");
  const target = join(project, "src", "feature.ts");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  const { pi, handlers, ctx } = mockPi(root);
  ompFest(pi as never);
  const before = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;
  const after = handlers.get("tool_result") as (event: unknown, ctx: unknown) => Promise<unknown>;
  let session = "writer-a";
  const context = { ...ctx, sessionManager: { getSessionId: () => session } };
  const write = { toolName: "edit", toolCallId: "write-a", input: { path: target } };

  expect(await before(write, context)).toBeUndefined();
  expect(await listProjectReservations(project)).toHaveLength(1);
  session = "writer-b";
  const different = { toolName: "edit", toolCallId: "write-b", input: { path: join(project, "src", "other.ts") } };
  expect(await before(different, context)).toBeUndefined();
  await after({ ...different, isError: false }, context);
  const blocked = await before(write, context);
  expect(blocked?.block).toBe(true);
  expect(blocked?.reason).toContain(target);

  session = "writer-a";
  await after({ ...write, isError: true }, context);
  expect(await listProjectReservations(project)).toEqual([]);
  session = "writer-b";
  expect(await before(write, context)).toBeUndefined();
  await after({ ...write, isError: false }, context);
  expect(await listProjectReservations(project)).toEqual([]);
});
it("allows explicit festival-document writes without a project lock", async () => {
  const root = await makeCamp();
  const festivalDir = join(root, "festivals", "active", "example-EH0001");
  const target = join(festivalDir, "FESTIVAL_GOAL.md");
  await mkdir(festivalDir, { recursive: true });
  await writeFile(target, "# Existing festival goal\n");
  const { pi, handlers, ctx } = mockPi(root);
  ompFest(pi as never);
  const before = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;

  const result = await before({ toolName: "write", toolCallId: "festival-write", input: { path: "festivals/active/example-EH0001/FESTIVAL_GOAL.md" } }, ctx);
  expect(result).toBeUndefined();
});

it("still requires an explicit path for native writes", async () => {
  const root = await makeCamp();
  const { pi, handlers, ctx } = mockPi(root);
  ompFest(pi as never);
  const before = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;

  const result = await before({ toolName: "write", toolCallId: "pathless-write", input: { content: "x" } }, ctx);
  expect(result?.block).toBe(true);
  expect(result?.reason).toContain("target path is missing");
});
it("allows the supported frozen pnpm install under a transient checkout lock", async () => {
  const root = await makeCamp();
  const project = join(root, "projects", "worktrees", "modules-monorepo");
  const workingDir = join(project, "employee-health-mock-contract-cleanup");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(workingDir, { recursive: true });
  await writeFile(join(workingDir, "package.json"), JSON.stringify({ name: "employee-health-client" }));
  const { pi, handlers, ctx } = mockPi(root);
  ompFest(pi as never);
  const before = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;
  const after = handlers.get("tool_result") as (event: unknown, ctx: unknown) => Promise<unknown>;
  const event = {
    toolName: "bash",
    toolCallId: "pnpm-install",
    input: { command: "cd projects/worktrees/modules-monorepo/employee-health-mock-contract-cleanup && corepack pnpm install --filter employee-health-client... --frozen-lockfile" },
  };

  expect(await before(event, ctx)).toBeUndefined();
  expect(await listProjectReservations(project)).toMatchObject([{ files: [], worker: "bash" }]);
  await after({ ...event, isError: false }, ctx);
  expect(await listProjectReservations(project)).toEqual([]);
});


it("tool_call hook nudges raw fest bash + ad hoc todos inside a camp", async () => {
  const root = await makeCamp();
  const { pi, handlers, ctx } = mockPi(root);
  ompFest(pi as never);
  const hook = handlers.get("tool_call") as (
    event: unknown,
    ctx: unknown,
  ) => Promise<{ block?: boolean; reason?: string; additionalContext?: string } | undefined>;
  const festBash = await hook({ toolName: "bash", input: { command: "fest next" } }, ctx);
  expect(festBash?.additionalContext).toContain("fest_*");
  const todo = await hook({ toolName: "todo", input: {} }, ctx);
  expect(todo?.additionalContext).toContain("festival plan");
  const shellWrite = await hook({ toolName: "bash", input: { command: "cat > src/file.ts" } }, ctx);
  expect(shellWrite?.block).toBe(true);
  const ownTool = await hook({ toolName: "fest_next", input: {} }, ctx);
  expect(ownTool).toBeUndefined();
});

it("tool_call hook lets all writes and installs through when writeLocks is false", async () => {
  const root = await makeCamp();
  await writeFile(join(root, ".ompfest.json"), JSON.stringify({ writeLocks: false }));
  const { pi, handlers, ctx } = mockPi(root);
  ompFest(pi as never);
  const hook = handlers.get("tool_call") as (
    event: unknown,
    ctx: unknown,
  ) => Promise<{ block?: boolean; reason?: string } | undefined>;
  expect(await hook({ toolName: "bash", input: { command: "cat > src/file.ts" } }, ctx)).toBeUndefined();
  expect(await hook({ toolName: "bash", input: { command: "rm -rf src/legacy" } }, ctx)).toBeUndefined();
  expect(await hook({ toolName: "write", input: { path: join(root, "src/new.ts") } }, ctx)).toBeUndefined();
});

it("ignores scheme-like pseudo paths in write targets", async () => {
  const root = await makeCamp();
  const project = join(root, "projects", "mod");
  const target = join(project, "src", "real.ts");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  const { pi, handlers, ctx } = mockPi(root);
  ompFest(pi as never);
  const hook = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>;

  const event = { toolName: "write", toolCallId: "scheme-write", input: { paths: ["xd:/fest_raw", target] } };
  expect(await hook(event, ctx)).toBeUndefined();
  const reservations = await listProjectReservations(project);
  expect(reservations).toHaveLength(1);
  expect(reservations[0]!.files).toEqual(["src/real.ts"]);
});

it("fest_orphans lists a dead journal and rolls it back end to end", async () => {
  const root = await makeCamp();
  await mkdir(join(root, "festivals", "planning"), { recursive: true });
  const plan = join(root, "plan.md");
  await writeFile(plan, "# plan\n");
  const receipt = await beginFestivalCreation(root, "tool-orphan", plan, "session-1");
  // Simulate the scaffold process dying: same host, dead pid.
  const journal = JSON.parse(await readFile(receipt.journalPath, "utf8")) as Record<string, unknown>;
  let pid = 4_000_000;
  while (processIsAlive(pid)) pid -= 1_000_000;
  journal.pid = pid;
  journal.host = hostname();
  await writeFile(receipt.journalPath, JSON.stringify(journal));
  const { pi, toolExecutors, ctx } = mockPi(root);
  ompFest(pi as never);
  const orphans = toolExecutors.get("fest_orphans")!;

  const listed = JSON.parse((await orphans("id", { action: "list" }, undefined, undefined, ctx)).content[0]!.text) as { journals: { transaction: string; state: string; live: boolean }[] };
  expect(listed.journals).toMatchObject([{ transaction: receipt.id, state: "stale", live: false }]);

  const rolled = JSON.parse((await orphans("id", { action: "rollback", transaction: receipt.id }, undefined, undefined, ctx)).content[0]!.text) as { kind: string };
  expect(rolled.kind).toBe("orphan_cleared");
  const relisted = JSON.parse((await orphans("id", { action: "list" }, undefined, undefined, ctx)).content[0]!.text) as { journals: unknown[] };
  expect(relisted.journals).toHaveLength(0);
});

it("tool_call hook stays silent outside a camp", async () => {
  const { pi, handlers, ctx } = mockPi("/tmp");
  ompFest(pi as never);
  const hook = handlers.get("tool_call") as (
    event: unknown,
    ctx: unknown,
  ) => Promise<{ additionalContext?: string } | undefined>;
  expect(await hook({ toolName: "bash", input: { command: "fest next" } }, ctx)).toBeUndefined();
  expect(await hook({ toolName: "todo", input: {} }, ctx)).toBeUndefined();
});

it("advertises lifecycle controls and requires explicit selection before approval", async () => {
  const root = await makeCamp();
  const { pi, commands, sent, ctx } = mockPi(root);
  ompFest(pi as never);

  await commands.get("fest")?.handler("help", ctx);
  const help = sent.at(-1)?.message.content ?? "";
  for (const action of ["next", "task", "promote", "workflow", "approve", "reject"]) {
    expect(help).toContain(`/fest ${action}`);
  }
  await commands.get("fest")?.handler("approve", ctx);
  expect(sent.at(-1)?.message.content).toContain("No festival selected");
});

it("restores terminal native failure without making the failed runtime retryable", async () => {
  const root = await makeCamp();
  const festival = join(root, "festivals", "active", "festival-restore");
  await mkdir(festival, { recursive: true });
  await writeFile(join(festival, "fest.yaml"), "id: festival-restore\n");
  await claimFestivalOwnership(festival, "restore-session");
  await joinFestivalTeam(root, festival, "restore-session", "restore-session");
  const first = await claimFestivalTask(root, festival, "restore-session", "task-a", root, "worker-a");
  const second = await claimFestivalTask(root, festival, "restore-session", "task-b", root, "worker-b");
  const { pi, handlers, ctx } = mockPi(root);
  (ctx as Record<string, unknown>).sessionManager = {
    getSessionId: () => "restore-session",
    getBranch: () => [{
      type: "custom",
      customType: SUPERVISOR_ENTRY,
      data: {
        paused: true,
        workers: [{
          id: first.id, festival: "festival-restore", task: "task-a", worker: "worker-a", files: [],
          status: "running", report: "", review: "",
          runtime: { status: "running", source: "native_runtime", runtimeId: "failed-runtime", observedAt: "2026-01-01T00:00:00.000Z" },
        }],
      },
    }],
  };
  (ctx as Record<string, unknown>).getAsyncJobSnapshot = () => ({
    running: [],
    recent: [{ id: "failed-runtime", type: "task", status: "failed", label: "worker-a" }],
  });
  await reservePortfolioAssignment(root, {
    id: first.id, festival: "festival-restore", task: "task-a", sessionId: "restore-session",
    worker: "worker-a", workingDir: root, files: [],
  });
  await updatePortfolioAssignment(root, first.id, "running");
  ompFest(pi as never);
  await handlers.get("session_tree")?.({}, ctx);
  await handlers.get("before_agent_start")?.({}, ctx);

  const state = await readPortfolioState(root);
  expect(state.assignments.find((row) => row.id === first.id)?.status).toBe("failed");
  expect(state.assignments.find((row) => row.id === first.id)?.runtimeStatus).toBe("failed");
  expect((await readFestivalTeam(root, festival))?.assignments.filter((row) => row.status !== "released").map((row) => row.id)).toEqual([second.id]);
});

it("serializes repeated native write events and releases each lock", async () => {
  const root = await makeCamp();
  const project = join(root, "projects", "repeat-write");
  const target = join(project, "src", "feature.ts");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, "src"), { recursive: true });
  const { pi, handlers, ctx } = mockPi(root);
  ompFest(pi as never);
  const before = handlers.get("tool_call") as (event: unknown, ctx: unknown) => Promise<{ block?: boolean } | undefined>;
  const after = handlers.get("tool_result") as (event: unknown, ctx: unknown) => Promise<unknown>;
  const event = { toolName: "edit", toolCallId: "repeat-write", input: { path: target } };

  expect(await before(event, ctx)).toBeUndefined();
  expect((await before(event, ctx))?.block).toBe(true);
  expect(await listProjectReservations(project)).toHaveLength(1);
  await after({ ...event, isError: false }, ctx);
  expect(await listProjectReservations(project)).toEqual([]);
  expect(await before(event, ctx)).toBeUndefined();
  expect(await listProjectReservations(project)).toHaveLength(1);
  await after({ ...event, isError: true }, ctx);
  expect(await listProjectReservations(project)).toEqual([]);
});

it("keeps final quality evidence with the owning supervisor", async () => {
  const root = await makeCamp();
  const festival = join(root, "festivals", "active", "quality-owned");
  await mkdir(festival, { recursive: true });
  await writeFile(join(festival, "fest.yaml"), "id: quality-owned\n");
  await claimFestivalOwnership(festival, "owner-session");
  const { pi, toolExecutors } = mockPi(root);
  ompFest(pi as never);
  const record = toolExecutors.get("fest_integration");
  if (!record) throw new Error("Missing fest_integration tool");
  const result = await record("test", {
    action: "record", festival: "quality-owned", summary: "worker attempt",
    checks: [{ id: "integration", status: "verified", proof: "worker ran it" }],
  }, undefined, undefined, {
    cwd: root, agent: { kind: "main" }, sessionManager: { getSessionId: () => "worker-session" },
  });
  expect(JSON.parse(result.content[0]!.text) as unknown).toMatchObject({ kind: "integration_blocked" });
  const detect = { pendingTasks: () => Promise.resolve([]), listFestivals: () => Promise.resolve([]) };
  expect(await integrationReviewStatus(festival, detect as never)).toMatchObject({ status: "missing" });
  expect(await festivalOwner(festival)).toMatchObject({ sessionId: "owner-session" });
});

it("does not treat discovered browser tools as permission to expose credentials", async () => {
  const root = await makeCamp();
  const { pi, toolExecutors } = mockPi(root);
  (pi as Record<string, unknown>).getAllTools = () => [{ name: "browser_login", sourceInfo: { source: "mcp", name: "Playwright MCP" } }];
  (pi as Record<string, unknown>).getActiveTools = () => ["browser_login"];
  ompFest(pi as never);
  const capabilities = toolExecutors.get("fest_capabilities");
  const flow = toolExecutors.get("fest_flow");
  if (!capabilities || !flow) throw new Error("Missing browser flow adapter tools");
  const ctx = { cwd: root, agent: { kind: "sub" }, sessionManager: { getSessionId: () => "worker-session" } };
  const discovery: unknown = JSON.parse((await capabilities("test", {}, undefined, undefined, ctx)).content[0]!.text);
  expect(discovery).toMatchObject({ agentRole: "sub", browserMcp: [{ name: "browser_login", active: true }] });
  expect(discovery).not.toHaveProperty("nativeSubagent");
  const mainDiscovery: unknown = JSON.parse((await capabilities("test", {}, undefined, undefined, {
    cwd: root, agent: { kind: "main" }, sessionManager: { getSessionId: () => "main-session" },
  })).content[0]!.text);
  expect(mainDiscovery).toMatchObject({ agentRole: "main" });
  if (discovery && typeof discovery === "object" && "secretInjection" in discovery) {
    expect(discovery.secretInjection).toEqual(expect.stringContaining("no MCP secret injection"));
  }
  const denied: unknown = JSON.parse((await flow("test", { action: "run", id: "login" }, undefined, undefined, ctx)).content[0]!.text);
  expect(denied).toMatchObject({ kind: "flow_blocked", code: "MAIN_AGENT_REQUIRED" });
});

it("fest_advance on a bare camp points at fest_plan; camp_status reports an empty coordination view", async () => {
  const root = await makeCamp();
  const { pi, toolExecutors } = mockPi(root);
  ompFest(pi as never);
  const ctx = { cwd: root };
  const advance = toolExecutors.get("fest_advance"), status = toolExecutors.get("camp_status");
  if (!advance || !status) throw new Error("Missing flow-v2 tools");
  const step = JSON.parse((await advance("t", {}, undefined, undefined, ctx)).content[0]!.text) as { kind: string; nextAction: { tool: string } };
  expect(step.nextAction.tool).toBe("fest_plan");
  const camp = JSON.parse((await status("t", {}, undefined, undefined, ctx)).content[0]!.text) as { kind: string; festivals: unknown[]; orphans: unknown[] };
  expect(camp.kind).toBe("camp_status");
  expect(camp.festivals).toEqual([]);
});

it("camp_init reports an existing camp without invoking the CLI", async () => {
  const root = await makeCamp();
  const { pi, toolExecutors } = mockPi(root);
  ompFest(pi as never);
  const init = toolExecutors.get("camp_init");
  if (!init) throw new Error("Missing camp_init tool");
  const result = JSON.parse((await init("t", {}, undefined, undefined, { cwd: root })).content[0]!.text) as { kind: string };
  expect(result.kind).toBe("camp_initialized");
});

it("fest_capabilities contract:true returns the agent contract", async () => {
  const root = await makeCamp();
  const { pi, toolExecutors } = mockPi(root);
  ompFest(pi as never);
  const capabilities = toolExecutors.get("fest_capabilities");
  if (!capabilities) throw new Error("Missing fest_capabilities tool");
  const contract = JSON.parse((await capabilities("t", { contract: true }, undefined, undefined, { cwd: root })).content[0]!.text) as { kind: string; contract: string };
  expect(contract.kind).toBe("agent_contract");
  expect(contract.contract).toContain("fest_complete");
  expect(contract.contract.length).toBeGreaterThan(400);
});
