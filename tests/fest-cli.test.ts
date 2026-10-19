import { describe, expect, it, vi } from "vitest";
import { FestCliAdapter } from "@/adapters/cli/fest-cli.js";
import type { ExecResult, ExecRunner } from "@/ports.js";

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

  it("throws on non-zero mutations", async () => {
    const exec = fakeExec({ code: 1, stderr: "boom" });
    const fest = new FestCliAdapter(exec);
    await expect(fest.taskComplete("/f", "x.md")).rejects.toThrow("boom");
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
