/**
 * Plugin configuration: `.ompfest.json` at the camp root (or cwd), merged over
 * DEFAULT_CONFIG. JSON (not YAML) to avoid a runtime dependency.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { conventionWarnings } from "../application/conventions.js";
import { DEFAULT_CONFIG, DEFAULT_CONVENTIONS, type Autonomy, type Conventions, type OmpFestConfig } from "./types.js";

const FILE_NAME = ".ompfest.json";

export async function loadConfig(dir: string): Promise<OmpFestConfig> {
  let parsed: Partial<OmpFestConfig>;
  try {
    const raw = await readFile(join(dir, FILE_NAME), "utf8");
    parsed = JSON.parse(raw) as Partial<OmpFestConfig>;
  } catch {
    return { ...DEFAULT_CONFIG, conventions: { ...DEFAULT_CONVENTIONS } };
  }
  const conventions = sanitizeConventions(parsed.conventions);
  return {
    ...DEFAULT_CONFIG,
    ...pickDefined(parsed),
    conventions,
    autonomyCeiling: sanitizeAutonomy(parsed.autonomyCeiling) ?? DEFAULT_CONFIG.autonomyCeiling,
    delegateMode: sanitizeDelegateMode(parsed.delegateMode) ?? DEFAULT_CONFIG.delegateMode,
    configWarnings: conventionWarnings(conventions),
  };
}

/**
 * Merge a patch into `.ompfest.json` at dir, preserving existing keys, and
 * return the effective config (defaults + file + patch).
 */
export async function saveConfig(dir: string, patch: Partial<OmpFestConfig>): Promise<OmpFestConfig> {
  let existing: Record<string, unknown>;
  try {
    existing = JSON.parse(await readFile(join(dir, FILE_NAME), "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  const merged = { ...existing, ...patch };
  if (patch.conventions !== undefined) {
    const prior = existing.conventions && typeof existing.conventions === "object" ? existing.conventions as Record<string, unknown> : {};
    merged.conventions = { ...prior, ...patch.conventions };
  }
  await writeFile(join(dir, FILE_NAME), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return loadConfig(dir);
}

function pickDefined<T extends object>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

function sanitizeAutonomy(value: unknown): Autonomy | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function sanitizeDelegateMode(value: unknown): OmpFestConfig["delegateMode"] | undefined {
  return value === "auto" || value === "always" || value === "never" ? value : undefined;
}

function sanitizeConventions(value: unknown): Conventions {
  const out: Conventions = { ...DEFAULT_CONVENTIONS };
  if (!value || typeof value !== "object") return out;
  const v = value as Record<string, unknown>;
  if (typeof v.festivalName === "string") out.festivalName = v.festivalName;
  if (typeof v.branch === "string" && v.branch.trim()) out.branch = v.branch;
  if (typeof v.worktreeDir === "string" && v.worktreeDir.trim()) out.worktreeDir = v.worktreeDir;
  if (v.commitStyle === "free" || v.commitStyle === "conventional" || v.commitStyle === "prefix") out.commitStyle = v.commitStyle;
  if (typeof v.commitPrefix === "string") out.commitPrefix = v.commitPrefix;
  if (v.finishMerge === "merge" || v.finishMerge === "squash") out.finishMerge = v.finishMerge;
  return out;
}
