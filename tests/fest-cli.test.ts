import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FestCliAdapter } from "../src/adapters/cli/fest-cli.js";
import type { ExecResult, ExecRunner } from "../src/ports.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

  it("uses native validation validity instead of inferring it from score", async () => {
    const fest = new FestCliAdapter(fakeExec({ stdout: JSON.stringify({ ok: true, valid: true, score: 90,
      markers_pending: true, issues: [{ level: "warning", path: "FESTIVAL_GOAL.md", message: "Markers pending" }] }) }));
    expect(await fest.validate("/f")).toMatchObject({ score: 90, valid: true, markersPending: true, errors: [] });
  });

  it("returns native validation errors when validation exits nonzero", async () => {
    const fest = new FestCliAdapter(fakeExec({ code: 1, stdout: JSON.stringify({ ok: true, valid: false, score: 95,
      markers_pending: false, issues: [{ level: "error", path: "01_task.md", message: "Missing requirement" }] }) }));
    expect(await fest.validate("/f")).toMatchObject({ score: 95, valid: false,
      errors: [{ file: "01_task.md", error: "Missing requirement", markers: [] }] });
  });

  it("does not turn a crashed validation command into a zero score", async () => {
    const fest = new FestCliAdapter(fakeExec({ code: 2, stderr: "cannot read festival" }));
    await expect(fest.validate("/f")).rejects.toThrow("cannot read festival");
  });

  it("requests JSON and parses the nested native task result", async () => {
    const exec = fakeExec({ stdout: '{"task":{"path":"/f/001_IMPLEMENT/01_core/01_task.md"},"location":{"festival_path":"/f"},"task_content":"Do work"}',
      stderr: "warning: optional configuration missing" });
    const unit = await new FestCliAdapter(exec).next("/f");
    expect(unit).toMatchObject({ kind: "task", path: "001_IMPLEMENT/01_core/01_task.md", doc: "Do work" });
    expect(exec.calls[0]?.args).toEqual(["next", "--json"]);
  });

  it.each(["advance", "status", "approve", "reject"])("propagates failed workflow %s", async (action) => {
    const fest = new FestCliAdapter(fakeExec({ code: 1, stderr: "checkpoint state unavailable" }));
    const operation = action === "advance" ? fest.workflowAdvance("/f")
      : action === "status" ? fest.workflowStatus("/f")
      : action === "approve" ? fest.workflowApprove("/f") : fest.workflowReject("/f", "Revise evidence");
    await expect(operation).rejects.toThrow("checkpoint state unavailable");
  });

  it("rejects structured workflow failures even when the process exits zero", async () => {
    const fest = new FestCliAdapter(fakeExec({ stdout: '{"ok":false,"errors":[{"message":"Approval refused"}]}' }));
    await expect(fest.workflowApprove("/f")).rejects.toThrow("Approval refused");
  });

  it("counts native created gate files rather than sequence updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-gates-count-"));
    temporaryDirectories.push(dir);
    await mkdir(join(dir, "gates"));
    const fest = new FestCliAdapter(fakeExec({ stdout: '{"ok":true,"summary":{"files_created":4,"sequences_updated":1}}' }));
    expect(await fest.gatesApply("/camp", dir)).toMatchObject({ created: 4 });
  });

  it("does not hide failed native gate application", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-gates-fail-"));
    temporaryDirectories.push(dir);
    await mkdir(join(dir, "gates"));
    const fest = new FestCliAdapter(fakeExec({ code: 1, stderr: "gate template missing" }));
    await expect(fest.gatesApply("/camp", dir)).rejects.toThrow("gate template missing");
  });

  it("does not report structured gate failures as success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-gates-json-fail-"));
    temporaryDirectories.push(dir);
    await mkdir(join(dir, "gates"));
    const fest = new FestCliAdapter(fakeExec({ stdout: '{"ok":false,"summary":{"files_created":0}}' }));
    await expect(fest.gatesApply("/camp", dir)).rejects.toThrow('"ok":false');
  });

  it("surfaces gate-blocked completion instead of throwing", async () => {
    const exec = fakeExec({ code: 1, stderr: "boom" });
    const fest = new FestCliAdapter(exec);
    const result = await fest.taskComplete("/f", "x.md");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("boom");
  });

  it("does not report structured completion failures as success", async () => {
    const fest = new FestCliAdapter(fakeExec({ stdout: '{"ok":false,"error":"gate refused"}' }));
    expect((await fest.taskComplete("/f", "x.md")).ok).toBe(false);
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
