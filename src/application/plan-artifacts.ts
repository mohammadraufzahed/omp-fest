import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { prepareStructuredPlan, type StructuredPlan, type PreparedStructuredPlan } from "./structured-plan.js";

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
  for (const target of [path, `${path}.json`, `${path}.preview.md`, `${path}.status.json`]) {
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

/** Record completed scaffold state separately so the immutable approval digest remains valid. */
export async function markPlanScaffolded(root: string, plan: string, name: string, revision: string, festivalDir: string, references: { path: string; content: string }[] = []): Promise<void> {
  const approved = await approvedPlan(root, plan, name, revision, references);
  const status = `${approved.plan}.status.json`, temp = `${status}.${randomUUID()}.tmp`;
  await artifactPath(root, plan, name);
  const existing = await lstat(status).catch((error: unknown) => { if (errorCode(error) === "ENOENT") return undefined; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Unsafe plan status artifact.");
  try {
    const file = await open(temp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ state: "scaffolded", festivalDir, planRevision: revision, completedAt: new Date().toISOString() }) + "\n"); }
    finally { await file.close(); }
    await rename(temp, status);
  } finally { await unlink(temp).catch(() => undefined); }
}

