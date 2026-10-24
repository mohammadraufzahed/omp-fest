import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ZodLike, ZodSchema } from "../adapters/omp/zod-types.js";

export interface StructuredTask {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  implements: string[];
  verifies: string[];
  files: { path: string; status: "existing" | "proposed" }[];
  verification: { command: string; cwd: string; evidencePath: string; expected: string }[];
}

export interface StructuredPlan {
  goal: string;
  scope: string[];
  exclusions: string[];
  acceptance: { id: string; description: string }[];
  questions: { question: string; blocking: boolean }[];
  inspection: { path: string; reason: string }[];
  phases: {
    id: string;
    name: string;
    type: "implementation" | "planning" | "research" | "validation";
    sequences: { id: string; name: string; tasks: StructuredTask[] }[];
  }[];
}

export interface PreparedStructuredPlan {
  markdown: string;
  preview: string;
  counts: { phases: number; sequences: number; tasks: number };
  digest: string;
}

/** The host's lightweight Zod facade validates shape; preparation also validates raw callers. */
export function structuredPlanSchema(z: ZodLike): ZodSchema {
  const strings = () => z.array(z.string());
  return z.object({
    goal: z.string(),
    scope: strings(),
    exclusions: strings(),
    acceptance: z.array(z.object({ id: z.string(), description: z.string() })),
    questions: z.array(z.object({ question: z.string(), blocking: z.boolean() })),
    inspection: z.array(z.object({ path: z.string(), reason: z.string() })),
    phases: z.array(z.object({
      id: z.string(), name: z.string(),
      type: z.enum(["implementation", "planning", "research", "validation"]),
      sequences: z.array(z.object({
        id: z.string(), name: z.string(),
        tasks: z.array(z.object({
          id: z.string(), title: z.string(), description: z.string(),
          dependsOn: strings(), implements: strings(), verifies: strings(),
          files: z.array(z.object({ path: z.string(), status: z.enum(["existing", "proposed"]) })),
          verification: z.array(z.object({
            command: z.string(), cwd: z.string(), evidencePath: z.string(), expected: z.string(),
          })),
        })),
      })),
    })),
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be nonempty text`);
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127 || code === 133 || code === 8232 || code === 8233) {
      throw new Error(`${label} must be a single line without control characters`);
    }
  }
  return value.trim();
}

function list<T>(value: unknown, label: string, parse: (value: unknown, label: string) => T, required = false): T[] {
  if (!Array.isArray(value) || (required && value.length === 0)) throw new Error(`${label} must be ${required ? "a nonempty" : "an"} array`);
  return value.map((item, index) => parse(item, `${label}[${index}]`));
}

function stringList(value: unknown, label: string, required = false): string[] {
  const result = list(value, label, text, required);
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function parsePlan(value: unknown): StructuredPlan {
  const ids = new Set<string>();
  const id = (value: unknown, label: string, acceptance = false) => {
    const result = text(value, label);
    const pattern = acceptance ? /^[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z][A-Za-z0-9_.-]*)?$/ : /^[A-Za-z][A-Za-z0-9_.-]*$/;
    if (!pattern.test(result)) throw new Error(`${label} must be a stable identifier`);
    if (ids.has(result)) throw new Error(`Duplicate id: ${result}`);
    ids.add(result);
    return result;
  };
  const plan = record(value, "plan");
  return {
    goal: text(plan.goal, "goal"),
    scope: stringList(plan.scope, "scope", true),
    exclusions: stringList(plan.exclusions, "exclusions"),
    acceptance: list(plan.acceptance, "acceptance", (value, label) => {
      const item = record(value, label);
      return { id: id(item.id, `${label}.id`, true), description: text(item.description, `${label}.description`) };
    }, true),
    questions: list(plan.questions, "questions", (value, label) => {
      const item = record(value, label);
      if (typeof item.blocking !== "boolean") throw new Error(`${label}.blocking must be a boolean`);
      const question = text(item.question, `${label}.question`);
      if (item.blocking) throw new Error(`Unresolved blocking question: ${question}`);
      return { question, blocking: item.blocking };
    }),
    inspection: list(plan.inspection, "inspection", (value, label) => {
      const item = record(value, label);
      return { path: text(item.path, `${label}.path`), reason: text(item.reason, `${label}.reason`) };
    }, true),
    phases: list(plan.phases, "phases", (value, label) => {
      const phase = record(value, label);
      const type = text(phase.type, `${label}.type`);
      if (type !== "implementation" && type !== "planning" && type !== "research" && type !== "validation") throw new Error(`${label}.type is unsupported`);
      return {
        id: id(phase.id, `${label}.id`), name: text(phase.name, `${label}.name`), type,
        sequences: list(phase.sequences, `${label}.sequences`, (value, label) => {
          const sequence = record(value, label);
          return {
            id: id(sequence.id, `${label}.id`), name: text(sequence.name, `${label}.name`),
            tasks: list(sequence.tasks, `${label}.tasks`, (value, label) => {
              const task = record(value, label);
              return {
                id: id(task.id, `${label}.id`), title: text(task.title, `${label}.title`),
                description: text(task.description, `${label}.description`),
                dependsOn: stringList(task.dependsOn, `${label}.dependsOn`),
                implements: stringList(task.implements, `${label}.implements`),
                verifies: stringList(task.verifies, `${label}.verifies`),
                files: list(task.files, `${label}.files`, (value, label) => {
                  const file = record(value, label);
                  if (file.status !== "existing" && file.status !== "proposed") throw new Error(`${label}.status must be existing or proposed`);
                  return { path: text(file.path, `${label}.path`), status: file.status };
                }),
                verification: list(task.verification, `${label}.verification`, (value, label) => {
                  const check = record(value, label);
                  return {
                    command: text(check.command, `${label}.command`), cwd: text(check.cwd, `${label}.cwd`),
                    evidencePath: text(check.evidencePath, `${label}.evidencePath`), expected: text(check.expected, `${label}.expected`),
                  };
                }),
              };
            }, true),
          };
        }, true),
      };
    }, true),
  };
}

/** Upstream phase grammar only accepts an ASCII word token. */
export function structuredPhaseName(name: string): string {
  const token = text(name, "phase name").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  if (!token) throw new Error("Phase name must contain ASCII letters or digits");
  return token;
}

function nameKey(name: string): string {
  const key = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!key) throw new Error(`Name must contain ASCII letters or digits: ${name}`);
  return key;
}

function uniqueNames(names: string[], label: string): void {
  if (new Set(names).size !== names.length) throw new Error(`Normalized name collision in ${label}`);
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function projectPath(root: string, path: string, label: string): string {
  if (isAbsolute(path) || path.includes("\\") || /^[A-Za-z]:/.test(path)) throw new Error(`${label} must be project-relative`);
  const absolute = resolve(root, path);
  if (!inside(root, absolute)) throw new Error(`${label} must stay within project`);
  return absolute;
}

async function resolveProjectRoot(camp: string, workingDir: string): Promise<string> {
  const candidate = isAbsolute(workingDir) ? resolve(workingDir) : resolve(camp, workingDir);
  if (!isAbsolute(workingDir) && !inside(camp, candidate)) {
    throw new Error("workingDir must stay within camp unless it is an absolute linked checkout path");
  }
  let canonical: string;
  try { canonical = await realpath(candidate); }
  catch { throw new Error(`workingDir does not exist: ${workingDir}`); }
  if (!(await stat(canonical)).isDirectory()) throw new Error(`workingDir must be a directory: ${workingDir}`);
  return canonical;
}

async function existingPath(root: string, path: string, label: string, kind?: "file" | "directory"): Promise<string> {
  const absolute = projectPath(root, path, label);
  let canonical: string;
  try { canonical = await realpath(absolute); }
  catch { throw new Error(`${label} does not exist: ${path}`); }
  if (!inside(root, canonical)) throw new Error(`${label} resolves outside project: ${path}`);
  const info = await stat(canonical);
  if ((kind === "file" && !info.isFile()) || (kind === "directory" && !info.isDirectory())) throw new Error(`${label} must be a ${kind}: ${path}`);
  return canonical;
}
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function proposedPath(root: string, path: string): Promise<void> {
  const absolute = projectPath(root, path, "Proposed file");
  const exists = await lstat(absolute).then(
    () => true,
    (error: unknown) => {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    },
  );
  if (exists) throw new Error(`Proposed file already exists: ${path}`);
  let parent = dirname(absolute);
  for (;;) {
    const entry = await lstat(parent).then(
      (info) => info,
      (error: unknown) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      },
    );
    if (!entry) {
      const next = dirname(parent);
      if (next === parent) throw new Error(`Proposed file has no existing parent: ${path}`);
      parent = next;
      continue;
    }
    const canonical = await realpath(parent).catch((error: unknown) => {
      throw new Error(`Proposed file has an unresolved parent: ${path}`, { cause: error });
    });
    if (!inside(root, canonical)) throw new Error(`Proposed file resolves outside project: ${path}`);
    if (!(await stat(canonical)).isDirectory()) throw new Error(`Proposed file parent is not a directory: ${path}`);
    return;
  }
}

/** Parse one literal command, never execute a shell or resolve executables through PATH. */
function commandWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote = "";
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/\s/.test(char)) {
      if (current) { words.push(current); current = ""; }
    } else if (/[;&|<>`$\\]/.test(char)) throw new Error("Verification command must be one literal command; use a repository script for shell expressions");
    else current += char;
  }
  if (quote) throw new Error("Verification command has an unterminated quote");
  if (current) words.push(current);
  if (!words.length) throw new Error("Verification command must contain an executable");
  return words;
}

