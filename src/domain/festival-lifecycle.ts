/** Native lifecycle directories, plus layouts retained by older linked camps. */
export const LIVE_FESTIVAL_STATUSES = ["active", "ready", "planning", "ritual", "parked"] as const;
export const TERMINAL_FESTIVAL_STATUSES = ["completed", "archived", "someday"] as const;
export const FESTIVAL_STATUS_DIRECTORIES = [
  ...LIVE_FESTIVAL_STATUSES.map((status) => ({ status, directory: status })),
  ...TERMINAL_FESTIVAL_STATUSES.flatMap((status) => [
    { status, directory: `dungeon/${status}` },
    { status, directory: `.dungeon/${status}` },
  ]),
  { status: "completed", directory: "completed" },
];

export function isFestivalDateBucket(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(name);
}

/** Resolve a festival root's lifecycle without mistaking an ancestor's name for status. */
export function lifecycleStatus(path: string): string | undefined {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const root = parts.lastIndexOf("festivals");
  if (root < 0) return undefined;
  const relative = parts.slice(root + 1);
  const first = relative[0];
  if (LIVE_FESTIVAL_STATUSES.some((status) => status === first) || first === "completed") {
    return relative.length === 2 ? first : undefined;
  }
  if (first !== "dungeon" && first !== ".dungeon") return undefined;
  const status = relative[1];
  if (!TERMINAL_FESTIVAL_STATUSES.some((candidate) => candidate === status)) return undefined;
  return relative.length === 3 || (relative.length === 4 && isFestivalDateBucket(relative[2] ?? ""))
    ? status
    : undefined;
}

export function isCompletedFestivalPath(path: string): boolean {
  return lifecycleStatus(path) === "completed";
}

/** Resolve the linked camp even for terminal lifecycle date buckets. */
export function festivalCampRoot(path: string): string | undefined {
  if (!lifecycleStatus(path)) return undefined;
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const marker = normalized.lastIndexOf("/festivals/");
  if (marker >= 0) return normalized.slice(0, marker) || "/";
  return normalized.startsWith("festivals/") ? "." : undefined;
}
