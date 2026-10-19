import { describe, expect, it } from "vitest";
import { parseProgressLine, statusLineText, summarizeProgress } from "../src/domain/progress.js";

const LINES = [
  '{"ts":"2026-10-19T08:18:18Z","event":"wf_init","phase":"001_INGEST","total_steps":6}',
  '{"ts":"2026-10-19T08:18:19Z","event":"wf_step_start","phase":"001_INGEST","step":1}',
  '{"ts":"2026-10-19T08:19:00Z","event":"task_completed","task":"01_a.md"}',
  '{"ts":"2026-10-19T08:20:00Z","event":"checkpoint_pending","phase":"001_INGEST","step":5}',
];

describe("parseProgressLine", () => {
  it("parses valid jsonl events", () => {
    const event = parseProgressLine(LINES[0]!);
    expect(event?.event).toBe("wf_init");
    expect(event?.total_steps).toBe(6);
  });

  it("rejects non-json and malformed lines", () => {
    expect(parseProgressLine("")).toBeUndefined();
    expect(parseProgressLine("not json")).toBeUndefined();
    expect(parseProgressLine('{"a":1}')).toBeUndefined();
  });
});

describe("summarizeProgress", () => {
  it("counts completions and flags pending gates", () => {
    const events = LINES.map(parseProgressLine).filter((e) => e !== undefined);
    const progress = summarizeProgress(events);
    expect(progress.total).toBe(6);
    expect(progress.completed).toBe(1);
    expect(progress.gatePending).toBe(true);
    expect(progress.percent).toBe(17);
  });

  it("clears gate pending after approval", () => {
    const events = [
      ...LINES,
      '{"ts":"t","event":"checkpoint_approved"}',
    ].map(parseProgressLine).filter((e) => e !== undefined);
    expect(summarizeProgress(events).gatePending).toBe(false);
  });
});

describe("statusLineText", () => {
  it("renders camp, festival, progress, gate flag", () => {
    const line = statusLineText({
      campName: "lab-camp",
      festivalId: "demo-DF0001",
      phase: "IMPLEMENT",
      progress: { completed: 22, total: 30, percent: 73, gatePending: true },
    });
    expect(line).toContain("lab-camp");
    expect(line).toContain("demo-DF0001");
    expect(line).toContain("22/30");
    expect(line).toContain("⛔");
  });
});
