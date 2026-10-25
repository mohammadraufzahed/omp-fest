import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvedPlan } from "../src/application/plan-artifacts.js";
import { createPlanDraft, listPlanDrafts, previewPlanDraft, readPlanDraft, updatePlanDraft, type PlanDraftFields } from "../src/application/plan-drafts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "plan-draft-"));
  roots.push(root);
  await mkdir(join(root, "projects", "app"), { recursive: true });
  await writeFile(join(root, "projects", "app", "package.json"), JSON.stringify({ scripts: { test: "never-executed-by-planning" } }));
  const fields: PlanDraftFields = {
    name: "feature", goal: "Make the feature usable", scope: ["Feature behavior"], acceptance: ["Feature works"],
    workingDir: "projects/app", inspection: [{ path: "package.json", reason: "Inspected existing verification command" }],
    verification: { command: "npm run test", evidencePath: "package.json", expected: "Feature regression passes" },
  };
  return { root, fields };
}

describe("persisted plan drafts", () => {
  it("roundtrips, incrementally edits fields, and rejects stale revisions without losing the latest draft", async () => {
    const { root, fields } = await fixture();
    const created = await createPlanDraft(root, fields);
    expect(created.draftId).toMatch(/^draft-/);
    expect(created.missing).toContain("full structured spec with meaningful milestone phases");
    expect(await readPlanDraft(root, created.draftId)).toEqual(created);
    const updated = await updatePlanDraft(root, created.draftId, created.revision, { goal: "Make the feature reliably usable", rules: "Do not add dependencies." });
    expect(updated.revision).not.toBe(created.revision);
    expect(updated.spec.goal).toBe("Make the feature reliably usable");
    expect(updated.fields.scope).toEqual(fields.scope);
    expect(updated.spec.acceptance).toEqual(created.spec.acceptance);
    await expect(updatePlanDraft(root, created.draftId, created.revision, { goal: "Lost update" })).rejects.toThrow("Stale draft revision");
    expect(await readPlanDraft(root, created.draftId)).toEqual(updated);
    expect(await listPlanDrafts(root)).toEqual([updated]);
  });

  it("preserves acceptance IDs when statements are edited, reordered, or appended", async () => {
    const { root, fields } = await fixture();
    const created = await createPlanDraft(root, { ...fields, acceptance: ["First", "Second"] });
    const edited = await updatePlanDraft(root, created.draftId, created.revision, { acceptance: ["First revised", "Second"] });
    expect(edited.spec.acceptance.map((item) => item.id)).toEqual(["ac-1", "ac-2"]);
    const reordered = await updatePlanDraft(root, edited.draftId, edited.revision, { acceptance: ["Second", "First revised", "Third"] });
    expect(reordered.spec.acceptance.map((item) => item.id)).toEqual(["ac-2", "ac-1", "ac-3"]);
  });

  it("previews explicitly structured persisted content without requiring callers to repeat the nested spec", async () => {
    const { root, fields } = await fixture();
    const compact = await createPlanDraft(root, fields);
    const draft = await updatePlanDraft(root, compact.draftId, compact.revision, { spec: compact.spec });
    const preview = await previewPlanDraft(root, draft.draftId, draft.revision);
    expect(preview.counts).toEqual({ phases: 1, sequences: 1, tasks: 1 });
    expect(preview.draftRevision).toBe(draft.revision);
    expect(preview.previewState).toBe("saved_preview");
    expect(await readFile(`${preview.plan}.status.json`, "utf8")).toContain('"state":"saved_preview"');
    expect(preview.previewMessage).toBe("Saved approval preview; no festival scaffold has been created.");
    expect(await readFile(preview.previewFile, "utf8")).toContain("# Approval Preview");
    const savedPreview = await readFile(preview.plan, "utf8");
    const updated = await updatePlanDraft(root, draft.draftId, draft.revision, { goal: "Updated goal" });
    await expect(previewPlanDraft(root, updated.draftId, draft.revision)).rejects.toThrow("Stale draft revision");
    expect(await readFile(preview.plan, "utf8")).toBe(savedPreview);
  });

  it("blocks compact scalar drafts from previewing as a synthesized single phase", async () => {
    const { root, fields } = await fixture();
    const draft = await createPlanDraft(root, fields);
    expect(draft.missing).toContain("full structured spec with meaningful milestone phases");
    await expect(previewPlanDraft(root, draft.draftId, draft.revision)).rejects.toThrow("Draft is incomplete");
  });

  it("requires a full structured spec before a compact draft can be previewed", async () => {
    const { root, fields } = await fixture();
    const draft = await createPlanDraft(root, { ...fields, acceptance: ["First", "Second", "Third", "Fourth"] });
    expect(draft.missing).toContain("full structured spec with meaningful milestone phases");
    await expect(previewPlanDraft(root, draft.draftId, draft.revision)).rejects.toThrow("Draft is incomplete");
  });

  it("supports incremental goal edits on stored structured specs", async () => {
    const { root, fields } = await fixture();
    const compact = await createPlanDraft(root, fields);
    const structured = await createPlanDraft(root, { name: fields.name, workingDir: fields.workingDir, spec: compact.spec });
    const updated = await updatePlanDraft(root, structured.draftId, structured.revision, { goal: "Revised approved outcome" });
    expect(updated.spec.goal).toBe("Revised approved outcome");
    expect(updated.spec.phases).toEqual(compact.spec.phases);
    expect(updated.missing).toEqual([]);
  });

  it("keeps legacy drafts readable but requires milestone data before preview", async () => {
    const { root, fields } = await fixture();
    const draft = await createPlanDraft(root, fields);
    const file = join(root, ".ompfest", "plans", `${draft.draftId}.draft.json`);
    const saved = JSON.parse(await readFile(file, "utf8")) as {
      spec: { phases: Record<string, unknown>[] };
      fields: { spec?: { phases: Record<string, unknown>[] } };
    };
    for (const phase of saved.spec.phases) {
      delete phase.objective;
      delete phase.deliverables;
      delete phase.completionCriteria;
    }
    await writeFile(file, JSON.stringify(saved));
    const legacy = await readPlanDraft(root, draft.draftId);
    expect(legacy.missing).toContain("full structured spec with phase objectives, deliverables and completion criteria");
    await expect(previewPlanDraft(root, legacy.draftId, legacy.revision)).rejects.toThrow("Draft is incomplete");
    const upgraded = await updatePlanDraft(root, legacy.draftId, legacy.revision, { spec: draft.spec });
    expect(upgraded.missing).toEqual([]);
    expect(upgraded.spec.phases[0]?.objective).toBe(draft.spec.phases[0]?.objective);
  });
  it("infers package-script and explicit test-target evidence while preserving partial verification edits", async () => {
    const { root, fields } = await fixture();
    const withoutEvidence = await createPlanDraft(root, {
      ...fields,
      verification: { command: "npm run test", expected: "Feature regression passes" },
    });
    expect(withoutEvidence.fields.verification?.evidencePath).toBe("package.json");
    expect(withoutEvidence.missing).toContain("full structured spec with meaningful milestone phases");
    await mkdir(join(root, fields.workingDir!, "tests"), { recursive: true });
    await writeFile(join(root, fields.workingDir!, "tests", "sample_test.py"), "def test_feature(): pass\n");
    const testTarget = await createPlanDraft(root, {
      ...fields,
      verification: { command: "pytest tests", expected: "Feature regression passes" },
    });
    expect(testTarget.fields.verification?.evidencePath).toBe("tests");
    expect(testTarget.missing).toContain("full structured spec with meaningful milestone phases");

    const partialUpdate = await updatePlanDraft(root, withoutEvidence.draftId, withoutEvidence.revision, {
      verification: { expected: "Updated regression result" },
    });
    expect(partialUpdate.fields.verification).toEqual({
      command: "npm run test",
      cwd: ".",
      evidencePath: "package.json",
      expected: "Updated regression result",
    });
    expect(partialUpdate.missing).toContain("full structured spec with meaningful milestone phases");
  });

  it("reports an unresolved evidence field instead of building a misleading verification check", async () => {
    const { root, fields } = await fixture();
    const draft = await createPlanDraft(root, {
      ...fields,
      verification: { command: "custom-check", expected: "The check succeeds" },
    });
    expect(draft.missing).toContain("verification.evidencePath");
    expect(draft.spec.phases[0]!.sequences[0]!.tasks[0]!.verification).toEqual([]);
  });


  it("persists incomplete observations but does not invent scope or verification", async () => {
    const { root } = await fixture();
    const draft = await createPlanDraft(root, { name: "incomplete", goal: "Fix a bug" });
    expect(draft.missing).toEqual(["scope", "acceptance", "inspection", "full structured spec with meaningful milestone phases", "workingDir", "verification"]);
    expect(draft.spec.phases[0]!.sequences[0]!.tasks[0]!.verification).toEqual([]);
    await expect(previewPlanDraft(root, draft.draftId, draft.revision)).rejects.toThrow("Draft is incomplete");
  });

  it("rejects unsafe IDs, paths, and symlinked storage", async () => {
    const { root, fields } = await fixture();
    await expect(createPlanDraft(root, { ...fields, name: "../escape" })).rejects.toThrow("lowercase slug");
    await expect(createPlanDraft(root, { ...fields, files: ["../outside"] })).rejects.toThrow("safe relative path");
    await expect(readPlanDraft(root, "../outside")).rejects.toThrow("Invalid draftId");
    const draft = await createPlanDraft(root, fields);
    const file = join(root, ".ompfest", "plans", `${draft.draftId}.draft.json`);
    await rm(file);
    await symlink(join(root, "projects", "app", "package.json"), file);
    await expect(readPlanDraft(root, draft.draftId)).rejects.toThrow("Unsafe draft file");
  });

  it("does not follow a symlinked .ompfest directory", async () => {
    const { root, fields } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "draft-outside-"));
    roots.push(outside);
    await symlink(outside, join(root, ".ompfest"));
    await expect(createPlanDraft(root, fields)).rejects.toThrow("Unsafe draft directory");
  });

  it("allows only one writer for a shared base revision", async () => {
    const { root, fields } = await fixture();
    const draft = await createPlanDraft(root, fields);
    const results = await Promise.allSettled([
      updatePlanDraft(root, draft.draftId, draft.revision, { goal: "Writer one" }),
      updatePlanDraft(root, draft.draftId, draft.revision, { goal: "Writer two" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await readPlanDraft(root, draft.draftId)).revision).not.toBe(draft.revision);
  });

  it("normalizes in-camp absolute working directories to camp-relative paths", async () => {
    const { root, fields } = await fixture();
    const draft = await createPlanDraft(root, { ...fields, workingDir: join(root, "projects", "app") });
    expect(draft.fields.workingDir).toBe("projects/app");
  });
  it("fails closed when a persisted draft is malformed", async () => {
    const { root, fields } = await fixture();
    const draft = await createPlanDraft(root, fields);
    await writeFile(join(root, ".ompfest", "plans", `${draft.draftId}.draft.json`), "{broken");
    await expect(readPlanDraft(root, draft.draftId)).rejects.toThrow("Invalid persisted plan draft");
  });
  it("rejects a corrupted saved artifact instead of accepting partial JSON", async () => {
    const { root, fields } = await fixture();
    const compact = await createPlanDraft(root, fields);
    const draft = await updatePlanDraft(root, compact.draftId, compact.revision, { spec: compact.spec });
    const preview = await previewPlanDraft(root, draft.draftId, draft.revision);
    await writeFile(`${preview.plan}.json`, "{broken");
    await expect(approvedPlan(root, preview.plan, fields.name, preview.planRevision)).rejects.toThrow(
      "Saved plan artifact is invalid or corrupted; create a fresh preview",
    );
  });
});
