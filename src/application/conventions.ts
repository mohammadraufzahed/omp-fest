/**
 * Camp conventions: machine-checkable style rules stored in `.ompfest.json`
 * under `conventions`. RULES.md covers judgement rules agents interpret;
 * conventions cover mechanical things the plugin templates and validates
 * itself (branch/worktree naming, commit style, festival naming, merge mode).
 */
import { basename, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_CONVENTIONS, type Conventions } from "../domain/types.js";

const PLACEHOLDER_RE = /\{([a-zA-Z]+)\}/g;
export const CONVENTION_VARS = ["camp", "festival", "project", "task", "lane"] as const;
const KNOWN_VARS = new Set<string>(CONVENTION_VARS);

/** Substitute {placeholders}; unknown placeholders pass through literally. */
export function renderConvention(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_m, key: string) => vars[key] ?? `{${key}}`);
}

function templateWarnings(key: string, template: string): string[] {
  const unknown = [...new Set([...template.matchAll(PLACEHOLDER_RE)].map((m) => m[1] ?? ""))].filter((k) => !KNOWN_VARS.has(k));
  return unknown.length ? [`conventions.${key}: unknown placeholder(s) ${unknown.map((k) => `{${k}}`).join(", ")} — known: ${CONVENTION_VARS.join(", ")}`] : [];
}

/** Non-fatal config problems surfaced in camp_status/fest_capabilities. */
export function conventionWarnings(conventions: Conventions): string[] {
  const warnings = [
    ...templateWarnings("branch", conventions.branch),
    ...templateWarnings("worktreeDir", conventions.worktreeDir),
    ...(conventions.commitPrefix ? templateWarnings("commitPrefix", conventions.commitPrefix) : []),
  ];
  if (conventions.festivalName) {
    try {
      new RegExp(conventions.festivalName);
    } catch {
      warnings.push("conventions.festivalName: invalid regex — ignored");
    }
  }
  return warnings;
}

/** Festival name gate: empty pattern means unchecked; bad regex means unchecked (warned elsewhere). */
export function festivalNameOk(conventions: Conventions, name: string): { ok: boolean; pattern?: string } {
  if (!conventions.festivalName) return { ok: true };
  try {
    return new RegExp(`^(?:${conventions.festivalName})$`).test(name)
      ? { ok: true }
      : { ok: false, pattern: conventions.festivalName };
  } catch {
    return { ok: true };
  }
}

/** Render the worktree dir for one project; falls back to the default when the render escapes the camp root. */
export function conventionWorktreeDir(conventions: Conventions, campRoot: string, projectPath: string, festivalName: string): string {
  const rendered = renderConvention(conventions.worktreeDir, { project: basename(projectPath), festival: festivalName, camp: basename(campRoot) });
  const candidate = isAbsolute(rendered) ? rendered : join(campRoot, rendered);
  const resolved = resolve(candidate);
  if (resolved !== campRoot && !resolved.startsWith(`${resolve(campRoot)}/`)) {
    return join(campRoot, "projects", "worktrees", basename(projectPath), festivalName);
  }
  return resolved;
}

const CONVENTIONAL_RE = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^\n()]*\))?!?: .+/;

export const COMMIT_STYLE_DESC = "type(scope): subject — types: feat fix docs refactor test chore perf style build ci revert";

/**
 * Validate/transform an agent commit message against commitStyle.
 * "free" passes through; "conventional" validates; "prefix" prepends the
 * rendered commitPrefix when the message does not already start with it.
 * (fest itself still appends its own [camp:festival] tag.)
 */
export function checkCommitMessage(
  conventions: Conventions,
  message: string,
  vars: Record<string, string>,
): { ok: true; message: string } | { ok: false; error: string } {
  const trimmed = message.trim();
  if (!trimmed) return { ok: false, error: "empty commit message" };
  if (conventions.commitStyle === "conventional" && !CONVENTIONAL_RE.test(trimmed)) {
    return { ok: false, error: `commitStyle=conventional expects "${COMMIT_STYLE_DESC}" — got "${trimmed}"` };
  }
  if (conventions.commitStyle === "prefix" && conventions.commitPrefix) {
    const prefix = renderConvention(conventions.commitPrefix, vars).trim();
    if (prefix && !trimmed.startsWith(prefix)) {
      return { ok: true, message: `${prefix} ${trimmed}` };
    }
  }
  return { ok: true, message: trimmed };
}

