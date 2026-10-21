import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { prepareStructuredPlan, renderTaskContract, structuredHierarchyName, structuredPhaseName, type StructuredPlan, type PreparedStructuredPlan } from "./structured-plan.js";

export interface PlanArtifact {
  name: string;
  workingDir: string;
  rules: string;
  referencesDir?: string;
  spec: StructuredPlan;
}

export interface ApprovedPlan extends PreparedStructuredPlan {
  artifact: PlanArtifact;
  plan: string;
  planRevision: string;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function artifactPath(root: string, plan: string, name: string): Promise<string> {
  const base = await realpath(root);
  const path = resolve(root, plan);
  const plans = join(base, ".ompfest", "plans");
  if (!inside(plans, path) || dirname(path) !== plans || basename(path) !== `${name}.STRUCTURE.md`) {
    throw new Error(`Plan must be ${name}.STRUCTURE.md directly inside this camp's .ompfest/plans directory`);
  }
  let current = base;
  for (const part of relative(base, dirname(path)).split(sep)) {
    current = join(current, part);
    await mkdir(current).catch((error: unknown) => { if (errorCode(error) !== "EEXIST") throw error; });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe plan directory: ${current}`);
  }
  for (const target of [path, `${path}.json`, `${path}.preview.md`]) {
    const info = await lstat(target).catch((error: unknown) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error(`Unsafe plan artifact: ${target}`);
  }
  return path;
}

function planRevision(artifact: PlanArtifact, markdown: string, references: { path: string; content: string }[] = []): string {
  return createHash("sha256").update(JSON.stringify({ artifact, markdown, references })).digest("hex");
}

export async function previewPlan(root: string, plan: string, artifact: PlanArtifact, references: { path: string; content: string }[] = []) {
  const prepared = await prepareStructuredPlan(root, artifact.workingDir, artifact.name, artifact.spec);
  const path = await artifactPath(root, plan, artifact.name);
  const revision = planRevision(artifact, prepared.markdown, references);
  await writeFile(path, prepared.markdown);
  await writeFile(`${path}.json`, JSON.stringify(artifact, null, 2) + "\n");
  await writeFile(`${path}.preview.md`, prepared.preview);
  return { ...prepared, plan: path, previewFile: `${path}.preview.md`, planRevision: revision };
}

export async function approvedPlan(root: string, plan: string, name: string, revision: string, references: { path: string; content: string }[] = []): Promise<ApprovedPlan> {
  const path = await artifactPath(root, plan, name);
  const artifact = JSON.parse(await readFile(`${path}.json`, "utf8")) as PlanArtifact;
  if (artifact.name !== name) throw new Error("Plan artifact festival name does not match requested name");
  const prepared = await prepareStructuredPlan(root, artifact.workingDir, artifact.name, artifact.spec);
  const markdown = await readFile(path, "utf8");
  if (markdown !== prepared.markdown || planRevision(artifact, markdown, references) !== revision) {
    throw new Error("Plan or references changed since approval. Preview again and obtain approval for the new planRevision.");
  }
  return { ...prepared, artifact, plan: path, planRevision: revision };
}

function scaffoldName(content: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  const value = frontmatter?.match(/^fest_name:\s*(.*?)\s*$/m)?.[1];
  if (value?.startsWith('"')) return JSON.parse(value) as string;
  if (value?.startsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

async function checkScaffoldName(path: string, expected: string): Promise<void> {
  if (scaffoldName(await readFile(path, "utf8")) !== expected) {
    throw new Error(`Scaffold name differs from approved plan: ${path}`);
  }
}
// Run before quality gates add their own tasks. Numeric positions are the parser's execution order.
export async function installApprovedTasks(festival: string, artifact: PlanArtifact): Promise<void> {
  const numbered = async (path: string, type: "directory" | "file") => (await readdir(path, { withFileTypes: true }))
    .filter((entry) => /^\d+_/.test(entry.name) && (type === "directory" ? entry.isDirectory() : entry.isFile() && entry.name.endsWith(".md")))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const phases = await numbered(festival, "directory");
  if (phases.length !== artifact.spec.phases.length) throw new Error("Scaffold phase tree differs from approved plan");
  const writes: { path: string; content: string }[] = [];
  for (const [p, phase] of artifact.spec.phases.entries()) {
    const phaseEntry = phases[p];
    if (!phaseEntry) throw new Error(`Scaffold phase missing at position ${p + 1}`);
    const phaseDir = join(festival, phaseEntry.name);
    if (Number.parseInt(phaseEntry.name) !== p + 1) throw new Error("Scaffold phase order differs from approved plan");
    await checkScaffoldName(join(phaseDir, "PHASE_GOAL.md"), structuredPhaseName(phase.name).toLowerCase());
    const sequences = await numbered(phaseDir, "directory");
    if (sequences.length !== phase.sequences.length) throw new Error(`Scaffold sequences differ for ${phase.id}`);
    for (const [s, sequence] of phase.sequences.entries()) {
      const sequenceEntry = sequences[s];
      if (!sequenceEntry) throw new Error(`Scaffold sequence missing at position ${s + 1} in ${phase.id}`);
      const sequenceDir = join(phaseDir, sequenceEntry.name);
      if (Number.parseInt(sequenceEntry.name) !== s + 1) throw new Error("Scaffold sequence order differs from approved plan");
      await checkScaffoldName(join(sequenceDir, "SEQUENCE_GOAL.md"), structuredHierarchyName(sequence.name));
      const tasks = await numbered(sequenceDir, "file");
      if (tasks.length !== sequence.tasks.length) throw new Error(`Scaffold tasks differ for ${sequence.id}`);
      for (const [t, task] of sequence.tasks.entries()) {
        const taskEntry = tasks[t];
        if (!taskEntry) throw new Error(`Scaffold task missing at position ${t + 1} in ${sequence.id}`);
        const path = join(sequenceDir, taskEntry.name);
        const taskContent = await readFile(path, "utf8");
        const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(taskContent)?.[0];
        if (!frontmatter) throw new Error(`Scaffold task is missing frontmatter: ${path}`);
        if (Number.parseInt(taskEntry.name) !== t + 1 || scaffoldName(taskContent) !== structuredHierarchyName(task.title)) {
          throw new Error(`Scaffold task differs from approved plan: ${path}`);
        }
        const pages = [...new Set([...task.implements, ...task.verifies]
          .filter((id) => /^[a-z0-9]+(?:-[a-z0-9]+)*\/AC-\d+$/.test(id))
          .map((id) => id.slice(0, id.indexOf("/"))))];
        const links = pages
          .map((page) => `Visual reference: references/pages/${page}/PAGE.md`)
          .filter((link) => !taskContent.includes(link));
        const contract = renderTaskContract(artifact.spec, task).trim();
        writes.push({
          path,
          content: [taskContent.trimEnd(), ...(links.length ? [links.join("\n")] : []), "## Approved Plan Contract", contract].join("\n\n") + "\n",
        });
      }
    }
  }
  for (const write of writes) await writeFile(write.path, write.content);
  await writeFile(join(festival, "APPROVED_PLAN.json"), JSON.stringify(artifact, null, 2) + "\n");
}
