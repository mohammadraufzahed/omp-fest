import { describe, expect, it, vi } from "vitest";
import { FestCliAdapter } from "../src/adapters/cli/fest-cli.js";
import type { ExecResult, ExecRunner } from "../src/ports.js";

function fakeExec(result: Partial<ExecResult>): ExecRunner & { calls: { command: string; args: string[]; cwd?: string }[] } {
  const calls: { command: string; args: string[]; cwd?: string }[] = [];
  return {
    calls,
    run: vi.fn((command: string, args: string[], cwd?: string) => {
      calls.push({ command, args, ...(cwd ? { cwd } : {}) });
      return Promise.resolve({ stdout: "", stderr: "", code: 0, ...result });
    }),
  };
}

describe("FestCliAdapter", () => {
  it("passes --yes --json on task completion", async () => {
    const exec = fakeExec({ stdout: '{"status":"completed"}' });
    const fest = new FestCliAdapter(exec);
    await fest.taskComplete("/f", "003/01/02.md");
    const call = exec.calls[0]!;
    expect(call.args).toContain("--yes");
    expect(call.args).toContain("--json");
    expect(call.cwd).toBe("/f");
  });

  it("injects --yes only for task mutations that confirm", async () => {
    const exec = fakeExec({});
    const fest = new FestCliAdapter(exec);
    await fest.raw("/f", ["task", "update", "01_task.md", "50%"]);
    expect(exec.calls[0]?.args).not.toContain("--yes");
    await fest.raw("/f", ["task", "blocked", "--list"]);
    expect(exec.calls[1]?.args).not.toContain("--yes");
    await fest.raw("/f", ["task", "completed", "01_task.md"]);
    expect(exec.calls[2]?.args).toContain("--yes");
  });
  it("uses only flags supported by each task subcommand", async () => {
    const exec = fakeExec({});
    const fest = new FestCliAdapter(exec);
    await fest.taskMutate("/f", "unblock", {});
    await fest.taskMutate("/f", "update", { percent: "50%" });
    await fest.taskMutate("/f", "unblock", { reason: "Retry the database query" });
    await fest.taskMutate("/f", "blocked", { reason: "Dependency service is unavailable" });
    await fest.taskMutate("/f", "defer", { reason: "Waiting for the vendor response" });
    await fest.taskMutate("/f", "reset", {});
    expect(exec.calls.map((call) => call.args)).toEqual([
      ["task", "unblock", "--json"],
      ["task", "update", "50%", "--json"],
      ["task", "unblock", "--note", "Retry the database query", "--json"],
      ["task", "blocked", "--reason", "Dependency service is unavailable", "--yes", "--json"],
      ["task", "defer", "--reason", "Waiting for the vendor response", "--yes", "--json"],
      ["task", "reset", "--yes", "--json"],
    ]);
  });

  it("rejects task mutation inputs that the fest CLI requires", async () => {
    const exec = fakeExec({});
    const fest = new FestCliAdapter(exec);
    await expect(fest.taskMutate("/f", "blocked", {})).rejects.toThrow("requires a reason");
    await expect(fest.taskMutate("/f", "defer", {})).rejects.toThrow("requires a reason");
    await expect(fest.taskMutate("/f", "update", {})).rejects.toThrow("requires a progress percentage");
    await expect(fest.taskMutate("/f", "reset", { reason: "not supported" })).rejects.toThrow("does not accept a reason");
    await expect(fest.taskMutate("/f", "update", { percent: "50%", reason: "not supported" })).rejects.toThrow("does not accept a reason");
    expect(exec.calls).toEqual([]);
  });


  it("extracts commit hash", async () => {
    const exec = fakeExec({ stdout: "COMMIT\nHash 0f973a9\n" });
    const fest = new FestCliAdapter(exec);
    expect(await fest.commit("/f", "msg")).toBe("0f973a9");
  });

  it("parses validate score", async () => {
    const exec = fakeExec({ stdout: "Score 90/100\n" });
    const fest = new FestCliAdapter(exec);
    expect((await fest.validate("/f")).score).toBe(90);
  });

  it("surfaces gate-blocked completion instead of throwing", async () => {
    const exec = fakeExec({ code: 1, stderr: "boom" });
    const fest = new FestCliAdapter(exec);
    const result = await fest.taskComplete("/f", "x.md");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("boom");
  });

  it("parses fest list --json across statuses", async () => {
    const exec = fakeExec({
      stdout: JSON.stringify({
        active: [{ name: "x-F1", path: "/c/festivals/active/x-F1", progress: 50, tokens: 100 }],
        total: 1,
      }),
    });
    const fest = new FestCliAdapter(exec);
    const list = await fest.list("/c");
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("active");
    expect(list[0]?.tokens).toBe(100);
  });
});