async function validateVerification(root: string, check: StructuredTask["verification"][number]): Promise<void> {
  const cwd = await existingPath(root, check.cwd, "Verification cwd", "directory");
  const evidence = await existingPath(root, check.evidencePath, "Verification evidencePath", "file");
  const source = await readFile(evidence, "utf8");
  const words = commandWords(check.command);
  const executable = words[0];
  if (!executable) throw new Error("Verification command must contain an executable");
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const manifest = await existingPath(root, relative(root, resolve(cwd, "package.json")), "Verification package.json", "file");
    if (evidence !== manifest) throw new Error("Package script verification evidencePath must be cwd/package.json");
    const explicitRun = words[1] === "run" || (executable === "npm" && words[1] === "run-script");
    if (!explicitRun && (executable === "bun" || !["test", "start", "stop", "restart"].includes(words[1] ?? ""))) throw new Error("Package verification must invoke a script with run (or a supported test/start alias)");
    const script = explicitRun ? words[2] : words[1];
    const scripts = record(record(JSON.parse(source), "package.json").scripts, "package.json scripts");
    if (!script || !Object.hasOwn(scripts, script) || typeof scripts[script] !== "string" || !scripts[script].trim()) throw new Error(`Verification command references missing package script: ${script ?? "(none)"}`);
    if (words.some((word) => /^(?:--(?:prefix|cwd|dir|workspace|workspaces)|-C|-w)(?:=|$)/.test(word))) throw new Error("Verification command must use its declared cwd, not a directory/workspace override");
    return;
  }
  const evidenceName = basename(evidence);
  const localManifest = dirname(evidence) === cwd;
  if (localManifest && executable === "go" && words[1] === "test" && evidenceName === "go.mod" && /^module\s+\S+/m.test(source)) return;
  if (localManifest && executable === "cargo" && ["test", "check", "clippy"].includes(words[1] ?? "") && evidenceName === "Cargo.toml" && /^\[(?:package|workspace)\]/m.test(source)) return;
  if (localManifest && executable === "make" && /^(?:GNUmakefile|[Mm]akefile)$/.test(evidenceName)) {
    const target = words[1];
    if (target && /^[A-Za-z0-9_.-]+$/.test(target) && source.split("\n").some((line) => line.split(":")[0]?.split(/\s+/).includes(target))) return;
    throw new Error(`Verification command references missing make target: ${target ?? "(none)"}`);
  }
  const interpreted = ["node", "python", "python3", "ruby", "bash", "sh", "deno"].includes(executable);
  const script = interpreted ? (executable === "deno" && words[1] === "run" ? words[2] : words[1]) : executable;
  if (script && !script.startsWith("-") && inside(root, resolve(cwd, script))) {
    const canonical = await realpath(resolve(cwd, script)).catch(() => undefined);
    if (canonical === evidence) return;
  }
  // A checked-in command reference can substantiate tools without a supported manifest format.
  if (source.split(/\r?\n/).some((line) => line.trim() === check.command || line.trim() === `\`${check.command}\`` || line.trim() === `$ ${check.command}`)) return;
  throw new Error(`Verification command is not substantiated by evidencePath: ${check.evidencePath}`);
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_{}<>#|]/g, (character) => `\\${character}`).replaceAll("[", "\\[").replaceAll("]", "\\]");
}

