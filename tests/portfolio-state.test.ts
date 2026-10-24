import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listStalePortfolioAssignments, readPortfolioState, recordPortfolioFestivalDispatch, releasePortfolioAssignment, reservePortfolioAssignment, setPortfolioPaused, setPortfolioWorkerLimit, updatePortfolioAssignment, updatePortfolioAssignmentRuntime } from "../src/application/portfolio-state.js";

const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "portfolio-state-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function input(id: string, task = `task-${id}`, festival = "festival-a") {
  return { id, festival, task, sessionId: `session-${id}`, worker: `worker-${id}`, workingDir: "/work", files: ["src/file.ts"] };
}

describe("portfolio state", () => {
  it("provides the empty default and persists dispatch, limits, and assignments across reads", async () => {
    const root = await fixture();
    expect(await readPortfolioState(root)).toEqual({ version: 1, workerLimit: 20, paused: false, assignments: [] });
    await setPortfolioWorkerLimit(root, 3);
    await recordPortfolioFestivalDispatch(root, "festival-a");
    await reservePortfolioAssignment(root, input("one"));
    const state = await readPortfolioState(root);
    expect(state).toMatchObject({ workerLimit: 3, lastFestival: "festival-a", assignments: [{ id: "one", status: "assigned" }] });
    expect((await lstat(join(root, ".ompfest", "portfolio.json"))).mode & 0o777).toBe(0o600);
  });
  it("persists pause, preserves existing assignments, and allows reservations after unpausing", async () => {
    const root = await fixture();
    await reservePortfolioAssignment(root, input("one"));
    const paused = await setPortfolioPaused(root, true);
    expect(paused.paused).toBe(true);
    expect((await readPortfolioState(root)).paused).toBe(true);
    const before = await readPortfolioState(root);
    await expect(reservePortfolioAssignment(root, input("two"))).rejects.toThrow("paused");
    expect(await readPortfolioState(root)).toEqual(before);
    expect((await setPortfolioPaused(root, false)).paused).toBe(false);
    await reservePortfolioAssignment(root, input("two"));
    expect((await readPortfolioState(root)).assignments.map((row) => row.id)).toEqual(["one", "two"]);
  });

  it("enforces the 20-worker cap across concurrent reservations", async () => {
    const root = await fixture();
    const attempts = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => reservePortfolioAssignment(root, input(`id-${i}`))));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(20);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(5);
    expect((await readPortfolioState(root)).assignments).toHaveLength(20);
  });

  it("validates limit boundaries and refuses reductions below active count", async () => {
    const root = await fixture();
    await expect(setPortfolioWorkerLimit(root, 0)).rejects.toThrow("integer");
    await expect(setPortfolioWorkerLimit(root, 21)).rejects.toThrow("integer");
    await expect(setPortfolioWorkerLimit(root, 1.5)).rejects.toThrow("integer");
    await setPortfolioWorkerLimit(root, 2);
    await reservePortfolioAssignment(root, input("one"));
    await reservePortfolioAssignment(root, input("two"));
    await expect(setPortfolioWorkerLimit(root, 1)).rejects.toThrow("below");
    await expect(setPortfolioWorkerLimit(root, 2)).resolves.toMatchObject({ workerLimit: 2 });
  });

  it("serializes duplicate task and assignment ID races", async () => {
    const root = await fixture();
    const taskRaces = await Promise.allSettled([
      reservePortfolioAssignment(root, input("a", "same-task")),
      reservePortfolioAssignment(root, input("b", "same-task")),
    ]);
    expect(taskRaces.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(taskRaces.filter((result) => result.status === "rejected")).toHaveLength(1);
    const idRace = await Promise.allSettled([
      reservePortfolioAssignment(root, input("same-id", "task-a", "festival-b")),
      reservePortfolioAssignment(root, input("same-id", "task-b", "festival-b")),
    ]);
    expect(idRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(idRace.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("updates lifecycle, report, failure, and runtime fields without leaking details between assignments", async () => {
    const root = await fixture();
    await reservePortfolioAssignment(root, input("first"));
    await reservePortfolioAssignment(root, input("second", "other-task"));
    expect(await updatePortfolioAssignment(root, "first", "running")).toMatchObject({ status: "running" });
    expect(await updatePortfolioAssignment(root, "first", "submitted", { report: "report text" })).toMatchObject({ status: "submitted", report: "report text" });
    expect(await updatePortfolioAssignment(root, "first", "running", { failure: "retrying" })).toMatchObject({ status: "running", report: "report text", failure: "retrying" });
    expect(await updatePortfolioAssignmentRuntime(root, "first", { runtimeId: "runtime-1", runtimeStatus: "running", runtimeObservedAt: "2026-10-24T00:00:00.000Z" })).toMatchObject({ runtimeId: "runtime-1", runtimeStatus: "running" });
    expect(await updatePortfolioAssignment(root, "second", "failed", { failure: "isolated" })).toMatchObject({ failure: "isolated" });
    expect(await readPortfolioState(root)).toMatchObject({ assignments: [
      { id: "first", report: "report text", failure: "retrying", runtimeId: "runtime-1" },
      { id: "second", failure: "isolated" },
    ] });
  });

  it("makes release terminal and keeps terminal assignments out of capacity", async () => {
    const root = await fixture();
    await setPortfolioWorkerLimit(root, 1);
    await reservePortfolioAssignment(root, input("first"));
    await expect(releasePortfolioAssignment(root, "first", "cancelled by operator")).resolves.toMatchObject({ status: "released", failure: "cancelled by operator" });
    await reservePortfolioAssignment(root, input("second"));
    await updatePortfolioAssignment(root, "second", "accepted");
    await reservePortfolioAssignment(root, input("third"));
    await updatePortfolioAssignment(root, "third", "failed");
    await reservePortfolioAssignment(root, input("fourth"));
    await expect(updatePortfolioAssignment(root, "first", "running")).rejects.toThrow("terminal");
    await expect(updatePortfolioAssignment(root, "missing", "running")).rejects.toThrow("Unknown");
  });

  it("keeps blocked assignments held without consuming worker capacity", async () => {
    const root = await fixture();
    await setPortfolioWorkerLimit(root, 1);
    await reservePortfolioAssignment(root, input("blocked-task", "task-a"));
    await updatePortfolioAssignment(root, "blocked-task", "blocked");
    const blocked = (await readPortfolioState(root)).assignments.find((row) => row.id === "blocked-task")!;
    expect(blocked.status).toBe("blocked");

    await reservePortfolioAssignment(root, input("other-task", "task-b", "festival-b"));
    await expect(reservePortfolioAssignment(root, input("duplicate-blocked", "task-a"))).rejects.toThrow("already active");
    await expect(setPortfolioWorkerLimit(root, 1)).resolves.toMatchObject({ workerLimit: 1 });

    const stale = await listStalePortfolioAssignments(root, 0, Date.now() + 1000);
    expect(stale.map((row) => row.id)).toContain("blocked-task");
    expect(stale.map((row) => row.id)).toContain("other-task");
  });

  it("lists stale active assignments without mutating them", async () => {
    const root = await fixture();
    await reservePortfolioAssignment(root, input("old"));
    await reservePortfolioAssignment(root, input("done"));
    await updatePortfolioAssignment(root, "done", "accepted");
    const before = await readFile(join(root, ".ompfest", "portfolio.json"), "utf8");
    const stale = await listStalePortfolioAssignments(root, 0, Date.now() + 1000);
    expect(stale.map((row) => row.id)).toEqual(["old"]);
    expect(await readFile(join(root, ".ompfest", "portfolio.json"), "utf8")).toBe(before);
  });

  it.each(["{", "null", "{}", '{"version":1,"workerLimit":21,"assignments":[]}'])("fails closed for invalid state %s", async (contents) => {
    const root = await fixture();
    const path = join(root, ".ompfest", "portfolio.json");
    await mkdir(join(root, ".ompfest"), { mode: 0o700 });
    await writeFile(path, contents);
    await expect(readPortfolioState(root)).rejects.toThrow();
    await expect(reservePortfolioAssignment(root, input("one"))).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("rejects unsafe storage and record symlinks", async () => {
    const root = await fixture();
    const target = await fixture();
    await symlink(target, join(root, ".ompfest"));
    await expect(readPortfolioState(root)).rejects.toThrow("symlink");
    await rm(join(root, ".ompfest"));
    await mkdir(join(root, ".ompfest"));
    await writeFile(join(target, "portfolio.json"), JSON.stringify({ version: 1, workerLimit: 20, assignments: [] }));
    await symlink(join(target, "portfolio.json"), join(root, ".ompfest", "portfolio.json"));
    await expect(readPortfolioState(root)).rejects.toThrow("symlink");
  });
});
