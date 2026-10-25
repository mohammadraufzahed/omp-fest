/**
 * FESTIVAL_RULES.md seeding + gate enforcement, and camp-wide RULES.md.
 *
 * `fest rules` reads this file and `fest validate` warns when it's missing,
 * but `fest scaffold from-plan` never copies the camp template in — so the
 * constraints and rules the human states during planning had nowhere durable
 * to live. This seeds the camp's rules (camp-root `RULES.md`, else the camp
 * template, else a minimal skeleton), appends the human's stated constraints
 * verbatim under their own section, and stamps those rules into every
 * generated gate task so quality gates actually enforce them.
 *
 * Camp rules: `<camp>/RULES.md` is the single source of truth — it is seeded
 * into every festival inside `<!-- omp-fest:camp-rules -->` markers so sync
 * can rewrite just that section when the human edits the camp file (a
 * festival opts out by deleting the markers). Gate stamping treats camp
 * rules like planning constraints: a violated camp rule fails the gate.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomically } from "./fs-atomic.js";

const RULES_FILE = "FESTIVAL_RULES.md";
const CONSTRAINTS_HEADING = "## Constraints & Rules (agreed during planning)";
const CAMP_RULES_BEGIN = "<!-- omp-fest:camp-rules -->";
const CAMP_RULES_END = "<!-- /omp-fest:camp-rules -->";
/** A festival carrying this marker is excluded from camp-rules sync forever. */
const CAMP_RULES_OPTOUT = "<!-- omp-fest:no-camp-rules -->";
const CAMP_RULES_HEADING = "## Camp Rules";
const FALLBACK = `# Festival Rules\n\nPrinciples, standards, and practices all workers must follow throughout this festival.\n`;

/** Camp-level rules file name at the camp root. */
export const CAMP_RULES_FILE = "RULES.md";
/** Skeleton `camp_init` writes when the camp has no RULES.md yet. */
export const CAMP_RULES_SKELETON =
  "# Camp Rules\n\nRules every festival in this camp must follow. Agents must obey them; a violation fails gates.\n\n<!-- add one bullet per rule, e.g. \"- Never edit generated files\" -->\n";

export interface RulesSeedResult {
  /** Festival-relative file name — always FESTIVAL_RULES.md. */
  file: string;
  /** True when the file was created by this call (template or fallback). */
  seeded: boolean;
  /** True when the human's constraints were appended. */
  constraints: boolean;
  /** True when camp rules were embedded (markers written). */
  campRules: boolean;
}

/** Camp RULES.md content, trimmed; undefined when absent or empty. */
export async function campRules(campRoot: string): Promise<string | undefined> {
  const text = (await readFile(join(campRoot, CAMP_RULES_FILE), "utf8").catch(() => "")).trim();
  return text.length > 0 ? text : undefined;
}

/** Count bullet rules in a RULES.md body (lines starting with - or *). */
export function campRulesCount(text: string | undefined): number {
  if (!text) return 0;
  return text.split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
}

function campRulesBlock(text: string): string {
  return `${CAMP_RULES_BEGIN}\n${CAMP_RULES_HEADING}\n\n${text.trim()}\n${CAMP_RULES_END}`;
}

/** The marked camp-rules block inside a FESTIVAL_RULES.md, or undefined. */
export function campRulesSectionOf(rulesText: string): string | undefined {
  const at = rulesText.indexOf(CAMP_RULES_BEGIN);
  if (at === -1) return undefined;
  const end = rulesText.indexOf(CAMP_RULES_END, at);
  if (end === -1) return undefined;
  return rulesText.slice(at, end + CAMP_RULES_END.length);
}

/** Read the camp-rules block embedded in a festival's rules file. */
export async function festivalCampRules(festivalDir: string): Promise<string | undefined> {
  const text = await readFile(join(festivalDir, RULES_FILE), "utf8").catch(() => "");
  return campRulesSectionOf(text);
}

/**
 * Sync the marked camp-rules block of one festival's FESTIVAL_RULES.md to the
 * camp's current RULES.md. Appends the block when the markers are absent;
 * removes it when the camp file was deleted; rewrites on drift. Text outside
 * the markers is never touched. A festival opts out permanently by adding
 * `<!-- omp-fest:no-camp-rules -->`. Returns true when the file changed.
 */
export async function syncFestivalCampRules(campRoot: string, festivalDir: string): Promise<boolean> {
  const camp = await campRules(campRoot);
  const file = join(festivalDir, RULES_FILE);
  const existing = await readFile(file, "utf8").catch(() => "");
  if (existing.includes(CAMP_RULES_OPTOUT)) return false;
  if (!existing.trim()) {
    // No rules file at all (e.g. native `fest` scaffold) — seed it with the camp block.
    if (!camp) return false;
    await writeAtomically(file, `${FALLBACK.trimEnd()}\n\n${campRulesBlock(camp)}\n`);
    return true;
  }
  const marked = campRulesSectionOf(existing);
  if (!camp && !marked) return false;
  let next: string;
  if (!camp && marked) {
    next = existing.replace(marked, "").replace(/\n{3,}/g, "\n\n");
  } else if (camp && !marked) {
    next = `${existing.trimEnd()}\n\n${campRulesBlock(camp)}\n`;
  } else if (camp && marked && marked !== campRulesBlock(camp)) {
    next = existing.replace(marked, campRulesBlock(camp));
  } else {
    return false;
  }
  if (next === existing) return false;
  await writeAtomically(file, next.endsWith("\n") ? next : `${next}\n`);
  return true;
}

