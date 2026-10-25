import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { withStaleAwareLock } from "./fs-lock.js";
import { previewPlan, type PlanArtifact } from "./plan-artifacts.js";
import { inferVerificationProvenancePath } from "./plan-input.js";
import { prepareStructuredPlan, validatePlanRepository, type PlanVerification, type StructuredPlan } from "./structured-plan.js";
import { planningDiagnostics, type PlanningDiagnostic } from "./planning-errors.js";
import type { ClassifiedAttachment } from "../domain/reference-classification.js";

/** Editable observations only. Missing verification is never invented to make a draft approvable. */
export interface PlanDraftFields {
  name: string;
  goal?: string;
  scope?: string[];
  acceptance?: string[];
  inspection?: { path: string; reason: string }[];
  workingDir?: string;
  exclusions?: string[];
  files?: string[];
  verification?: Partial<PlanVerification> | null;
  visualIntent?: "ui_visual" | "document_or_pdf" | "backend_or_api" | "bug_diagnostic" | "mixed" | "unknown";
  attachments?: ClassifiedAttachment[];
  rules?: string;
  referencesDir?: string;
  spec?: StructuredPlan;
  templateMarkers?: Record<string, string>;
}

export interface PlanDraft {
  draftId: string;
  revision: string;
  fields: PlanDraftFields;
  spec: StructuredPlan;
  missing: string[];
  diagnostics: PlanningDiagnostic[];
  plan: string;
}

function relativePath(value: string, label: string): void {
  let control = false;
  for (const character of value) {
    if (character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127) control = true;
  }
  if (!value || isAbsolute(value) || value.includes("\\") || /^[A-Za-z]:/.test(value) || value.split("/").includes("..") || control) {
    throw new Error(`${label} must be a safe relative path`);
  }
}

function referencePathIssue(fields: PlanDraftFields): string | undefined {
  if (!fields.referencesDir) return undefined;
  const expected = `.ompfest/plans/${fields.name}.references`;
  return fields.referencesDir === expected
    ? undefined
    : `referencesDir must be "${expected}" to match the final festival name; generate the wireframes after choosing the name`;
}

function validate(fields: PlanDraftFields, root: string): PlanDraftFields {
  const result = structuredClone(fields);
  if (result.templateMarkers) for (const [hint, value] of Object.entries(result.templateMarkers)) {
    if (!hint.trim() || typeof value !== "string" || !value.trim() || /\[(?:FILL|REPLACE):/.test(value)) throw new Error("templateMarkers requires nonempty hint/value mappings without unresolved markers");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.name)) throw new Error("Festival name must be a lowercase slug");
  if (result.acceptance && new Set(result.acceptance).size !== result.acceptance.length) throw new Error("Acceptance statements must be unique");
  if (result.workingDir && isAbsolute(result.workingDir)) {
    const rel = relative(root, resolve(result.workingDir));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("workingDir must be camp-relative; use the camp's linked project path");
    result.workingDir = rel.split(sep).join("/") || ".";
  }
  if (result.workingDir) relativePath(result.workingDir, "workingDir");
  for (const path of result.files ?? []) relativePath(path, "File");
  for (const item of result.inspection ?? []) relativePath(item.path, "Inspection path");
  if (result.referencesDir) {
    const referenceIssue = referencePathIssue(result);
    if (referenceIssue) throw new Error(referenceIssue);
    relativePath(result.referencesDir, "referencesDir");
    if (result.visualIntent !== "ui_visual" || !result.attachments?.some((item) => item.role === "ui_design")) throw new Error("Wireframes require explicit ui_visual intent and at least one attachment classified as ui_design.");
  }
  if (result.verification) {
    result.verification.cwd ??= ".";
    relativePath(result.verification.cwd, "Verification cwd");
    result.verification.provenancePath ??= inferVerificationProvenancePath(result.verification.command, result.verification.cwd);
    if (result.verification.provenancePath) relativePath(result.verification.provenancePath, "Verification provenancePath");
  }
  if (result.spec) {
    for (const phase of result.spec.phases) if (!Array.isArray(phase.sequences)) phase.sequences = [];
    for (const item of result.spec.inspection) relativePath(item.path, "Inspection path");
    for (const task of result.spec.phases.flatMap((phase) => (Array.isArray(phase.sequences) ? phase.sequences : []).flatMap((sequence) => sequence.tasks))) {
      for (const file of task.files) relativePath(file.path, "File");
      for (const check of task.verification) {
        check.cwd ??= ".";
        const inferredEvidence = inferVerificationProvenancePath(check.command, check.cwd);
        if (!check.provenancePath && inferredEvidence) check.provenancePath = inferredEvidence;
        relativePath(check.cwd, "Verification cwd");
        if (check.provenancePath) relativePath(check.provenancePath, "Verification provenancePath");
      }
    }
  }
  return result;
}

