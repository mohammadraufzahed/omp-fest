import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type NativeJson = null | boolean | number | string | NativeJson[] | { [key: string]: NativeJson };
export function isNativeObject(value: unknown): value is Record<string, NativeJson> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(isNativeJson);
}
function isNativeJson(value: unknown): value is NativeJson {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (Array.isArray(value) ? value.every(isNativeJson) : isNativeObject(value));
}
export function parseNativeJson(text: string): NativeJson {
  const value: unknown = JSON.parse(text);
  if (!isNativeJson(value)) throw new Error("Camp returned invalid JSON data.");
  return value;
}
export function nativeArgument(value: string | undefined, name: string): string {
  if (!value?.trim() || value.startsWith("-") || /[\0\r\n]/u.test(value)) throw new Error(`${name} must be a nonempty literal value, not an option.`);
  return value;
}
export function campRelativePath(root: string, value: string): string {
  const path = resolve(root, nativeArgument(value, "path"));
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Artifact paths must stay within the resolved camp root.");
  return rel || ".";
}
function option(args: string[], name: string, value: string | number | undefined): void {
  if (value !== undefined) args.push(`--${name}`, String(value));
}
function repeated(args: string[], name: string, values?: string[]): void {
  for (const value of values ?? []) option(args, name, nativeArgument(value, name));
}
export interface WorkitemRequest {
  action: "list" | "create" | "links" | "link" | "unlink" | "promote";
  selector?: string; slug?: string; title?: string; type?: string; projects?: string[]; tags?: string[]; quest?: string;
  query?: string; stages?: string[]; attentionStages?: string[]; showParked?: boolean;
  path?: string; project?: string; festival?: string; worktree?: string;
  role?: "primary" | "related" | "blocked_by" | "supersedes"; linkId?: string;
  target?: "ready" | "active" | "festival" | "doc" | "completed" | "archived" | "someday";
  destination?: string; goal?: string; keep?: boolean; dryRun?: boolean;
}
export function workitemCommand(root: string, p: WorkitemRequest): string[] {
  if (p.action === "promote") {
    const args = ["workitem", "promote", nativeArgument(p.selector, "selector"), "--target", nativeArgument(p.target, "target"), "--json", "--no-commit"];
    option(args, "dest", p.destination === undefined ? undefined : campRelativePath(root, p.destination));
    option(args, "goal", p.goal);
    if (p.keep) args.push("--keep");
    if (p.dryRun) args.push("--dry-run");
    return args;
  }
  const args = ["workitem", p.action];
  if (p.action === "create") {
    args.push(nativeArgument(p.slug, "slug"));
    option(args, "title", p.title); option(args, "type", p.type); option(args, "quest", p.quest);
    repeated(args, "project", p.projects?.map((path) => campRelativePath(root, path))); repeated(args, "tag", p.tags);
  } else if (p.action === "list") {
    option(args, "type", p.type); option(args, "query", p.query);
    repeated(args, "project", p.projects); repeated(args, "tag", p.tags); repeated(args, "stage", p.stages); repeated(args, "attention-stage", p.attentionStages);
    if (p.showParked) args.push("--show-parked");
  } else {
    if (p.selector !== undefined) args.push(nativeArgument(p.selector, "selector"));
    if (p.action === "link" || p.action === "unlink") {
      if (p.action === "link" && !p.selector) throw new Error("Link requires a workitem selector.");
      const scopes = [p.path, p.project, p.festival, p.worktree].filter((value) => value !== undefined);
      if (scopes.length > 1) throw new Error("Choose exactly one link scope: path, project, festival, or worktree.");
      if (p.action === "link" && scopes.length !== 1) throw new Error("Link requires an explicit scope.");
      if (p.action === "unlink" && !p.linkId && !p.selector) throw new Error("Unlink requires an exact linkId or selector; unscoped removal is not supported.");
      if (p.path) args.push(campRelativePath(root, p.path));
      option(args, "project", p.project); option(args, "festival", p.festival); option(args, "worktree", p.worktree);
      if (p.action === "link") option(args, "role", p.role);
      if (p.action === "unlink") option(args, "id", p.linkId);
    }
  }
  return [...args, "--json"];
}
export interface IntentRequest {
  action: "list" | "show" | "create" | "promote";
  selector?: string; title?: string; body?: string; type?: "idea" | "feature" | "bug" | "research" | "chore";
  concept?: string; tags?: string[]; status?: string; project?: string;
  target?: "ready" | "festival" | "design"; dryRun?: boolean;
}
export function intentCommand(p: IntentRequest): string[] {
  if (p.action === "promote") {
    const args = ["promote", nativeArgument(p.selector, "selector"), "--target", nativeArgument(p.target, "target"), "--json", "--no-commit"];
    if (p.dryRun) args.push("--dry-run");
    return args;
  }
  const args = ["idea", p.action === "create" ? "add" : p.action];
  if (p.action === "create") {
    args.push(nativeArgument(p.title, "title"), "--no-commit");
    option(args, "body", p.body); option(args, "type", p.type); option(args, "concept", p.concept); repeated(args, "tag", p.tags);
  } else if (p.action === "show") args.push(nativeArgument(p.selector, "selector"));
  else { option(args, "status", p.status); option(args, "project", p.project); }
  return [...args, "--json"];
}
export interface QuestRequest {
  action: "list" | "show" | "status" | "context" | "create" | "update" | "checklist" | "links" | "link" | "unlink" | "item_add" | "item_edit" | "item_done" | "item_reopen" | "item_rank" | "item_link" | "item_unlink";
  quest?: string; item?: string; name?: string; title?: string; purpose?: string; description?: string; notes?: string;
  workitem?: string; path?: string; linkType?: string; rank?: number; status?: "open" | "doing" | "done" | "dropped"; openOnly?: boolean; all?: boolean;
}
export function questCommand(root: string, p: QuestRequest): { args: string[]; json: boolean } {
  if (p.action === "context") return { args: ["quest", "use", nativeArgument(p.quest, "quest"), "--shell", "posix"], json: false };
  let args: string[];
  let json = true;
  if (p.action.startsWith("item_")) {
    const actions: Partial<Record<QuestRequest["action"], string>> = { item_add: "add", item_edit: "edit", item_done: "done", item_reopen: "reopen", item_rank: "rank", item_link: "link-workitem", item_unlink: "unlink-workitem" };
    const action = actions[p.action];
    if (!action) throw new Error("Unknown checklist action.");
    args = ["quest", "item", action, nativeArgument(p.quest, "quest")];
    if (p.action === "item_add") args.push(nativeArgument(p.title, "title"));
    else args.push(nativeArgument(p.item, "item"));
    if (p.action === "item_rank") {
      if (!Number.isSafeInteger(p.rank)) throw new Error("rank must be a safe integer.");
      args.push(String(p.rank));
    }
    if (p.action === "item_link") args.push(nativeArgument(p.workitem, "workitem"));
    if (p.action === "item_add" || p.action === "item_edit") {
      option(args, "notes", p.notes); option(args, "status", p.status);
      if (p.action === "item_add") { option(args, "workitem", p.workitem); if (p.rank !== undefined) { if (!Number.isSafeInteger(p.rank)) throw new Error("rank must be a safe integer."); option(args, "rank", p.rank); } }
      else option(args, "title", p.title);
    }
    args.push("--no-commit");
  } else {
    args = ["quest", p.action];
    if (p.action === "create") {
      args.push(nativeArgument(p.name, "name"), "--no-editor", "--no-commit");
      option(args, "purpose", p.purpose); option(args, "description", p.description); option(args, "workitem", p.workitem);
    } else if (p.action === "list") { if (p.all) args.push("--all"); }
    else if (p.action !== "status") {
      args.push(nativeArgument(p.quest, "quest"));
      if (p.action === "update") {
        if (p.purpose === undefined && p.description === undefined) throw new Error("Update requires purpose or description.");
        option(args, "purpose", p.purpose); option(args, "description", p.description); args.push("--no-commit"); json = false;
      }
      if (p.action === "checklist" && p.openOnly) args.push("--open");
      if (p.action === "link" || p.action === "unlink") {
        args.push(campRelativePath(root, nativeArgument(p.path, "path")), "--no-commit"); json = false;
        if (p.action === "link") option(args, "type", p.linkType);
      }
    }
  }
  if (json) args.push("--json");
  return { args, json };
}
export interface TriageRequest {
  action: "start" | "status" | "queue" | "template" | "evidence" | "propose" | "review" | "approve" | "apply" | "refresh" | "verify";
  run?: string; scopes?: string[]; profile?: "default" | "sweep" | "deep"; full?: boolean;
  role?: "evidence" | "synthesis"; stableId?: string; file?: string; noEvidence?: boolean;
  disposition?: string; summary?: string; confidence?: "high" | "medium" | "low";
  ids?: string[]; lane?: string; batch?: number; amend?: string; reject?: boolean; note?: string; dryRun?: boolean;
}
export function triageCommand(p: TriageRequest): string[] {
  const args = ["triage"];
  if (p.action === "template" || p.action === "evidence") args.push("evidence", p.action === "template" ? "template" : "set", nativeArgument(p.stableId, "stableId"));
  else args.push(p.action);
  if (p.action === "start") { repeated(args, "scope", p.scopes); option(args, "profile", p.profile); args.push("--identity", "strict"); if (p.full) args.push("--full"); }
  if (p.action !== "start") option(args, "run", p.run === undefined ? undefined : nativeArgument(p.run, "run"));
  if (p.action === "queue") option(args, "role", p.role);
  if (p.action === "evidence") {
    if (Boolean(p.file) === Boolean(p.noEvidence)) throw new Error("Evidence requires exactly one of file or noEvidence; noEvidence explicitly records that no reading was done.");
    if (p.noEvidence) args.push("--no-evidence"); else option(args, "file", p.file);
  }
  if (p.action === "propose") {
    args.push(nativeArgument(p.stableId, "stableId"), "--disposition", nativeArgument(p.disposition, "disposition"));
    if (Boolean(p.file) === Boolean(p.summary?.trim())) throw new Error("Proposal requires exactly one of a rationale file or summary.");
    option(args, "file", p.file); option(args, "summary", p.summary); option(args, "confidence", p.confidence);
  }
  if (p.action === "review") args.push("--render-only");
  if (p.action === "approve") {
    if (Number(Boolean(p.ids?.length)) + Number(p.lane !== undefined) + Number(p.batch !== undefined) !== 1) throw new Error("Approve requires exactly one selector: ids, lane, or batch.");
    for (const id of p.ids ?? []) args.push(nativeArgument(id, "stable id"));
    option(args, "lane", p.lane);
    if (p.batch !== undefined) { if (!Number.isSafeInteger(p.batch) || p.batch < 1) throw new Error("batch must be a positive integer."); option(args, "batch", p.batch); }
    if (p.reject && p.amend) throw new Error("reject and amend are mutually exclusive.");
    option(args, "amend", p.amend); option(args, "note", p.note); if (p.reject) args.push("--reject");
  }
  if (p.action === "apply" && p.dryRun) args.push("--dry-run");
  if (p.action !== "template") args.push("--json");
  return args;
}
/** Native state, not rendered documents, is the decision revision. Never synthesize a CLI revision. */
export async function triageRevision(root: string, run: string): Promise<string> {
  nativeArgument(run, "run");
  if (run.includes("/") || run.includes("\\") || run === "." || run === "..") throw new Error("Invalid native run id.");
  const dir = join(root, ".campaign", "triage", "runs", run);
  const hash = createHash("sha256");
  async function visit(path: string): Promise<void> {
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("Unexpected symlink in native triage state; inspect it before approving.");
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")) { hash.update(relative(dir, full)); hash.update("\0"); hash.update(await readFile(full)); hash.update("\0"); }
    }
  }
  await visit(dir);
  return hash.digest("hex");
}
