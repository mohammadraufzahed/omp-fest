/**
 * Classifies native `fest next --json` results and the text emitted by v0.9.8
 * for festival workflows, phase gates, validation and lifecycle refusals.
 * Failures remain blocked units: they must never look like idle/finished work.
 */
import type { Autonomy, NextUnit, ValidationIssue } from "./types.js";
import { parseValidationIssues } from "./validation.js";

const MARKER_RE = /\[(?:REPLACE|FILL):[^\]]*\]/g;

export function classifyNextOutput(output: string, exitCode = 0): NextUnit {
  const text = output.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    const jsonUnit = classifyJson(text, exitCode);
    if (jsonUnit) {
      return jsonUnit;
    }
  }
  return classifyText(text, exitCode);
}

function classifyJson(text: string, exitCode: number): NextUnit | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return blocked(text, "Malformed fest next JSON");
  }
  const record = objectField(data);
  if (!record) return blocked(text, "Expected a fest next JSON object");
  const blockers = Array.isArray(record.blocked_tasks) ? record.blocked_tasks : [];
  if (exitCode !== 0 || record.ok === false || record.error || record.valid === false ||
      Array.isArray(record.errors) && record.errors.length > 0 || record.status === "error" ||
      record.blocked === true || blockers.length > 0 ||
      record.kind === "blocked" || record.status === "blocked") {
    const issues = jsonIssues(record.errors ?? record.issues ?? blockers);
    return { kind: "blocked", errors: issues.length ? issues : [{ file: "", markers: [],
      error: stringField(record.error) ?? stringField(record.reason) ?? `fest next refused (exit ${exitCode})` }], raw: text };
  }
  if (record.festival_complete === true || record.complete === true || record.status === "complete" ||
      record.render_mode === "complete") {
    return { kind: "complete", reason: stringField(record.reason) };
  }
  if (record.mode === "standalone-tracked" || record.mode === "standalone-anonymous") {
    const step = numberField(record.current_step);
    if (!step) return blocked(text, "Workflow result has no current step");
    return {
      kind: "wf_step", phase: stringField(record.workflow_doc) ?? "", step,
      totalSteps: numberField(record.total_steps), title: stringField(record.step_name) ?? "",
      goal: stringField(record.step_goal) ?? "", actions: arrayOfStrings(record.step_actions),
      checkpoint: record.blocked === true || record.step_checkpoint === "approval_required",
      doc: stringField(record.doc ?? record.content) ?? text,
    };
  }
  const taskRecord = objectField(record.task);
  const task = stringField(taskRecord?.path) ?? stringField(record.task) ?? stringField(record.path);
  if (task) {
    const festival = stringField(objectField(record.location)?.festival_path);
    const path = festival && task.startsWith(`${festival}/`) ? task.slice(festival.length + 1) : task;
    const goals = objectField(record.layered_goals);
    return {
      kind: "task", path,
      phase: stringField(taskRecord?.phase_name ?? record.phase),
      sequence: stringField(taskRecord?.sequence_name ?? record.sequence),
      workingDir: stringField(record.working_dir_absolute ?? record.working_dir ?? record.workingDir),
      autonomy: parseAutonomy(taskRecord?.autonomy_level ?? record.autonomy),
      doc: stringField(record.task_content ?? record.doc ?? record.content ?? record.gate_content) ?? "",
      goals: goals ? [goals.festival_goal, goals.phase_goal, goals.sequence_goal]
        .filter((value): value is string => typeof value === "string" && value.length > 0) : arrayOfStrings(record.goals),
    };
  }
  return blocked(text, stringField(record.reason) ?? "Unrecognized fest next JSON result");
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function numberField(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return 0;
  return value;
}

