import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseStructuredPlan, prepareStructuredPlan, type StructuredPlan, type PreparedStructuredPlan } from "./structured-plan.js";
import { prepareVisualReferences } from "./visual-references.js";
import { withStaleAwareLock } from "./fs-lock.js";
import { writeAtomically } from "./fs-atomic.js";
import { captureNativeWorkflowTemplates } from "./plan-scaffold.js";

export interface PlanArtifact {
  name: string;
  workingDir: string;
  rules: string;
  referencesDir?: string;
  spec: StructuredPlan;
  /** Explicit values for camp-specific template marker hints; included in human approval digest. */
  templateMarkers?: Record<string, string>;
  /** Native workflow documents reviewed with this exact revision, not live templates at execution. */
  nativeWorkflowTemplates?: Record<string, string>;
  previewId?: string;
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
async function withArtifactLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  try {
    return await withStaleAwareLock(`${path}.lock`, action, { label: "Plan preview" });
  } catch (error) {
    if (error instanceof Error && error.name === "LockBusyError") throw new Error("Plan preview is being saved; retry after it completes", { cause: error });
    throw error;
  }
}



async function readArtifact(path: string): Promise<PlanArtifact> {
  try {
    const value: unknown = JSON.parse(await readFile(`${path}.json`, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const artifact = value as Partial<PlanArtifact>;
    if (typeof artifact.name !== "string" || typeof artifact.workingDir !== "string" || typeof artifact.rules !== "string" || !artifact.spec || typeof artifact.spec !== "object") throw new Error();
    return artifact as PlanArtifact;
  } catch {
    throw new Error("Saved plan artifact is invalid or corrupted; create a fresh preview");
  }
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
  artifact = { ...artifact, spec: parseStructuredPlan(artifact.spec) };
  const nativeWorkflowTemplates = artifact.nativeWorkflowTemplates ?? await captureNativeWorkflowTemplates(root, artifact.spec);
  artifact = { ...artifact, nativeWorkflowTemplates };
  const prepared = await prepareStructuredPlan(root, artifact.workingDir, artifact.name, artifact.spec);
  const nativeWorkflows = Object.entries(nativeWorkflowTemplates).map(([id, content]) => `## Native Workflow: ${id}\n\n${content}`).join("\n\n");
  if (nativeWorkflows) prepared.preview += `\n${nativeWorkflows}\n`;
  if (artifact.templateMarkers && Object.keys(artifact.templateMarkers).length) prepared.preview += `\n## Reviewed Template Marker Values\n\n${Object.entries(artifact.templateMarkers).map(([hint, value]) => `- ${JSON.stringify(hint)}: ${JSON.stringify(value)}`).join("\n")}\n`;
  const path = await artifactPath(root, plan, artifact.name);
  return withArtifactLock(path, async () => {
    const previewArtifact = { ...artifact, previewId: randomUUID() };
    const revision = planRevision(previewArtifact, prepared.markdown, references);
    await writeAtomically(path, prepared.markdown);
    await writeAtomically(`${path}.preview.md`, prepared.preview);
    await writeAtomically(`${path}.json`, JSON.stringify(previewArtifact, null, 2) + "\n");
    await writeAtomically(`${path}.status.json`, JSON.stringify({ state: "saved_preview", planRevision: revision, previewFile: `${path}.preview.md`, message: "Saved approval preview; no festival scaffold has been created." }) + "\n");
    return { ...prepared, plan: path, previewFile: `${path}.preview.md`, planRevision: revision, previewState: "saved_preview" as const, previewMessage: "Saved approval preview; no festival scaffold has been created." };
  });
}

async function currentPlanUnlocked(root: string, path: string, name: string, revision: string, references: { path: string; content: string }[]): Promise<PlanArtifact> {
  const artifact = await readArtifact(path);
  if (artifact.name !== name) throw new Error("Saved plan artifact is invalid or corrupted; create a fresh preview");
  const prepared = await prepareStructuredPlan(root, artifact.workingDir, artifact.name, artifact.spec);
  const markdown = await readFile(path, "utf8");
  const currentReferences = artifact.referencesDir
    ? (await prepareVisualReferences(root, path, artifact.referencesDir)).files
    : references;
  if (markdown !== prepared.markdown || planRevision(artifact, markdown, currentReferences) !== revision) {
    throw new Error("Plan or references changed since approval. Preview again and obtain approval for the new planRevision.");
  }
  return artifact;
}

export async function markPlanApproved(root: string, plan: string, name: string, revision: string, references: { path: string; content: string }[] = []): Promise<void> {
  const path = await artifactPath(root, plan, name);
  await withArtifactLock(path, async () => {
    await currentPlanUnlocked(root, path, name, revision, references);
    await writeAtomically(`${path}.status.json`, JSON.stringify({ state: "approved", planRevision: revision, approvedAt: new Date().toISOString() }) + "\n");
  });
}

export async function abandonPlanPreview(root: string, plan: string, name: string, revision: string, state: "rejected" | "cancelled"): Promise<void> {
  const path = await artifactPath(root, plan, name);
  await withArtifactLock(path, async () => {
    const artifact = await readArtifact(path);
    if (artifact.name !== name) throw new Error("Saved plan artifact is invalid or corrupted; create a fresh preview");
    let status: unknown;
    try { status = JSON.parse(await readFile(`${path}.status.json`, "utf8")); }
    catch { throw new Error("Saved plan status is invalid or corrupted; refusing to abandon an unknown revision"); }
    if (!status || typeof status !== "object" || !("planRevision" in status) || status.planRevision !== revision ||
        !("state" in status) || !["saved_preview", "approved"].includes(String(status.state))) {
      throw new Error("Plan status changed; refusing to abandon a different or inactive revision.");
    }
    await writeAtomically(`${path}.status.json`, JSON.stringify({ state, planRevision: revision, completedAt: new Date().toISOString() }) + "\n");
  });
}

async function approvedPlanUnlocked(root: string, path: string, name: string, revision: string, references: { path: string; content: string }[]): Promise<ApprovedPlan> {
  const artifact = await currentPlanUnlocked(root, path, name, revision, references);
  let status: unknown;
  try { status = JSON.parse(await readFile(`${path}.status.json`, "utf8")); }
  catch { throw new Error("Plan has no valid approval status; obtain human approval before scaffolding."); }
  if (!status || typeof status !== "object" || !("state" in status) || status.state !== "approved" ||
      !("planRevision" in status) || status.planRevision !== revision) {
    throw new Error("This planRevision has not been approved by a human; preview and approve it before scaffolding.");
  }
  const prepared = await prepareStructuredPlan(root, artifact.workingDir, artifact.name, artifact.spec);
  return { ...prepared, artifact, plan: path, planRevision: revision };
}


export async function approvedPlan(root: string, plan: string, name: string, revision: string, references: { path: string; content: string }[] = []): Promise<ApprovedPlan> {
  const path = await artifactPath(root, plan, name);
  return withArtifactLock(path, () => approvedPlanUnlocked(root, path, name, revision, references));
}

/** Record completed scaffold state separately so the immutable approval digest remains valid. */
export interface PlanPreviewInfo {
  name: string;
  plan: string;
  state: string;
  planRevision?: string;
  updatedAt?: string;
}

/** List every plan preview/status in .ompfest/plans — drafts plus scaffolded, approved, rejected, cancelled, expired. */
export async function listPlanPreviews(root: string): Promise<PlanPreviewInfo[]> {
  const plans = join(await realpath(root), ".ompfest", "plans");
  const entries = await readdir(plans).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return [] as string[];
    throw error;
  });
  const result: PlanPreviewInfo[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".STRUCTURE.md.status.json")) continue;
    const name = entry.slice(0, -".STRUCTURE.md.status.json".length);
    const path = join(plans, entry);
    try {
      const status: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!status || typeof status !== "object" || !("state" in status) || typeof status.state !== "string") continue;
      const row = status as Record<string, unknown>;
      result.push({
        name,
        plan: join(plans, `${name}.STRUCTURE.md`),
        state: row.state as string,
        ...(typeof row.planRevision === "string" ? { planRevision: row.planRevision } : {}),
        ...(typeof row.completedAt === "string" ? { updatedAt: row.completedAt }
          : typeof row.approvedAt === "string" ? { updatedAt: row.approvedAt } : {}),
      });
    } catch { /* corrupt status files are skipped, not surfaced as previews */ }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Mark saved/approved previews older than a TTL as expired — never deletes artifacts. */
