import { describe, expect, it } from "vitest";
import { latestTaskStates, parseProgressLine, statusLineText, summarizeProgress } from "../src/domain/progress.js";

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

  it("replays native reset and blocked events instead of retaining old completions", () => {
    const task = "001_IMPLEMENT/01_core/01_task.md";
    const events = ["completed", "reset", "completed", "blocked"].map((event) => ({ ts: "t", event, task }));
    expect(latestTaskStates(events).get(task)).toBe("blocked");
    expect(summarizeProgress(events).completed).toBe(0);
    expect(latestTaskStates(events.slice(0, 2)).get(task)).toBe("pending");
  });

  it("deduplicates task completion and native workflow step events", () => {
    const events = [
      { ts: "t", event: "wf_init", phase: "001_INGEST", total_steps: 2 },
      { ts: "t", event: "wf_init", phase: "001_INGEST", total_steps: 2 },
      { ts: "t", event: "completed", task: "002_IMPLEMENT/01_core/01_task.md" },
      { ts: "t", event: "task_completed", task: "002_IMPLEMENT/01_core/01_task.md" },
      { ts: "t", event: "wf_step_done", phase: "001_INGEST", step: 1 },
      { ts: "t", event: "wf_step_end", phase: "001_INGEST", step: 1 },
    ];
    const tasks = [
      { sequence: "002_IMPLEMENT/01_core", path: "002_IMPLEMENT/01_core/01_task.md", done: true },
      { sequence: "002_IMPLEMENT/01_core", path: "002_IMPLEMENT/01_core/02_task.md", done: false },
    ];
    expect(summarizeProgress(events, tasks)).toMatchObject({ completed: 2, total: 4, percent: 50 });
  });

  it("invalidates workflow and gate completion on rejection and reset", () => {
    const phase = "gate:001_IMPLEMENT";
    const events = [
      { ts: "t", event: "wf_init", phase, total_steps: 2 },
      { ts: "t", event: "gate_step_approved", phase, step: 1 },
      { ts: "t", event: "wf_step_done", phase, step: 1 },
      { ts: "t", event: "wf_step_done", phase, step: 2 },
      { ts: "t", event: "wf_step_block", phase, step: 2 },
    ];
    expect(summarizeProgress(events)).toMatchObject({ completed: 1, total: 2 });
    expect(summarizeProgress([...events, { ts: "t", event: "wf_reset", phase }])).toMatchObject({ completed: 0, total: 2, gatePending: false });
  });

  it("tracks multiple pending gates independently and clears only the reset phase", () => {
    const events = [
      { ts: "t", event: "checkpoint_pending", phase: "001", step: 1 },
      { ts: "t", event: "gate_step_pending", phase: "002", step: 1 },
      { ts: "t", event: "checkpoint_approved", phase: "001", step: 1 },
    ];
    expect(summarizeProgress(events).gatePending).toBe(true);
    expect(summarizeProgress([...events, { ts: "t", event: "wf_reset", phase: "002" }]).gatePending).toBe(false);
  });

  it("uses explicit task totals and canonical moved-task identities", () => {
    const events = [
      { ts: "t", event: "init", total_tasks: 4 },
      { ts: "t", event: "completed", task: "001_IMPLEMENT/01_core/01_task.md" },
      { ts: "t", event: "completed", task: "001_IMPLEMENT/completed/01_core/01_task.md" },
    ];
    expect(summarizeProgress(events)).toMatchObject({ completed: 1, total: 4, percent: 25 });
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
