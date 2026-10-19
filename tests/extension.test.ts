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
    setLabel: vi.fn(),
  };
  return { pi, handlers, commands, tools, sent, statuses, ctx };
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
    expect(tools).toHaveLength(11);
    expect([...commands.keys()].sort()).toEqual([
      "camp-idea",
      "fest",
      "fest-approve",
      "fest-doctor",
      "fest-next",
      "fest-parallel",
      "fest-reject",
      "fest-show",
      "fest-status",
      "fest-task",
    ]);
  });

  it("fires session_start orientation and hides the injected note", async () => {
    const root = await makeCamp();
    const { pi, handlers, sent, ctx } = mockPi(root);
    ompFest(pi as never);
    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeDefined();
    await sessionStart?.({}, ctx);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]?.message.customType).toBe("fest-orientation");
    expect(sent[0]?.message.display).toBe(false);
    expect(sent[0]?.options?.triggerTurn).toBe(false);
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
    const festTask = commands.get("fest-task");
    const actions = await festTask?.getArgumentCompletions?.("d");
    expect(actions?.map((a) => a.value)).toEqual(["done", "defer"]);
  });

  it("/fest reports dormant state when no festival exists", async () => {
    const root = await makeCamp();
    await writeFile(join(root, "AGENTS.md"), "# camp");
    const { pi, commands, sent, ctx } = mockPi(root);
    ompFest(pi as never);
    const handler = commands.get("fest")?.handler;
    await handler?.("", ctx);
    expect(sent.at(-1)?.message.content).toContain("Camp:");
    expect(sent.at(-1)?.message.content).toContain("No active festival");
  });
});