/**
 * Sync camp rules into every festival dir under the camp (all status dirs).
 * Returns the number of festival files rewritten.
 */
export async function syncCampRules(campRoot: string): Promise<number> {
  const festivalsRoot = join(campRoot, "festivals");
  let synced = 0;
  for (const status of await readdir(festivalsRoot).catch(() => [] as string[])) {
    if (status.startsWith(".")) continue;
    for (const name of await readdir(join(festivalsRoot, status)).catch(() => [] as string[])) {
      if (await syncFestivalCampRules(campRoot, join(festivalsRoot, status, name))) synced += 1;
    }
  }
  return synced;
}

export async function seedFestivalRules(
  campRoot: string,
  festivalDir: string,
  rules?: string,
): Promise<RulesSeedResult> {
  const file = join(festivalDir, RULES_FILE);
  const constraintText = rules?.trim() ?? "";
  const existing = await readFile(file, "utf8").catch(() => "");
  const camp = await campRules(campRoot);
  let content = existing;
  let seeded = false;
  let campSeeded = false;
  if (!content) {
    const base =
      (await readFile(
        join(campRoot, "festivals", ".festival", "templates", "festival", "RULES.md"),
        "utf8",
      ).catch(() => "")) || FALLBACK;
    content = camp ? `${base.trimEnd()}\n\n${campRulesBlock(camp)}\n` : base;
    seeded = true;
    campSeeded = !!camp;
  } else if (camp && !campRulesSectionOf(content) && !content.includes(CAMP_RULES_OPTOUT)) {
    // Existing festival file (e.g. native `fest` scaffold) — append the marked block.
    content = `${content.trimEnd()}\n\n${campRulesBlock(camp)}\n`;
    campSeeded = true;
  }
  if (constraintText && !content.includes(constraintText) && !content.includes(CONSTRAINTS_HEADING)) {
    content = `${content.trimEnd()}\n\n${CONSTRAINTS_HEADING}\n\n${constraintText}\n`;
  }
  if (seeded || content !== existing) {
    await writeFile(file, content);
  }
  return { file: RULES_FILE, seeded, constraints: constraintText.length > 0, campRules: campSeeded };
}

/** The constraints block a `fest rules` reader sees, or undefined when none was recorded. */
export function constraintsSectionOf(rulesText: string): string | undefined {
  const at = rulesText.indexOf(CONSTRAINTS_HEADING);
  if (at === -1) {
    return undefined;
  }
  const rest = rulesText.slice(at + CONSTRAINTS_HEADING.length);
  const nextHeading = rest.search(/^##\s/m);
  const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
  return body.length > 0 ? `${CONSTRAINTS_HEADING}\n\n${body}` : undefined;
}

/** Read a festival's recorded constraints (the section seedFestivalRules wrote). */
export async function festivalConstraints(festivalDir: string): Promise<string | undefined> {
  const text = await readFile(join(festivalDir, RULES_FILE), "utf8").catch(() => "");
  return constraintsSectionOf(text);
}

/**
 * Append the festival's constraints + embedded camp rules to every generated
 * gate task file (fest_type: gate in frontmatter) so the
 * testing/review/iterate/fest-commit checklists enforce the rules the human
 * set — not just the template's generic items. Idempotent; returns files
 * stamped.
 */
export async function stampGateRules(festivalDir: string): Promise<number> {
  const constraints = await festivalConstraints(festivalDir);
  const campBlock = (await festivalCampRules(festivalDir))
    ?.replace(CAMP_RULES_BEGIN, "")
    .replace(CAMP_RULES_END, "")
    .trim();
  const rules = [constraints, campBlock].filter((part): part is string => !!part && part.length > 0);
  if (!rules.length) {
    return 0;
  }
  let stamped = 0;
  for (const phase of await readdir(festivalDir).catch(() => [] as string[])) {
    if (!/^\d{3}_/.test(phase)) {
      continue;
    }
    for (const seq of await readdir(join(festivalDir, phase)).catch(() => [] as string[])) {
      for (const file of await readdir(join(festivalDir, phase, seq)).catch(() => [] as string[])) {
        if (!file.endsWith(".md")) {
          continue;
        }
        const path = join(festivalDir, phase, seq, file);
        const text = await readFile(path, "utf8").catch(() => "");
        if (!/^---[\s\S]*?fest_type:\s*gate/m.test(text)) {
          continue;
        }
        const missing = rules.filter((rule) => !text.includes(rule));
        if (!missing.length) {
          continue;
        }
        await writeFile(path, `${text.trimEnd()}\n\n${missing.join("\n\n")}\n\nThese rules govern this camp and festival — verify each one; a violated rule fails this gate.\n`);
        stamped += 1;
      }
    }
  }
  return stamped;
}
