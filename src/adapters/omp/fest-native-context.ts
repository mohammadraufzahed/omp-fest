import { access, lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { festivalOwner } from "../../application/festival-ownership.js";
import { sessionIdOf } from "../../application/session-id.js";
import type { ExecResult } from "../../ports.js";
import type { PiLike, ToolDeps } from "./tools.js";
import type { ZodSchema } from "./zod-types.js";

export interface NativeContext {
  cwd: string;
  sessionManager?: { getSessionId?(): string };
  agent?: { kind?: string };
  ui?: { confirm?(title: string, message: string, opts?: Record<string, unknown>): Promise<boolean> };
}
export function nativeOutput(value: unknown) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] }; }
export function required(value: string | undefined, field: string): string {
  if (!value?.trim() || value.includes("\0")) throw new Error(`${field} is required`);
  return value;
}
export function nativeName(value: string | undefined, field: string): string {
  const result = required(value, field);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(result) || result === "." || result === "..") throw new Error(`${field} must be a name/id, not a path or option`);
  return result;
}
function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
/** Resolve existing ancestors too, preventing outputs through symlinks from escaping root. */
export async function containedPath(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\0")) throw new Error("Paths must be relative without parent traversal");
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, path);
  let ancestor = target;
  for (;;) {
    try {
      const canonical = await realpath(ancestor);
      if (!inside(canonicalRoot, canonical)) throw new Error("Path symlink escapes selected root");
      break;
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (!inside(canonicalRoot, target)) throw new Error("Path escapes selected root");
  return target;
}
/** Some native selectors (notably --phase) are names relative to festival root, not absolute paths. */
export async function containedRelativePath(root: string, path: string): Promise<string> {
  return relative(await realpath(root), await containedPath(root, path)).split(sep).join("/") || ".";
}
export async function selectedFestival(deps: ToolDeps, ctx: NativeContext, selector?: string): Promise<string> {
  const location = await deps.detect.locate(ctx.cwd);
  if (!location.campRoot) throw new Error("Not inside a camp; select a festival from its camp");
  if (selector) {
    const match = matchFestival(await deps.detect.listFestivals(location.campRoot), selector);
    if (match.kind !== "match") throw new Error(match.kind === "ambiguous" ? "Ambiguous festival; use its full id" : "Unknown festival");
    return realpath(match.festival.path);
  }
  const selected = await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), location.campRoot);
  if (!selected) throw new Error("No festival selected; use /fest select explicitly");
  return realpath(selected);
}
export async function owningMain(ctx: NativeContext, festivalDir?: string): Promise<void> {
  if (ctx.agent?.kind === "sub") throw new Error("Only the main supervisor may mutate native state");
  if (festivalDir && (await festivalOwner(festivalDir))?.sessionId !== sessionIdOf(ctx)) throw new Error("Only the selected festival's owning supervisor may mutate it; ownership is never transferred implicitly");
  if (festivalDir) {
    for (const path of [".fest", ".workflow", ".templates", "feedback", "FESTIVAL_OVERVIEW.md"]) await containedPath(festivalDir, path);
  }
}
export async function standaloneDirectory(ctx: NativeContext, path = "."): Promise<string> {
  const dir = await realpath(await containedPath(ctx.cwd, path));
  if (!(await lstat(dir)).isDirectory()) throw new Error("Standalone cwd must be an existing directory");
  let ancestor = dir;
  for (;;) {
    try { await access(join(ancestor, "fest.yaml")); throw new Error("Use festival mode inside a festival; standalone mode cannot bypass ownership"); }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const path of ["WORKFLOW.md", ".workflow"]) await containedPath(dir, path);
  return dir;
}
export async function humanDecision(ctx: NativeContext, operation: string, details: string): Promise<void> {
  if (!ctx.ui?.confirm || !(await ctx.ui.confirm(operation, details))) throw new Error("Explicit operator approval is required; no mutation performed");
}
export function nativeResult(result: ExecResult, json = false): Record<string, unknown> {
  if (result.code !== 0) return { kind: "native_failed", ...result };
  if (!json) return { kind: "native_result", ...result };
  const trimmed = result.stdout.trim();
  try {
    const data: unknown = JSON.parse(trimmed);
    if (!data || typeof data !== "object") throw new Error("Expected JSON object or array");
    if (("ok" in data && data.ok === false) || ("success" in data && data.success === false)) return { kind: "native_failed", ...result, data };
    return { kind: "native_result", ...result, data };
  } catch (initial) {
    // Some native commands emit a warning before a valid JSON payload. Preserve both, but parse the last complete object.
    const start = Math.max(trimmed.lastIndexOf("\n{"), trimmed.lastIndexOf("\n["));
    if (start >= 0) {
      try {
        const data: unknown = JSON.parse(trimmed.slice(start + 1));
        if (data && typeof data === "object") return { kind: ("ok" in data && data.ok === false) || ("success" in data && data.success === false) ? "native_failed" : "native_result", ...result, data, warning: trimmed.slice(0, start).trim() };
      } catch { /* return the original malformed response below */ }
    }
    return { kind: "native_invalid_json", ...result, error: String(initial) };
  }
}
export function nativeTool<P>(pi: PiLike, name: string, description: string, parameters: ZodSchema & { readonly _output?: P }, execute: (params: P, ctx: NativeContext) => Promise<unknown>): void {
  pi.registerTool({ name, label: name, description, parameters,
    async execute(_id: string, params: P, _signal: unknown, _update: unknown, ctx: NativeContext) {
      try { return nativeOutput(await execute(params, ctx)); }
      catch (error) { return nativeOutput({ kind: "native_blocked", error: String(error), nextAction: "Correct the named input or satisfy explicit ownership/operator approval, then retry." }); }
    },
  });
}
