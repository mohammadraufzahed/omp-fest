import { describe, expect, it } from "vitest";
import { buildOrientationNote } from "@/domain/orientation.js";

describe("buildOrientationNote", () => {
  it("is empty outside a camp", () => {
    expect(buildOrientationNote({ location: { kind: "outside" } })).toBe("");
  });

  it("includes camp, festival, task, markers, gate", () => {
    const note = buildOrientationNote({
      location: {
        kind: "festival",
        campRoot: "/c/lab",
        campName: "lab",
        festivalDir: "/c/lab/festivals/active/x-F1",
        festivalId: "x-F1",
      },
      status: "active",
      progress: { completed: 22, total: 30, percent: 73, gatePending: false },
      currentTask: "003_IMPLEMENT/01_core/02_implement.md",
      workingDir: "projects/app",
      unfilledMarkers: 3,
      pendingGate: "IMPLEMENT gate 2/4",
    });
    expect(note).toContain("Camp: lab");
    expect(note).toContain("x-F1");
    expect(note).toContain("73%");
    expect(note).toContain("02_implement.md");
    expect(note).toContain("Unfilled markers: 3");
    expect(note).toContain("Pending gate");
    expect(note).toContain("fest rules");
  });
});
