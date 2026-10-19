/**
 * Plugin configuration: `.ompfest.json` at the camp root (or cwd), merged over
 * DEFAULT_CONFIG. JSON (not YAML) to avoid a runtime dependency.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Autonomy, type OmpFestConfig } from "./types.js";

const FILE_NAME = ".ompfest.json";

export async function loadConfig(dir: string): Promise<OmpFestConfig> {
  let parsed: Partial<OmpFestConfig>;
  try {
    const raw = await readFile(join(dir, FILE_NAME), "utf8");
    parsed = JSON.parse(raw) as Partial<OmpFestConfig>;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  return {
    ...DEFAULT_CONFIG,
    ...pickDefined(parsed),
    autonomyCeiling: sanitizeAutonomy(parsed.autonomyCeiling) ?? DEFAULT_CONFIG.autonomyCeiling,
  };
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
