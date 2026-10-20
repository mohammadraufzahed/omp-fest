/**
 * End-to-end smoke test: drives the real extension factory with a mock
 * ExtensionAPI matching @oh-my-pi/pi-coding-agent's actual signatures
 * (verified against upstream types), so API drift is caught here.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import ompFest from "../index.js";

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

function mockPi(cwd: string) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, RegisteredCommand>();
  const tools: { name: string }[] = [];
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
      object: (shape: Record<string, unknown>) => ({ shape }),
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
    registerTool: (tool: { name: string }) => tools.push(tool),
    registerCommand: (name: string, options: RegisteredCommand) => commands.set(name, options),
    sendMessage: (message: SentMessage["message"], options?: SentMessage["options"]) => {
      sent.push({ message, options });
    },
    sendUserMessage: (text: string) => {
      userMessages.push(text);
    },
    setLabel: vi.fn(),
  };
  return { pi, handlers, commands, tools, sent, userMessages, statuses, ctx };
}

async function makeCamp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ompfest-ext-"));
  await mkdir(join(root, "festivals", "active"), { recursive: true });
  await mkdir(join(root, "projects"), { recursive: true });
  return root;
}

describe("ompFest extension", () => {
  it("registers the fest toolset and slash commands", async () => {
    const root = await makeCamp();
    const { pi, commands, tools } = mockPi(root);
    ompFest(pi as never);
    expect(tools.map((t) => t.name)).toContain("fest_next");
    expect(tools.map((t) => t.name)).toContain("fest_parallel");
    expect(tools).toHaveLength(15);
    expect([...commands.keys()].sort()).toEqual(["fest"]);
  });

  it("injects a live state digest into every turn inside a camp", async () => {
    const root = await makeCamp();
    const { pi, handlers, ctx } = mockPi(root);
    ompFest(pi as never);
    const hook = handlers.get("before_agent_start") as (
      event: unknown,
      ctx: unknown,
    ) => Promise<{ message?: { customType: string; content: string; display: boolean } } | undefined>;
    const result = await hook({}, ctx);
    expect(result?.message?.customType).toBe("fest-state");
    expect(result?.message?.display).toBe(false);
    expect(result?.message?.content).toContain("fest:");
    expect(result?.message?.content).toContain("no active festival");
    expect(result?.message?.content).toContain("fest_next");
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
    expect(userMessages[0]).toContain("restructure prenatal form");
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
    expect(event.images).toEqual([screenshot]);
    expect(userMessages).toEqual([]);
    expect(hook({ ...event, text: "/fest next" }, ctx)).toBeUndefined();
    expect(hook({ ...event, images: [] }, ctx)).toBeUndefined();
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

it("tool_result hook warns on untracked edits and dedupes per path", async () => {
  const root = await makeCamp();
  const festivalDir = join(root, "festivals", "active", "fest-A1");
  await mkdir(join(festivalDir, "001_P", "01_seq"), { recursive: true });
  await writeFile(join(festivalDir, "fest.yaml"), "festival: fest-A1\n");
  await writeFile(
    join(festivalDir, "001_P", "01_seq", "01_task.md"),
    "---\nfest_type: task\n---\n# Task\n",
  );
  const { pi, handlers, ctx } = mockPi(root);
  ompFest(pi as never);
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

it("tool_call hook nudges raw fest bash + ad hoc todos inside a camp", async () => {
  const root = await makeCamp();
  const { pi, handlers, ctx } = mockPi(root);
  ompFest(pi as never);
  const hook = handlers.get("tool_call") as (
    event: unknown,
    ctx: unknown,
  ) => Promise<{ additionalContext?: string } | undefined>;
  const festBash = await hook({ toolName: "bash", input: { command: "fest next" } }, ctx);
  expect(festBash?.additionalContext).toContain("fest_*");
  const todo = await hook({ toolName: "todo", input: {} }, ctx);
  expect(todo?.additionalContext).toContain("festival plan");
  const ownTool = await hook({ toolName: "fest_next", input: {} }, ctx);
  expect(ownTool).toBeUndefined();
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
