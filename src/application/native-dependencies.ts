import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { FestCli } from "../ports.js";

export interface NativeReadyTask {
  /** Festival-relative native filesystem identity, never an approved-plan label. */
  path: string;
  dependencies: string[];
}
export interface NativeReadySet {
  tasks: NativeReadyTask[];
  gatesEvaluated: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nativeTaskIdentity(festivalDir: string, input: string): string {
  if (!input.trim() || input.includes("\0")) throw new Error("Native dependency task identity is empty or invalid.");
  const path = relative(resolve(festivalDir), resolve(festivalDir, input));
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || !path.endsWith(".md")) {
    throw new Error(`Native dependency task is outside the festival or is not a task document: ${input}`);
  }
  return path.split(sep).join("/");
}

/** Decode the native execution front; gates and host dispatch constraints remain separate. */
export function parseNativeReadyTasks(festivalDir: string, value: unknown): NativeReadySet {
  if (!record(value) || !Array.isArray(value.tasks) || !Number.isInteger(value.count) ||
      value.count !== value.tasks.length || typeof value.gates_evaluated !== "boolean") {
    throw new Error("Invalid native fest deps --ready --all --json response: expected count, gates_evaluated and tasks.");
  }
  const seen = new Set<string>();
  const tasks = value.tasks.map((task: unknown): NativeReadyTask => {
    if (!record(task) || typeof task.path !== "string" || typeof task.id !== "string" ||
        typeof task.status !== "string" || !["pending", "in_progress"].includes(task.status)) {
      throw new Error("Invalid native ready-task record: expected task identity and an executable status.");
    }
    const path = nativeTaskIdentity(festivalDir, task.path);
    if (nativeTaskIdentity(festivalDir, task.id) !== path || seen.has(path)) {
      throw new Error(`Ambiguous or duplicate native ready-task identity: ${task.path}`);
    }
    seen.add(path);
    if (task.dependencies !== null && !Array.isArray(task.dependencies)) throw new Error(`Invalid native dependencies for ${path}`);
    const dependencies = (task.dependencies ?? []).map((dependency: unknown) => {
      if (typeof dependency !== "string") throw new Error(`Invalid native dependency identity for ${path}`);
      return nativeTaskIdentity(festivalDir, resolve(festivalDir, dirname(path), dependency));
    });
    return { path, dependencies };
  });
  return { tasks, gatesEvaluated: value.gates_evaluated };
}

export async function readNativeReadyTasks(fest: Pick<FestCli, "raw">, festivalDir: string): Promise<NativeReadySet> {
  const result = await fest.raw(festivalDir, ["deps", "--ready", "--all", "--json"]);
  if (result.code !== 0) throw new Error(`Native dependency readiness failed (exit ${result.code}): ${result.stderr || result.stdout}`);
  let value: unknown;
  try { value = JSON.parse(result.stdout); }
  catch { throw new Error("Native fest deps --ready --all did not return valid JSON."); }
  return parseNativeReadyTasks(festivalDir, value);
}

/** Stamp actual scaffold filenames, not plan labels, in the native resolver's accepted YAML subset. */
export function applyNativeDependencies(document: string, taskPath: string, dependencyIds: readonly string[], taskPaths: ReadonlyMap<string, string>): string {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
  if (frontmatter?.[1] === undefined) throw new Error(`Task is missing frontmatter: ${taskPath}`);
  const identityRoot = "/__omp_fest_dependency_root__";
  const task = nativeTaskIdentity(identityRoot, taskPath);
  const dependencies = [...new Set(dependencyIds)].map((id) => {
    const target = taskPaths.get(id);
    if (!target) throw new Error(`Unknown approved dependency ${id} in ${taskPath}`);
    const canonical = nativeTaskIdentity(identityRoot, target);
    if (canonical === task) throw new Error(`Task cannot depend on itself: ${taskPath}`);
    const reference = relative(dirname(task), canonical).split(sep).join("/");
    // Native 0.9.x does not unquote dependency list items; reject unsafe plain YAML.
    if (!/^[A-Za-z0-9_./-]+$/.test(reference)) throw new Error(`Task filename cannot be represented in native dependency metadata: ${target}`);
    return reference;
  });
  const metadata = frontmatter[1].replace(/^fest_dependencies:[^\r\n]*(?:\r?\n(?:[ \t]+[^\r\n]*|[ \t]*))*$/gm, "")
    .replace(/^# Dependencies: none \| Native dependency metadata follows\.\r?\n?/gm, "").trim();
  // Native's legacy body parser matches the substring in fest_dependencies too.
  // Its first match must terminate at a pipe before native frontmatter is parsed.
  const sentinel = "# Dependencies: none | Native dependency metadata follows.";
  const block = dependencies.length ? `fest_dependencies:\n${dependencies.map((path) => `  - ${path}`).join("\n")}\n` : "";
  return `---\n${sentinel}\n${metadata}\n${block}---\n${document.slice(frontmatter[0].length)}`;
}
