/**
 * Classifies raw `fest next` output into a typed NextUnit so the agent
 * branches on `kind` instead of parsing prose. Handles both the human
 * rendering (default) and `--json` payloads; every branch is tested against
 * output captured from a real fest v0.9.7 run.
 */
import type { Autonomy, NextUnit } from "./types.js";
import { parseValidationIssues } from "./validation.js";

const MARKER_RE = /\[(?:REPLACE|FILL):[^\]]*\]/g;

export function classifyNextOutput(output: string, exitCode = 0): NextUnit {
  const text = output.trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    const jsonUnit = classifyJson(text);
    if (jsonUnit) {
      return jsonUnit;
    }
  }
  return classifyText(text, exitCode);
}

function classifyJson(text: string): NextUnit | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (record.complete === true || record.status === "complete") {
    return { kind: "complete", reason: stringField(record.reason) };
  }
  const task = stringField(record.task) ?? stringField(record.path);
  if (task) {
    return {
      kind: "task",
      path: task,
      phase: stringField(record.phase),
      sequence: stringField(record.sequence),
      workingDir: stringField(record.working_dir ?? record.workingDir),
      autonomy: parseAutonomy(record.autonomy),
      doc: stringField(record.doc ?? record.content) ?? "",
      goals: arrayOfStrings(record.goals),
    };
  }
  return undefined;
}

function classifyText(text: string, exitCode: number): NextUnit {
  if (text.length === 0) {
    return { kind: "idle", reason: "empty output" };
  }
  if (/STOP:\s*FESTIVAL VALIDATION FAILED/i.test(text)) {
    return { kind: "blocked", errors: parseValidationIssues(text), raw: text };
  }
  if (/Festival Complete/i.test(text) || /All tasks .* completed/i.test(text)) {
    const reason = /Reason\s+(.+)/.exec(text)?.[1]?.trim();
    return { kind: "complete", ...(reason ? { reason } : {}) };
  }
  if (/not inside a festival/i.test(text)) {
    return { kind: "idle", reason: "not inside a festival" };
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
  if (exitCode !== 0) {
    return { kind: "idle", reason: `fest next exited ${exitCode}: ${firstLine(text)}` };
  }
  return { kind: "idle", reason: "unrecognized fest next output" };
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
    phase: match[1]?.trim() ?? "",
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
    phase: match[1]?.trim() ?? "",
    step,
    totalSteps,
    question,
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
