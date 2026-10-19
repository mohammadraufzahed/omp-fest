import { describe, expect, it } from "vitest";
import { LoopTracker } from "../src/application/loop-tracker.js";

describe("LoopTracker", () => {
  it("nudges when a task was opened but never completed/committed", () => {
    const tracker = new LoopTracker();
    tracker.taskOpened("003_IMPLEMENT/01_core/02_implement.md");
    expect(tracker.nudge()).toContain("02_implement.md");
    expect(tracker.nudge()).toContain("fest task completed");
  });

  it("stays quiet once completed and committed", () => {
    const tracker = new LoopTracker();
    tracker.taskOpened("a.md");
    tracker.taskCompleted();
    tracker.committed();
    expect(tracker.nudge()).toBeUndefined();
  });

  it("mentions only the missing step", () => {
    const tracker = new LoopTracker();
    tracker.taskOpened("a.md");
    tracker.taskCompleted();
    expect(tracker.nudge()).toContain("fest commit");
    expect(tracker.nudge()).not.toContain("task completed");
  });
});
