import { describe, expect, it } from "vitest";
import { buildPortfolioQueue, DEFAULT_PORTFOLIO_WORKERS, PORTFOLIO_MAX_WORKERS, type PortfolioCandidate, type PortfolioFestivalQueue } from "../src/application/portfolio-queue.js";

const candidate = (festival: string, task: string): PortfolioCandidate => ({ festival, task, sequence: "s", files: [`src/${task}.ts`], dependencies: [], workingDir: `/work/${festival}` });
const festival = (id: string, tasks: string[], waiting: PortfolioFestivalQueue["waiting"] = []): PortfolioFestivalQueue => ({ festival: id, candidates: tasks.map((task) => candidate(id, task)), waiting });

describe("portfolio queue", () => {
  it("sorts within each festival by stable priority while round-robining across festivals", () => {
    const prioritized = festival("a", ["low", "normal", "high", "urgent"]);
    prioritized.candidates[0]!.priority = "low";
    prioritized.candidates[2]!.priority = "high";
    prioritized.candidates[3]!.priority = "urgent";
    const result = buildPortfolioQueue({ festivals: [prioritized, festival("b", ["b1", "b2"])], assignments: [], paused: false, workerLimit: 6 });
    expect(result.candidates.map((c) => `${c.festival}:${c.task}`)).toEqual(["a:urgent", "b:b1", "a:high", "b:b2", "a:normal", "a:low"]);
  });
  it("round-robins fairly, preserving festival order, and starts after the last festival", () => {
    const result = buildPortfolioQueue({ festivals: [festival("a", ["a1", "a2", "a3"]), festival("b", ["b1", "b2"]), festival("c", ["c1"])], assignments: [], paused: false, workerLimit: 5 });
    expect(result.candidates.map((c) => c.task)).toEqual(["a1", "b1", "c1", "a2", "b2"]);
    const rotated = buildPortfolioQueue({ festivals: [festival("a", ["a1", "a2"]), festival("b", ["b1"]), festival("c", ["c1"])], assignments: [], paused: false, workerLimit: 2, lastFestival: "a" });
    expect(rotated.candidates.map((c) => c.task)).toEqual(["b1", "c1"]);
  });
  it("defaults to and never exceeds twenty workers, with smaller configurable limits", () => {
    expect(DEFAULT_PORTFOLIO_WORKERS).toBe(20);
    expect(PORTFOLIO_MAX_WORKERS).toBe(20);
    const rows = festival("a", Array.from({ length: 25 }, (_, i) => `t${i}`));
    const standard = buildPortfolioQueue({ festivals: [rows], assignments: [], paused: false });
    expect(standard.candidates).toHaveLength(20);
    expect(standard.waiting).toHaveLength(5);
    const small = buildPortfolioQueue({ festivals: [rows], assignments: [], paused: false, workerLimit: 3 });
    expect(small.candidates.map((c) => c.task)).toEqual(["t0", "t1", "t2"]);
    expect(small.availableSlots).toBe(3);
    for (const workerLimit of [0, -1, 21, 1.5, Number.NaN]) expect(() => buildPortfolioQueue({ festivals: [], assignments: [], paused: false, workerLimit })).toThrow(RangeError);
  });
  it("counts every nonterminal assignment as active and treats failed or accepted as inactive", () => {
    const result = buildPortfolioQueue({ festivals: [festival("a", ["active", "submitted", "accepted", "free"])], assignments: [
      { festival: "a", task: "active", status: "running" }, { festival: "a", task: "submitted", status: "submitted" },
      { festival: "a", task: "accepted", status: "accepted" }, { festival: "a", task: "failed", status: "failed" },
    ], paused: false, workerLimit: 5 });
    expect(result.activeWorkers).toBe(2);
    expect(result.availableSlots).toBe(3);
    expect(result.candidates.map((c) => c.task)).toEqual(["free"]);
    expect(result.waiting.map((w) => w.task)).toEqual(["active", "submitted", "accepted"]);
  });
  it("pauses dispatch while preserving active counts and replacing waiting reasons", () => {
    const result = buildPortfolioQueue({ festivals: [festival("a", ["next"], [{ task: "old", reason: "old reason" }])], assignments: [{ festival: "b", task: "running", status: "blocked" }], paused: true });
    expect(result.candidates).toEqual([]);
    expect(result.activeWorkers).toBe(0);
    expect(result.availableSlots).toBe(20);
    expect(result.waiting.map(({ festival, task }) => `${festival}:${task}`)).toEqual(["a:next", "a:old"]);
    expect(result.waiting.every(({ reason }) => reason.includes("paused"))).toBe(true);
    const capacity = buildPortfolioQueue({ festivals: [festival("a", ["held"]), festival("b", ["free"])], assignments: [{ festival: "a", task: "held", status: "blocked" }], paused: false, workerLimit: 1 });
    expect(capacity.activeWorkers).toBe(0);
    expect(capacity.candidates.map((c) => `${c.festival}:${c.task}`)).toEqual(["b:free"]);
    expect(capacity.waiting).toContainEqual(expect.objectContaining({ festival: "a", task: "held" }));
  });
  it("suppresses duplicate festival-task candidates and carries waiting without isolating other festivals", () => {
    const a = festival("a", ["same", "same", "a2"], [{ task: "blocked", reason: "a failure" }]);
    const b = festival("b", ["same", "b1"]);
    const result = buildPortfolioQueue({ festivals: [a, b], assignments: [], paused: false, workerLimit: 3 });
    expect(result.candidates.map((c) => `${c.festival}:${c.task}`)).toEqual(["a:same", "b:same", "a:a2"]);
    expect(result.waiting).toContainEqual({ festival: "a", task: "blocked", reason: "a failure" });
    expect(result.candidates.some((c) => c.festival === "b" && c.task === "b1")).toBe(false);
    const isolated = buildPortfolioQueue({ festivals: [festival("a", ["a1"], [{ task: "bad", reason: "failure" }]), festival("b", ["b1"])], assignments: [{ festival: "a", task: "a1", status: "failed" }], paused: false });
    expect(isolated.candidates.map((c) => `${c.festival}:${c.task}`)).toEqual(["a:a1", "b:b1"]);
  });
  it("holds overlapping candidate file sets out of the launch list", () => {
    const a = candidate("a", "first");
    const b = candidate("b", "second");
    a.workingDir = b.workingDir = "/shared";
    a.files = ["src/lib"];
    b.files = ["src/lib/child.ts"];
    const result = buildPortfolioQueue({
      festivals: [
        { festival: "a", candidates: [a], waiting: [] },
        { festival: "b", candidates: [b], waiting: [] },
      ],
      assignments: [], paused: false, workerLimit: 2,
    });
    expect(result.candidates.map((row) => `${row.festival}:${row.task}`)).toEqual(["a:first"]);
    expect(result.waiting.some((row) => row.festival === "b" && row.task === "second" && row.reason.includes("overlaps a/first"))).toBe(true);
    const rotated = buildPortfolioQueue({
      festivals: [
        { festival: "a", candidates: [a], waiting: [] },
        { festival: "b", candidates: [b], waiting: [] },
      ],
      assignments: [], paused: false, workerLimit: 2, lastFestival: "a",
    });
    expect(rotated.candidates.map((row) => `${row.festival}:${row.task}`)).toEqual(["b:second"]);
    expect(rotated.waiting[0]?.reason).toContain("overlaps b/second");
    a.files = [];
    expect(buildPortfolioQueue({ festivals: [{ festival: "a", candidates: [a], waiting: [] }, { festival: "b", candidates: [b], waiting: [] }], assignments: [], paused: false }).candidates).toEqual([a]);
  });
  it("does not let a capacity-excluded candidate suppress another festival's usable slot", () => {
    const a = festival("a", ["first", "later"]), b = festival("b", ["ready"]);
    a.candidates[1]!.workingDir = b.candidates[0]!.workingDir = "/shared";
    a.candidates[1]!.files = ["src/shared.ts"];
    b.candidates[0]!.files = ["src/shared.ts"];
    const result = buildPortfolioQueue({ festivals: [a, b], assignments: [], paused: false, workerLimit: 2 });
    expect(result.candidates.map((row) => `${row.festival}:${row.task}`)).toEqual(["a:first", "b:ready"]);
    expect(result.waiting).toContainEqual({ festival: "a", task: "later", reason: "Portfolio worker limit reached." });
  });
});