function build(root: string, draftId: string, fields: PlanDraftFields, previous?: PlanDraft): PlanDraft {
  // Preserve IDs through edits and reordering of existing acceptance statements.
  const prior = previous?.spec.acceptance ?? [];
  const used = new Set(prior.map((item) => item.id));
  const assigned = new Set<string>();
  const descriptions = new Set(fields.acceptance ?? []);
  const acceptance = (fields.acceptance ?? []).map((description, position) => {
    const atPosition = prior[position];
    const existing = prior.find((item) => item.description === description && !assigned.has(item.id))
      ?? (atPosition && !descriptions.has(atPosition.description) && !assigned.has(atPosition.id) ? atPosition : undefined);
    if (existing) {
      assigned.add(existing.id);
      return { id: existing.id, description };
    }
    let index = 1;
    while (used.has(`ac-${index}`)) index++;
    const id = `ac-${index}`;
    used.add(id);
    assigned.add(id);
    return { id, description };
  });
  const check = fields.verification;
  const draftVerification: PlanVerification[] = check?.expected && ((check.kind ?? "command") === "command" ? check.command : check.procedure)
    ? [{ ...check, expected: check.expected }]
    : [];
  const spec = fields.spec ?? {
    goal: fields.goal ?? "", scope: fields.scope ?? [], exclusions: fields.exclusions ?? [], acceptance,
    questions: [], inspection: fields.inspection ?? [],
    phases: [{ id: "build", name: "BUILD", type: "implementation",
      objective: "Deliver the approved small, single-lane change",
      deliverables: [fields.goal ?? "The approved change"],
      completionCriteria: acceptance.map((item) => item.description),
      sequences: [{ id: "implementation", name: "IMPLEMENT", tasks: [{
        id: "implement", title: fields.goal ?? "", description: fields.goal ?? "", dependsOn: [],
        implements: acceptance.map((item) => item.id), verifies: acceptance.map((item) => item.id),
        files: (fields.files ?? []).map((path) => ({ path, status: "existing" })),
        verification: draftVerification,
      }] }],
    }],
  } satisfies StructuredPlan;
  const missingCheck = (check: Partial<PlanVerification>, label: string) => [
    ...((check.kind ?? "command") === "command" ? (!check.command ? [`${label}.command`] : []) : (!check.procedure ? [`${label}.procedure`] : [])),
    ...(!check.expected ? [`${label}.expected`] : []),
  ];
  const verificationMissing = fields.spec
    ? spec.phases.flatMap((phase) => phase.sequences.flatMap((sequence) => sequence.tasks.flatMap((task) => task.verifies.length && !task.verification.length
      ? [`verification for ${task.id}`] : task.verification.flatMap((check) => missingCheck(check, `task.${task.id}.verification`)))))
    : !check ? ["verification"] : missingCheck(check, "verification");
  const needsExecutionContract = spec.phases.some((phase) => phase.type === "implementation");
  const missing = [
    ...(!spec.goal.trim() ? ["goal"] : []), ...(!spec.scope.length ? ["scope"] : []),
    ...(needsExecutionContract && !spec.acceptance.length ? ["acceptance"] : []), ...(needsExecutionContract && !spec.inspection.length ? ["inspection"] : []),
    ...(!fields.spec ? ["full structured spec with meaningful milestone phases"] : []),
    ...(!fields.workingDir ? ["workingDir"] : []), ...verificationMissing,
    ...(fields.attachments ?? []).filter((item) => item.role === "unknown").map((item) => `attachment role: ${item.name}`),
  ];
  const revision = createHash("sha256").update(JSON.stringify({ draftId, fields, spec, previous: previous?.revision })).digest("hex");
  return { draftId, revision, fields, spec, missing, diagnostics: [], plan: join(root, ".ompfest", "plans", `${fields.name}.STRUCTURE.md`) };
}

