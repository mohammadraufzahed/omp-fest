/**
 * FESTIVAL_RULES.md seeding for scaffolded festivals.
 *
 * `fest rules` reads this file and `fest validate` warns when it's missing,
 * but `fest scaffold from-plan` never copies the camp template in — so the
 * constraints and rules the human states during planning had nowhere durable
 * to live. This seeds the camp's template (or a minimal skeleton when absent)
 * and appends the human's stated constraints verbatim under their own section.
 */
import { readFile, writeFile } from "node:fs/promises";
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
