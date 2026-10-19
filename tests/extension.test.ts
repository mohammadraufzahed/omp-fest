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
      enum: (values: string[]) => ({ kind: "enum", values }),
      array: (item: unknown) => ({ kind: "array", item, describe: () => ({ kind: "array", item }), optional: () => ({ kind: "array", item }) }),
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

  it("/fest idea without text interviews the user first", async () => {
    const root = await makeCamp();
    const { pi, commands, userMessages, ctx } = mockPi(root);
    ompFest(pi as never);
    await commands.get("fest")?.handler("idea", ctx);
    expect(userMessages[0]).toContain("idea-capture interview");
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
