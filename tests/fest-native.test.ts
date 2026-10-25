import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readHandoff, writeHandoff, type HandoffInput } from "../src/application/handoff.js";
import { checkNativeChainEligibility } from "../src/application/native-chain.js";
import { containedPath, nativeResult, standaloneDirectory } from "../src/adapters/omp/fest-native-context.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const path = await mkdtemp(join(tmpdir(), "fest-native-")); roots.push(path); return path; }
function input(): HandoffInput {
  return { summary: "Implemented typed native surfaces", decisions: [{ decision: "Use native CLI state", rationale: "Avoid duplicate readiness models", rejectedAlternatives: ["Local workflow state"] }], changedFiles: [{ path: "src/feature.ts", change: "Added typed builder" }], checks: [{ command: "npm test", cwd: ".", status: "not_run", output: "Not run by worker; main integration pending", evidencePaths: [] }], failures: [], blockers: [], nextAction: "Run integrated tests and inspect actual output" };
}
describe("portable native handoff", () => {
  it("writes immutable festival-relative artifacts without inventing evidence", async () => {
    const directory = await root();
    const saved = await writeHandoff(directory, input());
    expect(saved.path).toBe(`.ompfest/handoffs/${saved.handoff.id}.json`);
    expect((await readHandoff(directory, saved.handoff.id)).checks[0]?.status).toBe("not_run");
    expect(JSON.parse(await readFile(join(directory, saved.path), "utf8"))).toMatchObject({ schema: "omp.fest.handoff/v1" });
  });
  it("rejects incomplete checks, path escapes and nonexistent evidence", async () => {
    const directory = await root();
    const report = input();
    report.checks = [{ command: "npm test", cwd: ".", status: "passed", output: "", evidencePaths: [] }];
    await expect(writeHandoff(directory, report)).rejects.toThrow("concrete");
    report.checks = [];
    report.changedFiles = [{ path: "../outside", change: "escape" }];
    await expect(writeHandoff(directory, report)).rejects.toThrow("festival-relative");
    report.changedFiles = [];
    report.checks = [{ command: "npm test", cwd: ".", status: "failed", output: "failure", evidencePaths: ["missing.json"] }];
    await expect(writeHandoff(directory, report)).rejects.toThrow();
  });
  it("rejects symlinked handoff storage", async () => {
    const directory = await root(); const outside = await root();
    await symlink(outside, join(directory, ".ompfest"));
    await expect(writeHandoff(directory, input())).rejects.toThrow("symlink");
  });
});
describe("native path boundaries", () => {
  it("rejects parent traversal, absolute paths and symlink escape", async () => {
    const directory = await root(); const outside = await root();
    await symlink(outside, join(directory, "escape"));
    await expect(containedPath(directory, "../file")).rejects.toThrow();
    await expect(containedPath(directory, outside)).rejects.toThrow();
    await expect(containedPath(directory, "escape/new.json")).rejects.toThrow("symlink");
    expect(await containedPath(directory, "new/child.json")).toBe(join(directory, "new/child.json"));
  });
  it("does not let standalone mode bypass festival authority", async () => {
    const directory = await root();
    await writeFile(join(directory, "fest.yaml"), "metadata: {}\n");
    await mkdir(join(directory, "nested"));
    await expect(standaloneDirectory({ cwd: directory }, "nested")).rejects.toThrow("festival mode");
  });
  it("retains nonzero CLI results and rejects malformed JSON", () => {
    expect(nativeResult({ code: 7, stdout: "partial", stderr: "bad" }, true)).toMatchObject({ kind: "native_failed", code: 7, stdout: "partial", stderr: "bad" });
    expect(nativeResult({ code: 0, stdout: "invalid", stderr: "" }, true)).toMatchObject({ kind: "native_invalid_json" });
  });
  it("preserves native warnings without losing a valid ritual result or a failure", () => {
    expect(nativeResult({ code: 0, stdout: 'Warning: auto-commit unavailable\n{"action":"ritual_run","success":true,"dest_path":"/fixture/active/run"}\n', stderr: "" }, true)).toMatchObject({ kind: "native_result", warning: "Warning: auto-commit unavailable", data: { action: "ritual_run", success: true, dest_path: "/fixture/active/run" } });
    expect(nativeResult({ code: 0, stdout: 'Warning: review needed\n{"ok":false,"error":"rejected"}\n', stderr: "" }, true)).toMatchObject({ kind: "native_failed", data: { ok: false } });
  });
});
describe("native chain readiness", () => {
  it("allows explicitly absent chains after guarded discovery", async () => {
    const directory = await root(); await writeFile(join(directory, "fest.yaml"), "metadata: {}\n");
    const raw = vi.fn().mockResolvedValue({ code: 0, stdout: '{"chains":[]}', stderr: "" });
    expect(await checkNativeChainEligibility({ raw }, directory)).toMatchObject({ allowed: true, kind: "not_in_chain" });
    expect(raw).toHaveBeenCalledTimes(1);
  });
  it("uses native checks and preserves blocked/failure results", async () => {
    const directory = await root(); await writeFile(join(directory, "fest.yaml"), "metadata: {}\n");
    const raw = vi.fn().mockResolvedValueOnce({ code: 0, stdout: '{"chains":[{"id":"CH0001"}]}', stderr: "" }).mockResolvedValueOnce({ code: 1, stdout: "Festival BLOCKED: prerequisite not completed", stderr: "" });
    expect(await checkNativeChainEligibility({ raw }, directory)).toMatchObject({ allowed: false, kind: "blocked", code: 1 });
  });
  it("fails closed on invalid external JSON and unknown success prose", async () => {
    const directory = await root(); await writeFile(join(directory, "fest.yaml"), "metadata: {}\n");
    expect(await checkNativeChainEligibility({ raw: () => Promise.resolve({ code: 0, stdout: '{"chains":[null]}', stderr: "" }) }, directory)).toMatchObject({ allowed: false, kind: "error" });
    const raw = vi.fn().mockResolvedValueOnce({ code: 0, stdout: '{"chains":[{"id":"CH0001"}]}', stderr: "" }).mockResolvedValueOnce({ code: 0, stdout: "Unknown native response", stderr: "" });
    expect(await checkNativeChainEligibility({ raw }, directory)).toMatchObject({ allowed: false, kind: "error" });
  });
});