/** Exact label supplied to upstream hierarchy parsing, before its filename normalization. */
export function structuredHierarchyName(value: string): string {
  const label = text(value, "Hierarchy name").replace(/[`()]/g, "").replace(/[\\*{}<>#|[\]]/g, " ").replace(/\s+/g, " ").trim();
  if (!label) throw new Error("Hierarchy name must contain parser-safe text");
  return label;
}

/** Shared by preview, STRUCTURE.md, and the scaffold's persisted task contract. */
export function renderTaskContract(spec: StructuredPlan, task: StructuredTask): string {
  const descriptions = new Map(spec.acceptance.map((item) => [item.id, item.description]));
  const acceptance = (ids: string[]) => ids.map((id) => `${markdownText(id)} — ${markdownText(descriptions.get(id) ?? id)}`);
  const lines = [
    `Task ID: ${markdownText(task.id)}`, "", markdownText(task.description), "",
    `Dependencies: ${task.dependsOn.length ? task.dependsOn.map(markdownText).join(", ") : "none"}`,
    "", "Files:",
    ...(task.files.length ? task.files.map((file) => `- ${markdownText(file.path)} (${file.status})`) : ["- No file changes specified."]),
    "", "Implements:", ...(task.implements.length ? acceptance(task.implements).map((item) => `- ${item}`) : ["- None; supporting or verification task."]),
    "", "Verifies:", ...(task.verifies.length ? acceptance(task.verifies).map((item) => `- ${item}`) : ["- None; implementation or supporting task."]),
    "", "Verification:",
  ];
  for (const check of task.verification) {
    lines.push(`- Command: ${markdownText(check.command)}`, `  Cwd: ${markdownText(check.cwd)}`, `  Evidence: ${markdownText(check.evidencePath)}`, `  Expected: ${markdownText(check.expected)}`);
  }
  if (!task.verification.length) lines.push("- Covered by the linked acceptance verification tasks.");
  lines.push("", "Done When:");
  for (const item of acceptance(task.implements)) lines.push(`- [ ] Implemented: ${item}`);
  for (const item of acceptance(task.verifies)) lines.push(`- [ ] Verified: ${item}`);
  for (const id of new Set([...task.implements, ...task.verifies])) {
    if (id.includes("/")) lines.push(`- [ ] Acceptance: ${markdownText(id)} — ${markdownText(descriptions.get(id) ?? id)}`);
  }
  for (const check of task.verification) lines.push(`- [ ] ${markdownText(check.expected)} (${markdownText(check.command)} in ${markdownText(check.cwd)})`);
  if (!task.implements.length && !task.verifies.length && !task.verification.length) lines.push(`- [ ] ${markdownText(task.description)}`);
  return `${lines.join("\n")}\n`;
}

export async function prepareStructuredPlan(root: string, workingDir: string, name: string, spec: StructuredPlan): Promise<PreparedStructuredPlan> {
  const plan = parsePlan(spec);
  const festivalName = text(name, "Festival name");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(festivalName)) throw new Error("Festival name must be a lowercase slug");
  const camp = await realpath(root);
  const project = await resolveProjectRoot(camp, text(workingDir, "workingDir"));
  const tasks = plan.phases.flatMap((phase) => phase.sequences.flatMap((sequence) => sequence.tasks));
  const positions = new Map(tasks.map((task, index) => [task.id, index]));
  const acceptanceIds = new Set(plan.acceptance.map((item) => item.id));
  const implemented = new Set<string>();
  const verified = new Set<string>();
  const sequenceByTask = new Map<string, string>();
  const ancestors = new Map<string, Set<string>>();
  const implementations = new Map<string, { task: StructuredTask; index: number }[]>();
  uniqueNames(plan.phases.map((phase) => structuredPhaseName(phase.name)), "phases");
  for (const phase of plan.phases) {
    uniqueNames(phase.sequences.map((sequence) => nameKey(structuredHierarchyName(sequence.name))), `phase ${phase.id}`);
    for (const sequence of phase.sequences) {
      const sequenceName = nameKey(structuredHierarchyName(sequence.name));
      if (/(?:^|_)(?:planning|research|requirements|docs)$/.test(sequenceName)) throw new Error(`Sequence ${sequence.id} has a gate-excluded name suffix: ${sequence.name}`);
      uniqueNames(sequence.tasks.map((task) => nameKey(structuredHierarchyName(task.title))), `sequence ${sequence.id}`);
      for (const task of sequence.tasks) sequenceByTask.set(task.id, sequence.id);
    }
  }
  for (const item of plan.inspection) await existingPath(project, item.path, "Inspection path");
  for (const [index, task] of tasks.entries()) {
    const prerequisites = new Set<string>();
    for (const dependency of task.dependsOn) {
      const position = positions.get(dependency);
      if (position === undefined) throw new Error(`Unknown dependency ${dependency} in ${task.id}`);
      // A strict earlier-position requirement also proves the graph is acyclic.
      if (position >= index) throw new Error(`Dependency ${dependency} must be earlier in serialized execution order than ${task.id}; cycles are not allowed`);
      prerequisites.add(dependency);
      for (const ancestor of ancestors.get(dependency) ?? []) prerequisites.add(ancestor);
    }
    ancestors.set(task.id, prerequisites);
    for (const [ids, coverage] of [[task.implements, implemented], [task.verifies, verified]] as const) {
      for (const id of ids) {
        if (!acceptanceIds.has(id)) throw new Error(`Unknown acceptance ${id} in ${task.id}`);
        coverage.add(id);
      }
    }
    for (const id of task.implements) {
      const entries = implementations.get(id) ?? [];
      entries.push({ task, index });
      implementations.set(id, entries);
    }
    if (task.verifies.length && !task.verification.length) throw new Error(`Verification task ${task.id} requires a command, cwd, evidencePath and expected result`);
    for (const file of task.files) {
      if (file.status === "existing") await existingPath(project, file.path, "Existing file", "file");
      else await proposedPath(project, file.path);
    }
    for (const check of task.verification) await validateVerification(project, check);
  }
  for (const item of plan.acceptance) {
    if (!implemented.has(item.id)) throw new Error(`Acceptance ${item.id} has no implementation task`);
    if (!verified.has(item.id)) throw new Error(`Acceptance ${item.id} has no verification task`);
  }
  const necessary = new Set<string>();
  for (const [index, task] of tasks.entries()) {
    if (task.implements.length || task.verifies.length) {
      necessary.add(task.id);
      for (const ancestor of ancestors.get(task.id) ?? []) necessary.add(ancestor);
    }
    for (const id of task.verifies) {
      for (const { task: implementation, index: implementationIndex } of implementations.get(id) ?? []) {
        if (implementationIndex > index) throw new Error(`Verification task ${task.id} precedes implementation ${implementation.id} for ${id}`);
        if (sequenceByTask.get(implementation.id) !== sequenceByTask.get(task.id) && !ancestors.get(task.id)?.has(implementation.id)) {
          throw new Error(`Cross-sequence verification ${task.id} must depend on implementation ${implementation.id} for ${id}`);
        }
      }
    }
  }
  for (const task of tasks) {
    if (!necessary.has(task.id)) throw new Error(`Unnecessary task ${task.id}: link acceptance coverage or make it a prerequisite of covered work`);
  }
  const counts = { phases: plan.phases.length, sequences: plan.phases.reduce((total, phase) => total + phase.sequences.length, 0), tasks: tasks.length };
  const overview = [
    "## Festival Goal", markdownText(plan.goal), "", "## Scope", ...plan.scope.map((item) => `- ${markdownText(item)}`),
    "", "## Exclusions", ...(plan.exclusions.length ? plan.exclusions.map((item) => `- ${markdownText(item)}`) : ["- None."]),
    "", "## Acceptance", ...plan.acceptance.map((item) => `- ${markdownText(item.id)}: ${markdownText(item.description)}`),
    "", "## Repository Inspection", ...plan.inspection.map((item) => `- ${markdownText(item.path)}: ${markdownText(item.reason)}`),
    "", "## Open Questions", ...(plan.questions.length ? plan.questions.map((item) => `- Nonblocking: ${markdownText(item.question)}`) : ["- None."]),
  ];
  const hierarchy = ["## Hierarchy", `- **Festival:** ${festivalName}`];
  const contracts = ["## Task Contracts"];
  const work = ["## Work"];
  const verificationSummary = ["## Verification"];
  for (const [phaseIndex, phase] of plan.phases.entries()) {
    hierarchy.push(`  - **Phase ${phaseIndex + 1}:** ${structuredPhaseName(phase.name)} (${phase.type})`);
    work.push(`### ${structuredPhaseName(phase.name)} (${phase.type})`);
    for (const [sequenceIndex, sequence] of phase.sequences.entries()) {
      hierarchy.push(`    - Sequence ${sequenceIndex + 1}: ${structuredHierarchyName(sequence.name)}`);
      work.push(`Sequence: ${markdownText(sequence.name)}`);
      for (const [taskIndex, task] of sequence.tasks.entries()) {
        hierarchy.push(`      - Task ${taskIndex + 1}: ${structuredHierarchyName(task.title)}`);
        contracts.push("", `### ${markdownText(task.id)} — ${markdownText(task.title)}`, renderTaskContract(plan, task).trimEnd());
        work.push(`- ${markdownText(task.id)}: ${markdownText(task.title)}; Dependencies: ${task.dependsOn.map(markdownText).join(", ") || "none"}; Implements: ${task.implements.map(markdownText).join(", ") || "none"}; Verifies: ${task.verifies.map(markdownText).join(", ") || "none"}`);
        if (task.files.length) work.push(`  Files: ${task.files.map((file) => `${markdownText(file.path)} (${file.status})`).join("; ")}`);
        for (const check of task.verification) {
          verificationSummary.push(`- ${markdownText(task.id)}: ${markdownText(check.command)}; Cwd: ${markdownText(check.cwd)}; Evidence: ${markdownText(check.evidencePath)}; Expected: ${markdownText(check.expected)}`);
        }
      }
    }
  }
  const markdown = ["# Festival Structure", "", ...overview, "", ...hierarchy, "", ...contracts, ""].join("\n");
  const preview = [`# Approval Preview: ${festivalName}`, `Project: ${markdownText(workingDir)}`, `${counts.phases} phases · ${counts.sequences} sequences · ${counts.tasks} tasks`, "", ...overview, "", ...work, "", ...verificationSummary, ""].join("\n");
  const digest = createHash("sha256").update(JSON.stringify({ workingDir, plan, markdown })).digest("hex");
  return { markdown, preview, counts, digest };
}
