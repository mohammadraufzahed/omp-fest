import { describe, expect, it } from "vitest";
import { LoopTracker } from "../src/application/loop-tracker.js";

describe("LoopTracker", () => {
  it("nudges when a task was opened but never completed/committed", () => {
    const tracker = new LoopTracker();
    tracker.taskOpened("s1", "003_IMPLEMENT/01_core/02_implement.md");
    expect(tracker.nudge("s1")).toContain("02_implement.md");
    expect(tracker.nudge("s1")).toContain("fest task completed");
  });

  it("stays quiet once completed and committed", () => {
    const tracker = new LoopTracker();
    tracker.taskOpened("s1", "a.md");
    tracker.taskCompleted("s1");
    tracker.committed("s1");
    expect(tracker.nudge("s1")).toBeUndefined();
  });

  it("mentions only the missing step", () => {
    const tracker = new LoopTracker();
    tracker.taskOpened("s1", "a.md");
    tracker.taskCompleted("s1");
    expect(tracker.nudge("s1")).toContain("fest commit");
    expect(tracker.nudge("s1")).not.toContain("task completed");
  });
  it("warns against task completion while a project reservation blocks work", () => {
    const tracker = new LoopTracker();
    const task = "001_BUILD/01_implement/01_task.md";
    tracker.taskOpened("s1", task);
    tracker.taskPaused("s1", task, "Another session owns overlapping project files.");
    expect(tracker.unfinishedFor("s1")).toBe(false);
    expect(tracker.nudge("s1")).toContain("Do not mark it completed or commit");
    expect(tracker.nudge("s1")).toContain("Another session owns overlapping project files");
    tracker.taskOpened("s1", task);
    expect(tracker.nudge("s1")).toContain("Do not mark it completed");
    tracker.taskResumed("s1", task);
    expect(tracker.unfinishedFor("s1")).toBe(true);
    expect(tracker.nudge("s1")).toContain("fest task completed");
  });

  it("scopes open units, warns and festival claims per session", () => {
    const tracker = new LoopTracker();
    tracker.taskOpened("s1", "a.md");
    tracker.claimFestival("s1", "/camp/festivals/active/fest-A");
    tracker.claimFestival("s2", "/camp/festivals/active/fest-B");
    expect(tracker.openTaskPathFor("s2")).toBeUndefined();
    expect(tracker.nudge("s2")).toBeUndefined();
    expect(tracker.unfinishedFor("s1")).toBe(true);
    expect(tracker.festivalFor("s1")).toBe("/camp/festivals/active/fest-A");
    expect(tracker.festivalFor("s2")).toBe("/camp/festivals/active/fest-B");
    // warn dedupe is per-session: s2 wasn't warned for the path s1 saw
    expect(tracker.markWarned("s1", "/x.ts")).toBe(true);
    expect(tracker.markWarned("s1", "/x.ts")).toBe(false);
    expect(tracker.markWarned("s2", "/x.ts")).toBe(true);
  });
});
