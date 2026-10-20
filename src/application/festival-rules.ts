/**
 * FESTIVAL_RULES.md seeding + gate enforcement.
 *
 * `fest rules` reads this file and `fest validate` warns when it's missing,
 * but `fest scaffold from-plan` never copies the camp template in — so the
 * constraints and rules the human states during planning had nowhere durable
 * to live. This seeds the camp's template (or a minimal skeleton when absent),
 * appends the human's stated constraints verbatim under their own section,
 * and stamps those constraints into every generated gate task so quality
 * gates actually enforce them.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RULES_FILE = "FESTIVAL_RULES.md";
const CONSTRAINTS_HEADING = "## Constraints & Rules (agreed during planning)";
const FALLBACK = `# Festival Rules\n\nPrinciples, standards, and practices all workers must follow throughout this festival.\n`;

export interface RulesSeedResult {
  /** Festival-relative file name — always FESTIVAL_RULES.md. */
  file: string;
  /** True when the file was created by this call (template or fallback). */
  seeded: boolean;
  /** True when the human's constraints were appended. */
  constraints: boolean;
}

export async function seedFestivalRules(
  campRoot: string,
  festivalDir: string,
  rules?: string,
): Promise<RulesSeedResult> {
  const file = join(festivalDir, RULES_FILE);
  const constraintText = rules?.trim() ?? "";
  const existing = await readFile(file, "utf8").catch(() => "");
  let content = existing;
  let seeded = false;
  if (!content) {
    content =
      (await readFile(
        join(campRoot, "festivals", ".festival", "templates", "festival", "RULES.md"),
        "utf8",
      ).catch(() => "")) || FALLBACK;
    seeded = true;
  }
  if (constraintText && !content.includes(constraintText) && !content.includes(CONSTRAINTS_HEADING)) {
    content = `${content.trimEnd()}\n\n${CONSTRAINTS_HEADING}\n\n${constraintText}\n`;
  }
  if (seeded || content !== existing) {
    await writeFile(file, content);
  }
  return { file: RULES_FILE, seeded, constraints: constraintText.length > 0 };
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
 * Append the festival's constraints to every generated gate task file
 * (fest_type: gate in frontmatter) so the testing/review/iterate/fest-commit
 * checklists enforce the rules the human set at plan time — not just the
 * template's generic items. Idempotent; returns files stamped.
 */
export async function stampGateRules(festivalDir: string): Promise<number> {
  const constraints = await festivalConstraints(festivalDir);
  if (!constraints) {
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
        if (!/^---[\s\S]*?fest_type:\s*gate/m.test(text) || text.includes(CONSTRAINTS_HEADING)) {
          continue;
        }
        await writeFile(path, `${text.trimEnd()}\n\n${constraints}\n\nThese rules were agreed at plan time — verify each one; a violated constraint fails this gate.\n`);
        stamped += 1;
      }
    }
  }
  return stamped;
}