function jsonIssues(value: unknown): ValidationIssue[] {
  if (typeof value === "string") return [{ file: "", markers: [], error: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ValidationIssue[] => {
    if (typeof item === "string") return [{ file: "", markers: [], error: item }];
    const issue = objectField(item);
    if (!issue || issue.level === "warning" || issue.level === "info") return [];
    return [{ file: stringField(issue.path ?? issue.file ?? issue.task) ?? "", markers: arrayOfStrings(issue.markers),
      error: stringField(issue.message ?? issue.error ?? issue.blocker_message) ?? "Native fest blocker" }];
  });
}

function blocked(raw: string, error: string): NextUnit {
  return { kind: "blocked", errors: [{ file: "", markers: [], error }], raw };
}

function classifyText(text: string, exitCode: number): NextUnit {
  if (text.length === 0) {
    return exitCode === 0 ? { kind: "idle", reason: "empty output" } : blocked(text, `fest next exited ${exitCode} without output`);
  }
  if (/STOP:\s*FESTIVAL VALIDATION FAILED/i.test(text)) {
    return { kind: "blocked", errors: parseValidationIssues(text), raw: text };
  }
  if (exitCode !== 0 || /STOP:|^Error:|^error:/im.test(text)) {
    return blocked(text, `fest next exited ${exitCode}: ${firstLine(text)}`);
  }
  if (/This step is BLOCKED:/i.test(text)) {
    return blocked(text, /This step is BLOCKED:\s*(.+)/i.exec(text)?.[1] ?? "Workflow step blocked");
  }
  if (/Festival Complete/i.test(text) || /All tasks .* completed/i.test(text)) {
    const reason = /Reason\s+(.+)/.exec(text)?.[1]?.trim();
    return { kind: "complete", ...(reason ? { reason } : {}) };
  }
  if (/not inside a festival/i.test(text)) {
    return blocked(text, "not inside a festival");
  }
  if (/BLOCKING CHECKPOINT/i.test(text)) {
    return parseBlockingCheckpoint(text);
  }
  const gateMatch = /([A-Z_ ]+)\s+PHASE GATE\s*-\s*Step\s+(\d+)\s+of\s+(\d+)/i.exec(text);
  if (gateMatch) {
    return parseGateStep(text, gateMatch);
  }
  const wfMatch = /([A-Z_ ]+)\s+PHASE\s*-\s*Step\s+(\d+)\s+of\s+(\d+)/i.exec(text);
  if (wfMatch) {
    return parseWorkflowStep(text, wfMatch);
  }
  if (/NEXT TASK/i.test(text)) {
    return parseTask(text);
  }
  return blocked(text, "unrecognized fest next output");
}

function parseTask(text: string): NextUnit {
  const field = (name: string): string | undefined =>
    new RegExp(`^${name}\\s+(.+)$`, "im").exec(text)?.[1]?.trim();
  const taskName = field("Task") ?? "";
  const path = field("Path") ?? taskName;
  const doc = text.split(/##\s*Task Document/i)[1]?.trim() ?? "";
  return {
    kind: "task",
    path,
    phase: field("Phase"),
    sequence: field("Sequence"),
    workingDir: field("Working Directory"),
    autonomy: parseAutonomy(field("Autonomy")),
    doc,
    goals: extractGoals(text),
  };
}

function parseWorkflowStep(text: string, match: RegExpExecArray): NextUnit {
  const step = Number(match[2]);
  const totalSteps = Number(match[3]);
  const title = new RegExp(`##\\s*Step\\s+${step}:\\s*(.+)`).exec(text)?.[1]?.trim() ?? "";
  return {
    kind: "wf_step",
    phase: /Phase:\s*(\S+)/.exec(text)?.[1] ?? match[1]?.trim() ?? "",
    step,
    totalSteps,
    title,
    goal: boldField(text, "Goal"),
    actions: extractActions(text),
    checkpoint: /checkpoint.*required|requires.*approval/i.test(text),
    doc: text,
  };
}

function parseGateStep(text: string, match: RegExpExecArray): NextUnit {
  const step = Number(match[2]);
  const totalSteps = Number(match[3]);
  const question = new RegExp(`##\\s*Step\\s+${step}:\\s*(.+)`).exec(text)?.[1]?.trim() ?? "";
  return {
    kind: "gate_step",
    phase: /Phase:\s*(\S+)/.exec(text)?.[1] ?? match[1]?.trim() ?? "",
    step,
    question: boldField(text, "Question") || question,
    totalSteps,
    doc: text,
  };
}

function parseBlockingCheckpoint(text: string): NextUnit {
  const title = /Step\s+(\d+):\s*(.+)/.exec(text);
  const question = /\*\*Question:\*\*\s*(.+)/.exec(text)?.[1]?.trim() ?? title?.[2]?.trim() ?? "";
  return {
    kind: "gate_step",
    phase: "",
    step: title ? Number(title[1]) : 0,
    totalSteps: 0,
    question,
    doc: text,
  };
}

/** Unfilled markers embedded in `fest next` output (e.g. inside a task doc). */
export function markersIn(text: string): string[] {
  return text.match(MARKER_RE) ?? [];
}

function boldField(text: string, name: string): string {
  return new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`).exec(text)?.[1]?.trim() ?? "";
}

function extractGoals(text: string): string[] {
  const goals: string[] = [];
  for (const m of text.matchAll(/(?:Festival|Phase|Sequence) Goal:\s*(.+)/gi)) {
    if (m[1]) {
      goals.push(m[1].trim());
    }
  }
  return goals;
}

function extractActions(text: string): string[] {
  const block = text.split(/\*\*Actions:\*\*/i)[1];
  if (!block) {
    return [];
  }
  const end = block.search(/\n\s*\n\s*(?:\*\*(?:Output|Checkpoint)|─)/);
  const slice = end === -1 ? block : block.slice(0, end);
  return slice
    .split(/\n/)
    .map((line) => line.replace(/^\s*(?:\d+\.|[-*])\s*/, "").trim())
    .filter((line) => line.length > 0);
}

function parseAutonomy(value: unknown): Autonomy | undefined {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  return s === "low" || s === "medium" || s === "high" ? s : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? "";
}
