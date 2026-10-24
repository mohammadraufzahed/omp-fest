import { createPlanDraft, readPlanDraft, updatePlanDraft, listPlanDrafts, type PlanDraftFields } from "../../application/plan-drafts.js";
import { resolveWorkingDir } from "../../application/sequence-goals.js";
import type { PiLike, ToolDeps } from "./tools.js";

export function registerDraftTools(pi: PiLike, deps: ToolDeps) {
  const z = pi.zod;
  pi.registerTool({
    name: "fest_plan_draft", label: "Persisted Plan Draft",
    description: "Create, read or incrementally update a persisted draft. Returns draftId/revision; use those in fest_plan preview instead of resending nested JSON. Missing decisions remain explicit; no festival is created. /fest draft provides native editing.",
    parameters: z.object({
      action: z.enum(["create", "read", "update", "list"]).optional(), draftId: z.string().optional(), revision: z.string().optional(),
      name: z.string().optional(), goal: z.string().optional(), scope: z.array(z.string()).optional(), acceptance: z.array(z.string()).optional(),
      inspection: z.array(z.object({ path: z.string(), reason: z.string() })).optional(), workingDir: z.string().optional(), exclusions: z.array(z.string()).optional(), files: z.array(z.string()).optional(),
      verification: z.object({ command: z.string(), cwd: z.string().optional(), evidencePath: z.string(), expected: z.string() }).optional(),
      visualIntent: z.enum(["ui_visual", "document_or_pdf", "backend_or_api", "bug_diagnostic", "mixed", "unknown"]).optional(), rules: z.string().optional(), referencesDir: z.string().optional(),
    }),
    async execute(_id: string, params: Partial<PlanDraftFields> & { action?: "create" | "read" | "update" | "list"; draftId?: string; revision?: string }, _signal: unknown, _update: unknown, ctx: { cwd: string }) {
      const output = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
      try {
        const { campRoot } = await deps.detect.locate(ctx.cwd);
        if (!campRoot) throw new Error("Draft creation requires a camp; existing festival ownership is not required");
        if (params.action === "list") return output({ kind: "plan_drafts", drafts: (await listPlanDrafts(campRoot)).map((draft) => ({ draftId: draft.draftId, revision: draft.revision, name: draft.fields.name, goal: draft.fields.goal, missing: draft.missing })) });
        if (params.action === "read") return output({ kind: "plan_draft", ...await readPlanDraft(campRoot, params.draftId ?? "") });
        const { action, draftId, revision, ...fields } = params;
        const project = fields.workingDir || action !== "update" ? await resolveWorkingDir(campRoot, deps.camp, fields.workingDir) : undefined;
        if (project?.dir) fields.workingDir = project.dir;
        const draft = action === "update"
          ? await updatePlanDraft(campRoot, draftId ?? "", revision ?? "", fields)
          : await createPlanDraft(campRoot, { ...fields, name: fields.name ?? "" });
        return output({ kind: draft.missing.length ? "plan_draft_incomplete" : "plan_draft", draftId: draft.draftId, revision: draft.revision, plan: draft.plan, name: draft.fields.name, goal: draft.spec.goal, missing: draft.missing, workingDir: draft.fields.workingDir, visualIntent: draft.fields.visualIntent ?? "unknown", nextSteps: "Edit missing fields by draftId+revision. Then call fest_plan {action:'preview',draftId, draftRevision:revision}; do not resend spec. Use action:'read' only when full detail is needed." });
      } catch (error) { return output({ kind: "plan_draft_failed", error: String(error) }); }
    },
  });
}
