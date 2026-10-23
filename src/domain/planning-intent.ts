/** Classifies whether an image-backed planning request needs a UI wireframe. */
export type PlanningIntent = "ui_visual" | "document_or_pdf" | "backend_or_api" | "bug_diagnostic" | "mixed" | "unknown";

const UI_TERMS = /\b(ui|user interface|screen|page|dashboard|layout|component|style|styling|spacing|responsive|visual|design|frontend|front-end|css|interaction|hover|modal|dialog|form|button|table|wireframe)\b/i;
const DOCUMENT_TERMS = /\b(pdf|document|report|export|print|invoice|letter|paper|file format|parser)\b/i;
const BACKEND_TERMS = /\b(api|backend|back-end|server|database|query|endpoint|payload|json|response|schema|migration)\b/i;
const BUG_TERMS = /\b(error|bug|failure|failing|broken|stack trace|exception|diagnos|debug|regression|incident|screenshot of an error)\b/i;

export function classifyPlanningIntent(text: string, hasImage: boolean): PlanningIntent {
  const input = text.trim();
  const ui = UI_TERMS.test(input);
  const document = DOCUMENT_TERMS.test(input);
  const backend = BACKEND_TERMS.test(input);
  const bug = BUG_TERMS.test(input);
  const matches = [ui, document, backend, bug].filter(Boolean).length;

  if (!hasImage) return ui ? "ui_visual" : "unknown";
  if (bug && !ui) return "bug_diagnostic";
  if (document && !ui) return "document_or_pdf";
  if (backend && !ui) return "backend_or_api";
  if (matches > 1) return "mixed";
  if (ui) return "ui_visual";
  return "unknown";
}

export function planningIntentGuidance(intent: PlanningIntent): string {
  if (intent === "ui_visual") {
    return "This is an explicit UI-visual request. Inspect the image and project, then create the validated PAGE.md + wireframe.svg reference only for the requested UI change.";
  }
  return [
    `Classified image role: ${intent}.`,
    "Treat the attachment as evidence, not a UI design reference.",
    "Do not call fest_wireframe_create, do not create referencesDir, and do not convert the image into an iframe or wireframe.",
    "If the request also contains a UI change, split the proposal and ask one focused question before creating any visual reference.",
  ].join(" ");
}
