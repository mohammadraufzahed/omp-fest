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


function assertStructuredInput(value: unknown): asserts value is StructuredPlan {
  const object = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const array = (item: unknown): item is unknown[] => Array.isArray(item);
  if (!object(value) || typeof value.goal !== "string" || !array(value.scope) || !array(value.exclusions)
    || !array(value.acceptance) || !array(value.questions) || !array(value.inspection) || !array(value.phases)) {
    throw new Error("Plan input must be a complete structured plan with valid phase, sequence, and task arrays");
  }
  for (const phase of value.phases) {
    if (!object(phase) || (phase.sequences !== undefined && !array(phase.sequences))) throw new Error("Plan phase sequences must be an array when supplied");
    for (const sequence of phase.sequences ?? []) {
      if (!object(sequence) || !array(sequence.tasks)) throw new Error("Plan sequence tasks must be an array");
      for (const task of sequence.tasks) {
        if (!object(task) || !array(task.dependsOn) || !array(task.implements) || !array(task.verifies) || !array(task.files) || !array(task.verification)) throw new Error("Plan task dependency, acceptance, files and verification fields must be arrays");
      }
    }
  }
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
/** Infer command provenance, never runtime completion evidence, from declared command targets. */
export function inferVerificationProvenancePath(command: string | undefined, cwd = "."): string | undefined {
  if (!command?.trim()) return undefined;
  const words = command.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((word) => word.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
  const executable = words[0]?.split(/[\\/]/).at(-1);
  if (!executable) return undefined;
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) return `${cwd === "." ? "" : `${cwd.replace(/\/+$/, "")}/`}package.json`;
  if (executable === "go") return `${cwd === "." ? "" : `${cwd}/`}go.mod`;
  if (executable === "cargo") return `${cwd === "." ? "" : `${cwd}/`}Cargo.toml`;
  if (executable === "make") return `${cwd === "." ? "" : `${cwd}/`}Makefile`;
  const directory = verificationDirectoryArgument(command);
  if (directory) return `${cwd === "." ? "" : `${cwd}/`}${directory.replaceAll("\\", "/")}`;
  let script: string | undefined;
  if (executable === "php") script = words[1] === "-l" ? words[2] : words[1];
  else if (executable === "node" && words[1] === "--check") script = words[2];
  else if (["node", "python", "python3", "ruby", "bash", "sh"].includes(executable)) script = words[1];
  else if (executable === "deno") script = words[1] === "run" ? words[2] : words[1];
  else if (words[0]?.includes("/")) script = words[0];
  if (!script || script.startsWith("-") || !/[./\\]/.test(script)) return undefined;
  return `${cwd === "." ? "" : `${cwd}/`}${script.replaceAll("\\", "/")}`;
}
function verificationDirectoryArgument(command: string | undefined): string | undefined {
  if (!command?.trim()) return undefined;
  const words = command.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((word) => word.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
  const executable = words[0]?.split(/[\\/]/).at(-1);
  const directoryArg = executable === "pytest" || executable === "phpunit"
    ? words[1]
    : (executable === "python" || executable === "python3") && words[1] === "-m" && words[2] === "pytest"
      ? words[3]
      : undefined;
  return directoryArg && !directoryArg.startsWith("-") ? directoryArg : undefined;
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
  assertStructuredInput(input);
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
    const sequences = (Array.isArray(phase.sequences) ? phase.sequences : []).map((sequence, sequenceIndex) => {
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
        task.verification = task.verification.map((check) => {
          if ((check.kind ?? "command") !== "command") return { ...check, ...(check.provenancePath ? { provenancePath: projectRelative(projectRoot, check.provenancePath, warnings, "verification provenancePath") } : {}) };
          const cwd = projectRelative(projectRoot, check.cwd ?? ".", warnings, "verification cwd");
          const inferred = !check.provenancePath ? inferVerificationProvenancePath(check.command, cwd) : undefined;
          const provenancePath = check.provenancePath ?? inferred;
          if (inferred) warnings.push(`verification provenancePath was inferred from its command: ${inferred}`);
          return {
            ...check,
            cwd,
            ...(provenancePath ? { provenancePath: projectRelative(projectRoot, provenancePath, warnings, "verification provenancePath") } : {}),
          };
        });
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
