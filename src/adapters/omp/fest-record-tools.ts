import { isHandoffInput, readHandoff, writeHandoff, type HandoffInput } from "../../application/handoff.js";
import { containedPath, containedRelativePath, humanDecision, nativeName, nativeResult, nativeTool, owningMain, required, selectedFestival } from "./fest-native-context.js";
import type { PiLike, ToolDeps } from "./tools.js";

export function registerFestivalRecordTools(pi: PiLike, deps: ToolDeps): void {
  const z = pi.zod;
  interface ResearchParams { action: "create" | "link" | "summary"; festival?: string; type?: "investigation" | "comparison" | "analysis" | "specification"; title?: string; path?: string; document?: string; phases?: string[]; sequences?: string[]; tasks?: string[]; bidirectional?: boolean; unlink?: boolean; phase?: string; output?: string; format?: "json" | "markdown" }
  nativeTool<ResearchParams>(pi, "fest_research", "Native research documents: create from real research template, link findings to festival work (optionally bidirectional/unlink), or summarize existing research. Every path is festival-relative; mutations require owning main authority. Template content must be completed before execution.",
    z.object({ action: z.enum(["create", "link", "summary"]), festival: z.string().optional(), type: z.enum(["investigation", "comparison", "analysis", "specification"]).optional(), title: z.string().optional(), path: z.string().optional(), document: z.string().optional(), phases: z.array(z.string()).optional(), sequences: z.array(z.string()).optional(), tasks: z.array(z.string()).optional(), bidirectional: z.boolean().optional(), unlink: z.boolean().optional(), phase: z.string().optional(), output: z.string().optional(), format: z.enum(["json", "markdown"]).optional() }),
    async (params, ctx) => {
      const cwd = await selectedFestival(deps, ctx, params.festival);
      if (params.action !== "summary" || params.output) await owningMain(ctx, cwd);
      const args = ["research", params.action];
      let json = true;
      if (params.action === "create") args.push("--title", required(params.title, "title"), "--type", required(params.type, "type"), "--path", await containedPath(cwd, required(params.path, "path")), "--json");
      else if (params.action === "link") {
        args.push(await containedPath(cwd, required(params.document, "document")), "--json");
        if (!(params.phases?.length || params.sequences?.length || params.tasks?.length)) throw new Error("link needs phases, sequences or tasks");
        for (const [flag, paths] of [["--phase", params.phases], ["--sequence", params.sequences], ["--task", params.tasks]] as const) for (const path of paths ?? []) args.push(flag, await containedRelativePath(cwd, path));
        if (params.bidirectional) args.push("--bidirectional");
        if (params.unlink) args.push("--unlink");
      } else {
        args.push("--format", params.format ?? "json");
        if (params.phase) args.push("--phase", await containedRelativePath(cwd, params.phase)); else args.push("--festival");
        if (params.output) args.push("--output", await containedPath(cwd, params.output));
        json = !params.output && params.format !== "markdown";
      }
      return nativeResult(await deps.fest.raw(cwd, args), json);
    });

  interface FeedbackParams { action: "init" | "add" | "view" | "export"; festival?: string; criteria?: string[]; criterion?: string; force?: boolean; observation?: string; severity?: "low" | "medium" | "high"; suggestion?: string; task?: string; summary?: boolean; format?: "markdown" | "json" | "yaml" }
  nativeTool<FeedbackParams>(pi, "fest_feedback", "Typed native feedback init/add/view/export. Record actual observations, not invented results. Replacing criteria requires human confirmation; native --force preserves observations. Export returns the native text without shell redirection or arbitrary output paths.",
    z.object({ action: z.enum(["init", "add", "view", "export"]), festival: z.string().optional(), criteria: z.array(z.string()).optional(), criterion: z.string().optional(), force: z.boolean().optional(), observation: z.string().optional(), severity: z.enum(["low", "medium", "high"]).optional(), suggestion: z.string().optional(), task: z.string().optional(), summary: z.boolean().optional(), format: z.enum(["markdown", "json", "yaml"]).optional() }),
    async (params, ctx) => {
      const cwd = await selectedFestival(deps, ctx, params.festival);
      if (params.action === "init" || params.action === "add") await owningMain(ctx, cwd);
      const args = ["feedback", params.action];
      if (params.action === "init") {
        if (!params.criteria?.length) throw new Error("init requires criteria");
        for (const criterion of params.criteria) args.push("--criteria", required(criterion, "criterion"));
        if (params.force) { await humanDecision(ctx, "Replace feedback criteria", `Replace feedback criteria for ${cwd}, preserving observations?`); args.push("--force"); }
      } else if (params.action === "add") {
        args.push("--criteria", required(params.criterion, "criterion"), "--observation", required(params.observation, "observation"));
        if (params.suggestion) args.push("--suggestion", params.suggestion);
        if (params.task) args.push("--task", await containedPath(cwd, params.task));
      } else if (params.action === "view") {
        args.push("--json");
        if (params.criterion) args.push("--criteria", params.criterion);
        if (params.summary) args.push("--summary");
      } else args.push("--format", params.format ?? "markdown");
      if (params.severity && (params.action === "add" || params.action === "view")) args.push("--severity", params.severity);
      return nativeResult(await deps.fest.raw(cwd, args), params.action === "view" || (params.action === "export" && params.format === "json"));
    });

  interface HandoffParams extends Partial<HandoffInput> { action: "write" | "read"; festival?: string; id?: string }
  nativeTool<HandoffParams>(pi, "fest_handoff", "Write/read an immutable portable festival-relative handoff containing concrete decisions and rejected alternatives, changed files, caller-reported checks with actual output/evidence paths, failures, blockers, and next action. Does not execute or verify checks; reference fest_verification/evidence artifacts instead of inventing proof. Empty arrays mean none, not omitted work.",
    z.object({ action: z.enum(["write", "read"]), festival: z.string().optional(), id: z.string().optional(), summary: z.string().optional(), decisions: z.array(z.object({ decision: z.string(), rationale: z.string(), rejectedAlternatives: z.array(z.string()) })).optional(), changedFiles: z.array(z.object({ path: z.string(), change: z.string() })).optional(), checks: z.array(z.object({ command: z.string(), cwd: z.string(), status: z.enum(["passed", "failed", "not_run"]), output: z.string(), evidencePaths: z.array(z.string()) })).optional(), failures: z.array(z.string()).optional(), blockers: z.array(z.string()).optional(), nextAction: z.string().optional() }),
    async (params, ctx) => {
      const cwd = await selectedFestival(deps, ctx, params.festival);
      if (params.action === "read") return readHandoff(cwd, nativeName(params.id, "id"));
      await owningMain(ctx, cwd);
      const input = { summary: params.summary, decisions: params.decisions, changedFiles: params.changedFiles, checks: params.checks, failures: params.failures, blockers: params.blockers, nextAction: params.nextAction };
      // Application validates the entire payload before persisting; missing fields are never defaulted to fake evidence.
      if (!isHandoffInput(input)) throw new Error("write requires all handoff sections; checks need observed output or explicit not_run");
      return writeHandoff(cwd, input);
    });
}
