import { isAbsolute, relative, resolve, sep } from "node:path";
import type { StructuredPlan } from "./structured-plan.js";

export interface PlanInputNormalization {
  spec: StructuredPlan;
  warnings: string[];
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}


function slug(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const result = normalized || fallback;
  return /^[a-z]/.test(result) ? result : `step-${result}`;
}

function unique(base: string, used: Set<string>): string {
  let id = base;
  let index = 2;
  while (used.has(id)) id = `${base}-${index++}`;
  used.add(id);
  return id;
}

function projectRelative(root: string, value: string, warnings: string[], label: string): string {
  if (!isAbsolute(value)) return value;
  const absolute = resolve(value);
  if (!inside(root, absolute)) return value;
  const normalized = relative(root, absolute).split(sep).join("/") || ".";
  warnings.push(`${label} was normalized to a project-relative path: ${normalized}`);
  return normalized;
}

/** Repairs common model formatting mistakes without inventing repository facts. */
export function normalizePlanInput(input: StructuredPlan, projectRoot: string): PlanInputNormalization {
  const warnings: string[] = [];
  const phaseIds = new Set<string>();
  const sequenceIds = new Set<string>();
  const taskIds = new Set<string>();
  const acceptanceIds = new Set<string>();
  const taskIdMap = new Map<string, string>();
  const acceptanceMap = new Map<string, string>();
  const acceptance = input.acceptance.map((item, index) => {
    const valid = /^[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z][A-Za-z0-9_.-]*)?$/.test(item.id);
    const next = valid && !acceptanceIds.has(item.id)
      ? item.id
      : unique(`ac-${index + 1}`, acceptanceIds);
    if (next !== item.id) {
      acceptanceMap.set(item.id, next);
      warnings.push(`acceptance[${index}].id was normalized to ${next}`);
    }
    return { ...item, id: next };
  });
  const phases = input.phases.map((phase, phaseIndex) => {
    const phaseId = unique(slug(phase.id || phase.name, `phase-${phaseIndex + 1}`), phaseIds);
    const sequences = phase.sequences.map((sequence, sequenceIndex) => {
      const sequenceId = unique(slug(sequence.id || sequence.name, `sequence-${sequenceIndex + 1}`), sequenceIds);
      const tasks = sequence.tasks.map((task, taskIndex) => {
        const taskId = unique(slug(task.id || task.title, `task-${taskIndex + 1}`), taskIds);
        taskIdMap.set(task.id, taskId);
        return { ...task, id: taskId };
      });
      return { ...sequence, id: sequenceId, tasks };
    });
    return { ...phase, id: phaseId, sequences };
  });
  for (const phase of phases) {
    for (const sequence of phase.sequences) {
      for (const task of sequence.tasks) {
        task.dependsOn = task.dependsOn.map((id) => taskIdMap.get(id) ?? id);
        task.implements = task.implements.map((id) => acceptanceMap.get(id) ?? id);
        task.verifies = task.verifies.map((id) => acceptanceMap.get(id) ?? id);
        task.files = task.files.map((file) => ({ ...file, path: projectRelative(projectRoot, file.path, warnings, "task file") }));
        task.verification = task.verification.map((check) => ({
          ...check,
          cwd: projectRelative(projectRoot, check.cwd, warnings, "verification cwd"),
          evidencePath: projectRelative(projectRoot, check.evidencePath, warnings, "verification evidencePath"),
        }));
      }
    }
  }
  return {
    spec: {
      ...input,
      acceptance,
      inspection: input.inspection.map((entry) => ({ ...entry, path: projectRelative(projectRoot, entry.path, warnings, "inspection path") })),
      phases,
    },
    warnings,
  };
}
