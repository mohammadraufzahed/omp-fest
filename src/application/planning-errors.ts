export interface PlanningDiagnostic { code: string; field?: string; expected?: string; received?: string; message: string; nextAction: string }
const rules: [RegExp, string, string, string][] = [
  [/stable identifier/i, "INVALID_IDENTIFIER", "a stable lowercase ID", "Fix the named ID; retain existing IDs for already accepted plan elements."],
  [/inspection path does not exist|does not exist:/i, "PATH_NOT_FOUND", "an existing project-relative path", "Inspect the project and replace this path with a real file or directory."],
  [/inspection path must be project-relative/i, "PROJECT_RELATIVE_PATH_REQUIRED", "a path relative to the selected project", "Remove the absolute prefix and retry with a project-relative path."],
  [/verification cwd must be project-relative/i, "INVALID_VERIFICATION_CWD", "a project-relative cwd such as .", "Use a project-relative verification working directory."],
  [/fest_working_dir must be relative to camp root/i, "CAMP_RELATIVE_PATH_REQUIRED", "a path relative to the camp root", "Choose the camp-linked project path; do not use an absolute checkout path."],
  [/unfilled template markers|\[REPLACE:|\[FILL:/i, "TEMPLATE_MARKERS", "zero unfilled scaffold markers", "Replace the reported generated template sections from approved-plan values, then validate."],
];
function redact(value: string): string { return value.replace(/(password|passwd|secret|token|otp|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]").replace(/https?:\/\/[^\s]+/gi, "[URL]"); }
export function planningDiagnostic(error: unknown, field?: string): PlanningDiagnostic {
  const raw = redact(String(error).replace(/^Error:\s*/, ""));
  const match = rules.find(([pattern]) => pattern.test(raw));
  const code = match?.[1] ?? "PLAN_VALIDATION_FAILED";
  return { code, ...(field ? { field } : {}), ...(match ? { expected: match[2] } : {}), message: raw.slice(0, 600), nextAction: match?.[3] ?? "Correct the stated input, preserve other draft fields, and retry only the failed planning action." };
}
export function planningDiagnostics(errors: unknown[]): PlanningDiagnostic[] { return errors.map((error) => planningDiagnostic(error)); }
