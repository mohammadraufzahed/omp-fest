import { listPlanDrafts, readPlanDraft, updatePlanDraft, type PlanDraftFields } from "../../application/plan-drafts.js";
import type { CommandDeps, PiCommandsLike } from "./commands.js";

export function draftCommands(pi: PiCommandsLike, deps: CommandDeps) {
  return {
    draft: {
      desc: "inspect/edit a persisted draft without resubmitting nested plan JSON: /fest draft [draftId]",
      run: async (args: string[], ctx: { cwd: string; ui: { select?(title: string, options: (string | { label: string; description?: string })[]): Promise<string | undefined>; input?(title: string, placeholder?: string): Promise<string | undefined> } }) => {
        const root = (await deps.detect.locate(ctx.cwd)).campRoot;
        if (!root) throw new Error("Draft editing requires a camp");
        const send = (content: string) => { pi.sendMessage({ customType: "fest-draft", display: true, content }, { triggerTurn: false }); };
        let id = args[0];
        const drafts = await listPlanDrafts(root);
        if (!id && ctx.ui.select) id = await ctx.ui.select("Select plan draft", drafts.map((draft) => ({ label: draft.draftId, description: `${draft.fields.name}: ${draft.fields.goal ?? "goal needed"}` })));
        if (!id) { send(drafts.map((draft) => `${draft.draftId}: ${draft.fields.name}`).join("\n") || "No persisted drafts. Start /fest plan."); return; }
        for (;;) {
          const draft = await readPlanDraft(root, id);
          send(JSON.stringify({ draftId: draft.draftId, revision: draft.revision, name: draft.fields.name, goal: draft.fields.goal, missing: draft.missing, plan: draft.plan }));
          if (!ctx.ui.select) return;
          const field = await ctx.ui.select("Edit draft or preview", ["goal", "scope", "exclusions", "acceptance", "workingDir", "rules", "files", "inspection", "verification", "visualIntent", "Preview", "Done"]);
          if (!field || field === "Done") return;
          if (field === "Preview") {
            if (draft.missing.length) { send(`Resolve missing fields first: ${draft.missing.join(", ")}`); continue; }
            if (pi.sendUserMessage) pi.sendUserMessage(`Preview persisted draft ${draft.draftId} at exact revision ${draft.revision} with fest_plan {action:'preview',draftId:'${draft.draftId}',draftRevision:'${draft.revision}'}. Show native approval; do not scaffold unless approved. Do not resend or overwrite its spec.`);
            return;
          }
          if (!ctx.ui.input) return;
          if (field === "verification") {
            const command = await ctx.ui.input("Verification command", "Existing runnable command, e.g. npm test");
            if (command === undefined) continue;
            const cwd = await ctx.ui.input("Verification cwd", "Project-relative directory, e.g. .");
            if (cwd === undefined) continue;
            const evidencePath = await ctx.ui.input("Command evidence path", "Existing project-relative manifest/script, e.g. package.json");
            if (evidencePath === undefined) continue;
            const expected = await ctx.ui.input("Observable expected result", "Behavior/output proving acceptance");
            if (expected === undefined) continue;
            await updatePlanDraft(root, id, draft.revision, { verification: { command, cwd: cwd || ".", evidencePath, expected } });
            continue;
          }
          if (field === "visualIntent") {
            const intent = await ctx.ui.select("Request intent", ["ui_visual", "document_or_pdf", "backend_or_api", "bug_diagnostic", "mixed", "unknown"]);
            if (intent === "ui_visual" || intent === "document_or_pdf" || intent === "backend_or_api" || intent === "bug_diagnostic" || intent === "mixed" || intent === "unknown") await updatePlanDraft(root, id, draft.revision, { visualIntent: intent });
            continue;
          }
          const value = await ctx.ui.input(`Edit ${field}`, ["scope", "exclusions", "acceptance"].includes(field) ? "One entry per line" : "New value");
          if (value === undefined) continue;
          const changes: Partial<PlanDraftFields> = {};
          if (field === "scope" || field === "exclusions" || field === "acceptance") changes[field] = value.split("\n").map((item) => item.trim()).filter(Boolean);
          else if (field === "goal" || field === "workingDir" || field === "rules") changes[field] = value;
          else if (field === "files") changes.files = value.split("\n").map((item) => item.trim()).filter(Boolean);
          else if (field === "inspection") {
            changes.inspection = value.split("\n").filter((item) => item.trim()).map((line) => {
              const separator = line.indexOf(" | ");
              if (separator < 1) throw new Error("Each inspection line must be: project-relative/path | reason inspected");
              return { path: line.slice(0, separator).trim(), reason: line.slice(separator + 3).trim() };
            });
          }
          await updatePlanDraft(root, id, draft.revision, changes);
        }
      },
    },
  };
}
