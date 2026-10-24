export interface PlanningDiagnostic { code: string; field?: string; expected?: string; received?: string; message: string; nextAction: string }
const rules: [RegExp, string, string, string, string][] = [
  [/stable identifier|duplicate id/i, "INVALID_IDENTIFIER", "a stable lowercase ID", "The plan contains an invalid or duplicate identifier.", "Fix the named ID; retain existing IDs for already accepted plan elements."],
  [/inspection path does not exist|existing file does not exist|verification .* does not exist|workingDir does not exist|does not exist:/i, "PATH_NOT_FOUND", "an existing project-relative path", "A required project path does not exist.", "Inspect the project and replace this path with a real file or directory."],
  [/must be project-relative|must stay within project/i, "PROJECT_RELATIVE_PATH_REQUIRED", "a path relative to the selected project", "A project path must stay inside the selected project.", "Remove the absolute prefix and retry with a project-relative path."],
  [/verification cwd.*project-relative|verification cwd must/i, "INVALID_VERIFICATION_CWD", "a project-relative cwd such as .", "The verification working directory must be project-relative.", "Use a project-relative verification working directory."],
  [/fest_working_dir must be relative to camp root/i, "CAMP_RELATIVE_PATH_REQUIRED", "a path relative to the camp root", "The scaffold working directory must be relative to the camp root.", "Choose the camp-linked project path; do not use an absolute checkout path."],
  [/unfilled template markers|\[REPLACE:|\[FILL:/i, "TEMPLATE_MARKERS", "zero unfilled scaffold markers", "The generated scaffold still contains unfilled template markers.", "Replace the reported generated template sections from approved-plan values, then validate."],
  [/verification|package script|evidencePath|evidence path|test directory|command script/i, "INVALID_VERIFICATION", "a literal command with existing project-relative evidence", "Verification command or evidence is invalid.", "Use one literal verification command and an existing file or directory that substantiates it."],
  [/unsafe plan (?:artifact|directory)|invalid persisted plan draft|saved plan artifact is invalid|unexpected end of json|json.*parse/i, "PLAN_ARTIFACT_INVALID", "a valid saved planning artifact", "Saved planning data is invalid or corrupted.", "Preserve the draft if useful, then create a fresh preview from valid input."],
  [/plan preview is being saved|draft is being edited/i, "PLAN_BUSY", "a completed draft or preview write", "Another planning write is in progress.", "Retry after the active write completes; reread the current revision first."],
];
function redact(value: string): string { return value.replace(/(password|passwd|secret|token|otp|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]").replace(/https?:\/\/[^\s]+/gi, "[URL]"); }
export function planningDiagnostic(error: unknown, field?: string): PlanningDiagnostic {
  const raw = redact(String(error).replace(/^Error:\s*/, ""));
  const match = rules.find(([pattern]) => pattern.test(raw));
  return {
    code: match?.[1] ?? "PLAN_VALIDATION_FAILED",
    ...(field ? { field } : {}),
    ...(match ? { expected: match[2] } : {}),
    message: match?.[3] ?? raw.slice(0, 240),
    nextAction: match?.[4] ?? "Correct the stated input, preserve other draft fields, and retry only the failed planning action.",
  };
}
export function planningDiagnostics(errors: unknown[]): PlanningDiagnostic[] { return errors.map((error) => planningDiagnostic(error)); }
