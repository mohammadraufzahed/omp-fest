import { describe, expect, it } from "vitest";
import { classifyNextOutput } from "@/domain/next-unit.js";

const TASK_OUTPUT = `
NEXT TASK
─────────
Task 01_design
Path 003_IMPLEMENT/01_core/01_design.md
Phase 003_IMPLEMENT
Sequence 01_core
Working Directory projects/demo-app
Autonomy medium
Progress 66.0% (20/30 tasks)

Context about the task you will be doing:
Festival Goal: ship auth
Phase Goal: build it
Sequence Goal: core

## Task Document

# Task: design

## Objective

do the thing
`;

const WF_STEP_OUTPUT = `
═══════════════════════════════════════════════════════════════════════════════
                    INGEST PHASE - Step 1 of 6
═══════════════════════════════════════════════════════════════════════════════

## Step 1: GATHER

**Goal:** Ensure every piece of requirement material is present.

**Actions:**
  - Ask the user what artifacts exist
  - Copy each artifact into input_specs/

**Output:** All artifacts present

**Checkpoint:** None — proceed when complete
`;

const GATE_STEP_OUTPUT = `
                    INGEST PHASE GATE - Step 1 of 3

## Step 1: PHASE GOAL

**Question:** Does the structured output capture the user's intent?

**Checkpoint:** This step requires user approval before proceeding
`;

const BLOCKING_OUTPUT = `
                    BLOCKING CHECKPOINT

Step 6: PRESENT

**Question:** Verify plan is ready for implementation.

This step requires explicit operator confirmation before proceeding.
`;

const STOP_OUTPUT = `
STOP: FESTIVAL VALIDATION FAILED
────────────────────────────────
Errors:
  ✗ 003_IMPLEMENT/01_core/01_design.md: File contains 5 unfilled template markers ([REPLACE:)
  ✗ 003_IMPLEMENT/01_core/SEQUENCE_GOAL.md: sequence "01_core": missing fest_working_dir
`;

const COMPLETE_OUTPUT = `
Festival Complete
All tasks have been completed.
Reason All tasks in the festival are complete
`;

describe("classifyNextOutput", () => {
  it("parses a task unit with working dir and autonomy", () => {
    const unit = classifyNextOutput(TASK_OUTPUT);
    expect(unit.kind).toBe("task");
    if (unit.kind === "task") {
      expect(unit.path).toBe("003_IMPLEMENT/01_core/01_design.md");
      expect(unit.workingDir).toBe("projects/demo-app");
      expect(unit.autonomy).toBe("medium");
      expect(unit.sequence).toBe("01_core");
      expect(unit.doc).toContain("# Task: design");
    }
  });

  it("parses a workflow step", () => {
    const unit = classifyNextOutput(WF_STEP_OUTPUT);
    expect(unit.kind).toBe("wf_step");
    if (unit.kind === "wf_step") {
      expect(unit.phase).toBe("INGEST");
      expect(unit.step).toBe(1);
      expect(unit.totalSteps).toBe(6);
      expect(unit.title).toBe("GATHER");
      expect(unit.checkpoint).toBe(false);
      expect(unit.actions.length).toBeGreaterThan(0);
    }
  });

  it("parses a phase gate step", () => {
    const unit = classifyNextOutput(GATE_STEP_OUTPUT);
    expect(unit.kind).toBe("gate_step");
    if (unit.kind === "gate_step") {
      expect(unit.phase).toBe("INGEST");
      expect(unit.question).toContain("PHASE GOAL");
    }
  });

  it("parses a blocking checkpoint as a gate step", () => {
    const unit = classifyNextOutput(BLOCKING_OUTPUT);
    expect(unit.kind).toBe("gate_step");
    if (unit.kind === "gate_step") {
      expect(unit.question).toContain("Verify plan is ready");
    }
  });

  it("parses STOP validation failures into per-file issues", () => {
    const unit = classifyNextOutput(STOP_OUTPUT);
    expect(unit.kind).toBe("blocked");
    if (unit.kind === "blocked") {
      expect(unit.errors).toHaveLength(2);
      expect(unit.errors[0]?.file).toContain("01_design.md");
      expect(unit.errors[1]?.error).toContain("missing fest_working_dir");
    }
  });

  it("parses festival complete", () => {
    const unit = classifyNextOutput(COMPLETE_OUTPUT);
    expect(unit.kind).toBe("complete");
  });

  it("maps 'not inside a festival' to idle", () => {
    expect(classifyNextOutput("Error: not inside a festival").kind).toBe("idle");
  });

  it("classifies JSON task payloads", () => {
    const unit = classifyNextOutput(
      JSON.stringify({ task: "a/b.md", phase: "003_IMPLEMENT", working_dir: "projects/app" }),
    );
    expect(unit.kind).toBe("task");
  });
});
