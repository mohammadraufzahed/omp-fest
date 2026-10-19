/**
 * Parses `fest next` STOP blocks and `fest validate` output into structured
 * ValidationIssue records the agent can fix file-by-file.
 */
import type { ValidationIssue } from "./types.js";

const ISSUE_RE = /^\s*[✗x×]\s+(.+?):\s+(.+)$/gim;
const MARKER_COUNT_RE = /(\d+)\s+unfilled template markers?/i;
const MISSING_FIELD_RE = /missing\s+(\w+)/i;

export function parseValidationIssues(text: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const match of text.matchAll(ISSUE_RE)) {
    const file = match[1]?.trim() ?? "";
    const message = match[2]?.trim() ?? "";
    const markerCount = MARKER_COUNT_RE.exec(message)?.[1];
    const missingField = MISSING_FIELD_RE.exec(message)?.[1];
    issues.push({
      file,
      markers: markerCount ? [`${markerCount} unfilled marker(s)`] : extractMarkerTokens(message),
      ...(missingField ? { error: `missing ${missingField}` } : { error: message }),
    });
  }
  return issues;
}

function extractMarkerTokens(message: string): string[] {
  return message.match(/\[(?:REPLACE|FILL):[^\]]*\]/g) ?? [];
}