export async function expireStalePlanPreviews(root: string, ttlMs = 24 * 60 * 60_000, nowMs = Date.now()): Promise<string[]> {
  const expired: string[] = [];
  for (const preview of await listPlanPreviews(root)) {
    if (preview.state !== "saved_preview" && preview.state !== "approved") continue;
    const info = await lstat(`${preview.plan}.status.json`).catch(() => undefined);
    const age = info ? nowMs - info.mtimeMs : Number.POSITIVE_INFINITY;
    if (age <= ttlMs) continue;
    try {
      await withArtifactLock(preview.plan, async () => {
        const statusPath = `${preview.plan}.status.json`;
        const current: unknown = JSON.parse(await readFile(statusPath, "utf8"));
        if (!current || typeof current !== "object" || !("state" in current) ||
            (current.state !== "saved_preview" && current.state !== "approved")) return;
        await writeAtomically(statusPath, JSON.stringify({ ...(current as Record<string, unknown>), state: "expired", expiredAt: new Date(nowMs).toISOString() }) + "\n");
      });
      expired.push(preview.name);
    } catch { /* preview changed under us; leave it alone */ }
  }
  return expired;
}

export async function markPlanScaffolded(root: string, plan: string, name: string, revision: string, festivalDir: string, references: { path: string; content: string }[] = []): Promise<void> {
  const path = await artifactPath(root, plan, name);
  await withArtifactLock(path, async () => {
    const approved = await approvedPlanUnlocked(root, path, name, revision, references);
    const status = `${approved.plan}.status.json`;
    const existing = await lstat(status).catch((error: unknown) => { if (errorCode(error) === "ENOENT") return undefined; throw error; });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Unsafe plan status artifact.");
    await writeAtomically(status, JSON.stringify({ state: "scaffolded", festivalDir, planRevision: revision, completedAt: new Date().toISOString() }) + "\n");
  });
}