async function semanticDraft(root: string, draft: PlanDraft): Promise<PlanDraft> {
  if (!draft.fields.workingDir) return draft;
  const diagnostics = await validatePlanRepository(root, draft.fields.workingDir, draft.spec);
  if (!draft.missing.length) {
    try { await prepareStructuredPlan(root, draft.fields.workingDir, draft.fields.name, draft.spec); }
    catch (error) { diagnostics.push(...planningDiagnostics([error])); }
  }
  const unique = [...new Map(diagnostics.map((item) => [JSON.stringify(item), item])).values()];
  return { ...draft, diagnostics: unique };
}

async function location(root: string, draftId: string): Promise<{ root: string; file: string }> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draftId)) throw new Error("Invalid draftId");
  const base = await realpath(root);
  let dir = base;
  for (const part of [".ompfest", "plans"]) {
    dir = join(dir, part);
    await mkdir(dir).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe draft directory: ${dir}`);
  }
  const file = join(dir, `${draftId}.draft.json`);
  const info = await lstat(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isFile())) throw new Error(`Unsafe draft file: ${file}`);
  return { root: base, file };
}

export async function createPlanDraft(root: string, fields: PlanDraftFields): Promise<PlanDraft> {
  const draftId = `draft-${randomUUID()}`;
  const target = await location(root, draftId);
  const draft = await semanticDraft(target.root, build(target.root, draftId, validate(fields, target.root)));
  const file = await open(target.file, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(draft, null, 2) + "\n"); }
  finally { await file.close(); }
  return draft;
}

export async function readPlanDraft(root: string, draftId: string): Promise<PlanDraft> {
  const target = await location(root, draftId);
  try {
    const draft: unknown = JSON.parse(await readFile(target.file, "utf8"));
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) throw new Error();
    const value = draft as Partial<PlanDraft>;
    if (value.draftId !== draftId || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)
      || !value.fields || typeof value.fields !== "object" || !value.spec || typeof value.spec !== "object"
      || !Array.isArray(value.missing) || typeof value.plan !== "string") throw new Error();
    if (!Array.isArray(value.spec.phases) || !Array.isArray(value.spec.acceptance) || typeof value.spec.goal !== "string") throw new Error();
    const saved = value as PlanDraft;
    const hasMilestoneContracts = saved.spec.phases.every((phase) =>
      typeof phase.objective === "string" && !!phase.objective.trim()
      && Array.isArray(phase.deliverables) && phase.deliverables.length > 0
      && phase.deliverables.every((item) => typeof item === "string" && !!item.trim())
      && Array.isArray(phase.completionCriteria) && phase.completionCriteria.length > 0
      && phase.completionCriteria.every((item) => typeof item === "string" && !!item.trim()));
    const referencesIssue = referencePathIssue(saved.fields);
    const missing = [
      ...saved.missing,
      ...(!hasMilestoneContracts ? ["full structured spec with phase objectives, deliverables and completion criteria"] : []),
      ...(referencesIssue ? [referencesIssue] : []),
    ];
    return await semanticDraft(target.root, { ...saved, missing: [...new Set(missing)], diagnostics: [] });
  } catch (error) {
    throw new Error("Invalid persisted plan draft", { cause: error });
  }
}

/** Preview under the same lock as edits so an older revision cannot save after a newer edit. */
export async function previewPlanDraft(root: string, draftId: string, revision: string, references: { path: string; content: string }[] = []) {
  const target = await location(root, draftId);
  return withStaleAwareLock(`${target.file}.lock`, async () => {
    const draft = await readPlanDraft(root, draftId);
    if (draft.revision !== revision) throw new Error("Stale draft revision; read the current draft before previewing");
    if (draft.missing.length || !draft.fields.workingDir) throw new Error(`Draft is incomplete: ${draft.missing.join(", ")}`);
    const artifact: PlanArtifact = {
      name: draft.fields.name, workingDir: draft.fields.workingDir, rules: draft.fields.rules ?? "", spec: draft.spec,
      ...(draft.fields.referencesDir ? { referencesDir: draft.fields.referencesDir } : {}),
      ...(draft.fields.templateMarkers ? { templateMarkers: draft.fields.templateMarkers } : {}),
    };
    return { ...await previewPlan(root, draft.plan, artifact, references), draftId, draftRevision: revision };
  }, { label: "Plan draft" }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "LockBusyError") throw new Error("Draft is being edited; read its current revision before previewing");
    throw error;
  });
}

/** A field patch replaces only supplied fields; a stale revision never overwrites newer work. */
export async function updatePlanDraft(root: string, draftId: string, revision: string, patch: Partial<PlanDraftFields>): Promise<PlanDraft> {
  const target = await location(root, draftId);
  return withStaleAwareLock(`${target.file}.lock`, async () => updatePlanDraftUnlocked(target, draftId, revision, patch), { label: "Plan draft" })
    .catch((error: unknown) => {
      if (error instanceof Error && error.name === "LockBusyError") throw new Error("Draft is being edited; read its current revision before updating");
      throw error;
    });
}

async function updatePlanDraftUnlocked(target: { root: string; file: string }, draftId: string, revision: string, patch: Partial<PlanDraftFields>): Promise<PlanDraft> {
  const temporary = `${target.file}.${randomUUID()}.tmp`;
  try {
    const previous = await readPlanDraft(target.root, draftId);
    if (previous.revision !== revision) throw new Error("Stale draft revision; read the current draft before editing");
    const verification = patch.verification && previous.fields.verification
      ? { ...previous.fields.verification, ...patch.verification }
      : patch.verification;
    const merged = { ...previous.fields, ...patch, ...(verification !== undefined ? { verification } : {}) };
    const fields = validate(merged, target.root);
    if (previous.fields.spec && patch.spec === undefined) {
      if (patch.files !== undefined || patch.verification !== undefined) throw new Error("Edit task files and verification in the structured spec");
      fields.spec = structuredClone(previous.fields.spec);
      if (patch.goal !== undefined) fields.spec.goal = patch.goal;
      if (patch.scope !== undefined) fields.spec.scope = patch.scope;
      if (patch.exclusions !== undefined) fields.spec.exclusions = patch.exclusions;
      if (patch.inspection !== undefined) fields.spec.inspection = patch.inspection;
      if (patch.acceptance !== undefined) fields.spec.acceptance = build(target.root, draftId, { ...fields, spec: undefined }, previous).spec.acceptance;
    }
    const draft = await semanticDraft(target.root, build(target.root, draftId, fields, previous));
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(draft, null, 2) + "\n"); }
    finally { await file.close(); }
    await rename(temporary, target.file);
    return draft;
  } finally {
    await unlink(temporary).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }
}

/** Delete a draft under its edit lock; a wrong revision never deletes newer work. */
export async function deletePlanDraft(root: string, draftId: string, revision?: string): Promise<boolean> {
  const target = await location(root, draftId);
  return withStaleAwareLock(`${target.file}.lock`, async () => {
    if (revision !== undefined) {
      const draft = await readPlanDraft(root, draftId);
      if (draft.revision !== revision) throw new Error("Stale draft revision; read the current draft before deleting");
    }
    await rm(target.file, { force: true });
    await rm(`${target.file}.lock`, { force: true }).catch(() => undefined);
    return true;
  }, { label: "Plan draft" });
}

/** Drafts are advisory — once the plan scaffolded they are removed. */
export async function deletePlanDraftsForPlan(root: string, name: string): Promise<string[]> {
  const deleted: string[] = [];
  for (const draft of await listPlanDrafts(root)) {
    if (draft.fields.name !== name) continue;
    try {
      if (await deletePlanDraft(root, draft.draftId)) deleted.push(draft.draftId);
    } catch { /* a concurrent edit owns it; the draft is advisory and may stay */ }
  }
  return deleted;
}

export async function listPlanDrafts(root: string): Promise<PlanDraft[]> {
  const target = await location(root, "draft-list");
  const entries = await readdir(join(target.root, ".ompfest", "plans"));
  return Promise.all(entries.filter((name) => name.endsWith(".draft.json")).sort().map((name) => readPlanDraft(root, name.slice(0, -".draft.json".length))));
}

/** Remove orphaned lock/tmp debris left by crashed draft operations. */
export async function sweepPlanDraftDebris(root: string, olderThanMs = 15 * 60_000, nowMs = Date.now()): Promise<string[]> {
  const target = await location(root, "draft-list");
  const dir = join(target.root, ".ompfest", "plans");
  const removed: string[] = [];
  for (const entry of await readdir(dir)) {
    if (!entry.endsWith(".tmp") && !entry.endsWith(".draft.json.lock")) continue;
    const path = join(dir, entry);
    const info = await stat(path).catch(() => undefined);
    if (!info || nowMs - info.mtimeMs <= olderThanMs) continue;
    await rm(path, { recursive: true, force: true });
    removed.push(entry);
  }
  return removed;
}
