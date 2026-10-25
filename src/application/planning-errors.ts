export interface PlanningDiagnostic { code: string; field?: string; expected?: string; received?: string; message: string; nextAction: string }
export class PlanningValidationError extends Error {
  constructor(readonly diagnostics: PlanningDiagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.field ?? "plan"}: ${diagnostic.received ?? diagnostic.message} ${diagnostic.nextAction}`).join("\n"));
    this.name = "PlanningValidationError";
  }
}
const rules: [RegExp, string, string, string, string][] = [
  [/verification task .* precedes implementation|verification .* precedes implementation/i, "VERIFICATION_ORDER", "implementation before verification", "A verification task is ordered before implementation of its acceptance criterion.", "Place each verification task after the implementation it verifies and add an explicit dependency when it crosses a sequence; preserve other task order."],
  [/maxAuthoredTasksPerPhase/i, "PHASE_TASK_POLICY", "the camp's configured authored-task limit", "This phase exceeds the explicitly configured camp task limit.", "Split the phase at cohesive milestones or ask the human to change planning.maxAuthoredTasksPerPhase; no limit is imposed by default."],
  [/phase.*(?:objective|deliverables|completionCriteria).*must be|phase .*objective must describe this milestone/i, "PHASE_CONTRACT_REQUIRED", "a distinct objective, deliverables and completion criteria for every phase", "The phase is missing its own milestone contract.", "Update the structured spec with a phase-specific objective, concrete deliverables and observable completion criteria, then preview again for approval."],
  [/stable identifier|duplicate id/i, "INVALID_IDENTIFIER", "a stable lowercase ID", "The plan contains an invalid or duplicate identifier.", "Fix the named ID; retain existing IDs for already accepted plan elements."],
  [/inspection path does not exist|existing file does not exist|verification .* does not exist|workingDir does not exist|does not exist:/i, "PATH_NOT_FOUND", "an existing project-relative path", "A required project path does not exist.", "Inspect the project and replace this path with a real file or directory."],
  [/must be project-relative|must stay within project/i, "PROJECT_RELATIVE_PATH_REQUIRED", "a path relative to the selected project", "A project path must stay inside the selected project.", "Remove the absolute prefix and retry with a project-relative path."],
  [/verification cwd.*project-relative|verification cwd must/i, "INVALID_VERIFICATION_CWD", "a project-relative cwd such as .", "The verification working directory must be project-relative.", "Use a project-relative verification working directory."],
  [/fest_working_dir must be relative to camp root/i, "CAMP_RELATIVE_PATH_REQUIRED", "a path relative to the camp root", "The scaffold working directory must be relative to the camp root.", "Choose the camp-linked project path; do not use an absolute checkout path."],
  [/unfilled template markers|\[REPLACE:|\[FILL:/i, "TEMPLATE_MARKERS", "zero unfilled scaffold markers", "The generated scaffold still contains unfilled template markers.", "Replace the reported generated template sections from approved-plan values, then validate."],
  [/verification|package script|provenancePath|evidencePath|test directory|command script/i, "INVALID_VERIFICATION", "a command with existing provenance, or a concrete browser/manual/research procedure", "Verification command or evidence is invalid.", "Choose the appropriate verification kind. For command checks provide a literal command with existing or inferable provenance; otherwise provide a procedure and expected result. Record actual results only during execution."],
  [/unsafe plan (?:artifact|directory)|invalid persisted plan draft|saved plan artifact is invalid|unexpected end of json|json.*parse/i, "PLAN_ARTIFACT_INVALID", "a valid saved planning artifact", "Saved planning data is invalid or corrupted.", "Preserve the draft if useful, then create a fresh preview from valid input."],
  [/plan preview is being saved|draft is being edited/i, "PLAN_BUSY", "a completed draft or preview write", "Another planning write is in progress.", "Retry after the active write completes; reread the current revision first."],
];
function redact(value: string): string { return value.replace(/(password|passwd|secret|token|otp|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]").replace(/https?:\/\/[^\s]+/gi, "[URL]"); }
export function planningDiagnostic(error: unknown, field?: string): PlanningDiagnostic {
  if (error instanceof PlanningValidationError) return error.diagnostics[0] ?? planningDiagnostic("Plan validation failed", field);
  const raw = redact(String(error).replace(/^Error:\s*/, ""));
  const match = rules.find(([pattern]) => pattern.test(raw));
  return {
    code: match?.[1] ?? "PLAN_VALIDATION_FAILED",
    ...(field ? { field } : {}),
    ...(match ? { expected: match[2] } : {}),
    received: raw.slice(0, 480),
    message: match?.[3] ?? raw.slice(0, 240),
    nextAction: match?.[4] ?? "Correct the stated input, preserve other draft fields, and retry only the failed planning action.",
  };
}
export function planningDiagnostics(errors: unknown[]): PlanningDiagnostic[] { return errors.flatMap((error) => error instanceof PlanningValidationError ? error.diagnostics : [planningDiagnostic(error)]); }