/**
 * Natural-language conventions request → config patch, clause by clause.
 * Anything unparseable lands in `unparsed` so the caller can hand it to the
 * agent ("I understood X; please apply the rest via camp_conventions").
 */
export function parseConventionWords(text: string): { patch: Partial<Conventions>; unparsed: string[] } {
  const patch: Partial<Conventions> = {};
  const unparsed: string[] = [];
  const BRANCH_STOP = new Set(["git", "the", "a", "named", "called", "like", "use", "using", "with", "our", "all"]);
  for (const raw of text.split(/[,;\n]+|\.(?:\s|$)/).map((s) => s.trim()).filter(Boolean)) {
    const clause = raw.toLowerCase();
    if (/conventional commits?/.test(clause)) {
      patch.commitStyle = "conventional";
    } else if (/free (commit|message)s?|no commit (style|rules)/.test(clause)) {
      patch.commitStyle = "free";
    } else {
      const prefixMatch = /(?:commit |message )?prefix\s+(?:to |of |as |be )?["'`]?([^"'`]+?)["'`]?$/i.exec(raw);
      if (prefixMatch?.[1]) {
        patch.commitStyle = "prefix";
        patch.commitPrefix = prefixMatch[1].trim();
      } else if (/prefixed commits?|commit prefix/.test(clause)) {
        patch.commitStyle = "prefix";
      } else if (clause.includes('squash')) {
        patch.finishMerge = "squash";
      } else if (/merge commits?|no-?ff/.test(clause)) {
        patch.finishMerge = "merge";
      } else {
        const namedBranch = /branches?\s+(?:named?|called|like|as|of|pattern)\s+["'`]?([a-zA-Z0-9{}_./-]+)["'`]?/i.exec(raw);
        const prefixBranch = (/([a-z][a-z0-9_-]*)[\s/]*\*?\s+branches?\b/.exec(clause)) ?? (/([a-z][a-z0-9_-]*)\/[*{]/.exec(clause));
        const worktreeMatch = /worktrees?\s+(?:in|under|at|into|dir(?:ectory)?(?:\s+of)?)\s+["'`]?([a-zA-Z0-9{}_./-]+)["'`]?/i.exec(raw);
        const nameMatch = /festival names?\s+(?:like|as|of|in|must (?:be|match))\s+["'`]?([a-zA-Z0-9{}_./^[\]\\+?*$-]+)["'`]?/i.exec(raw);
        if (namedBranch?.[1]) {
          let tpl = namedBranch[1];
          if (tpl.endsWith("*")) tpl = `${tpl.slice(0, -1)}{festival}`;
          else if (tpl.endsWith("/")) tpl += "{festival}";
          else if (!tpl.includes("{festival}")) tpl = `${tpl}/{festival}`;
          patch.branch = tpl;
        } else if (prefixBranch?.[1] && !BRANCH_STOP.has(prefixBranch[1])) {
          patch.branch = `${prefixBranch[1]}/{festival}`;
        } else if (worktreeMatch?.[1]) {
          const dir = worktreeMatch[1];
          patch.worktreeDir = dir.includes("{festival}") ? dir : `${dir.replace(/\/$/, "")}/{festival}`;
        } else if (nameMatch?.[1]) {
          patch.festivalName = nameMatch[1].replace(/^\^/, "").replace(/\$$/, "");
        } else if (clause.includes('kebab')) {
          patch.festivalName = "[a-z][a-z0-9-]+";
        } else if (clause.includes('snake')) {
          patch.festivalName = "[a-z][a-z0-9_]+";
        } else {
          unparsed.push(raw);
        }
      }
    }
  }
  return { patch, unparsed };
}

/** One-line summary for camp_status / digest / contract. */
export function conventionsEcho(conventions: Conventions): string {
  const parts = [
    `branch=${conventions.branch}`,
    `worktree=${conventions.worktreeDir}`,
    `commit=${conventions.commitStyle}${conventions.commitStyle === "prefix" && conventions.commitPrefix ? `(${conventions.commitPrefix})` : ""}`,
    `merge=${conventions.finishMerge}`,
  ];
  if (conventions.festivalName) parts.push(`names=/${conventions.festivalName}/`);
  return parts.join(" ");
}

export { DEFAULT_CONVENTIONS };
