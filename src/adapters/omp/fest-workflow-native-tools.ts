import { lstat } from "node:fs/promises";
import { containedPath, containedRelativePath, humanDecision, nativeName, nativeResult, nativeTool, owningMain, required, selectedFestival, standaloneDirectory } from "./fest-native-context.js";
import type { PiLike, ToolDeps } from "./tools.js";

interface WorkflowStep { name: string; goal: string; actions: string[]; output: string; checkpoint?: "none" | "approval_required" | "verification" | "documentation" }
interface WorkflowParams {
  action: "create" | "init" | "start" | "runs" | "next" | "status" | "show" | "advance";
  mode: "standalone" | "festival";
  festival?: string; directory?: string; phase?: string; name?: string; title?: string; steps?: WorkflowStep[];
  workflowType?: string; workflowId?: string; force?: boolean; step?: number; position?: "before" | "after";
}
export function registerWorkflowNativeTools(pi: PiLike, deps: ToolDeps): void {
  const z = pi.zod;
  nativeTool<WorkflowParams>(pi, "fest_workflow_native",
    "Typed standalone/festival workflow create, init, start, runs, next, status, show, advance. Standalone directory is relative to the current cwd and cannot be inside a festival. Creation requires complete authored steps, not placeholder content. Festival mutations require selected ownership. Checkpoint approval stays human-owned through fest_workflow/fest_gate_submit.",
    z.object({ action: z.enum(["create", "init", "start", "runs", "next", "status", "show", "advance"]), mode: z.enum(["standalone", "festival"]), festival: z.string().optional(), directory: z.string().optional(), phase: z.string().optional(), name: z.string().optional(), title: z.string().optional(), steps: z.array(z.object({ name: z.string(), goal: z.string(), actions: z.array(z.string()), output: z.string(), checkpoint: z.enum(["none", "approval_required", "verification", "documentation"]).optional() })).optional(), workflowType: z.string().optional(), workflowId: z.string().optional(), force: z.boolean().optional(), step: z.number().optional(), position: z.enum(["before", "after"]).optional() }),
    async (params, ctx) => {
      const festival = params.mode === "festival" ? await selectedFestival(deps, ctx, params.festival) : undefined;
      if (params.mode === "standalone" && (params.festival || params.phase)) throw new Error("Standalone mode does not accept festival/phase selectors");
      const cwd = festival ?? await standaloneDirectory(ctx, params.directory);
      if (!festival && params.action !== "create") {
        const workflow = await containedPath(cwd, "WORKFLOW.md");
        if (!(await lstat(workflow)).isFile()) throw new Error("Standalone mode requires an existing WORKFLOW.md; use create to author one first");
      }
      const mutating = ["create", "init", "start", "advance", "next"].includes(params.action);
      if (mutating) await owningMain(ctx, festival);
      if (festival && ["init", "start", "runs"].includes(params.action)) throw new Error("init/start/runs are standalone-only native commands");
      if (festival && params.directory) throw new Error("Use phase for festival workflows; directory is standalone-only");
      const args = params.action === "next" ? ["next", "--json"] : ["workflow", params.action];
      let json = params.action === "next" || params.action === "runs" || params.action === "status" || params.action === "create";
      if (params.action === "runs" || params.action === "status") args.push("--json");
      if (params.phase && params.action !== "create" && params.action !== "next") args.push("--phase", await containedRelativePath(cwd, params.phase));
      if (params.action === "create") {
        if (festival) required(params.phase, "phase");
        if (!params.steps?.length) throw new Error("create requires complete steps");
        for (const step of params.steps) {
          required(step.name, "step.name"); required(step.goal, "step.goal"); required(step.output, "step.output");
          if (!step.actions.length) throw new Error("Each step needs actions");
          step.actions.forEach((action) => required(action, "step.action"));
        }
        args.push(nativeName(params.name, "name"), "--agent", "--steps", JSON.stringify({ title: required(params.title, "title"), steps: params.steps }));
        if (festival) args.push("--position", params.position ?? "after");
        else if (params.workflowType) args.push("--type", nativeName(params.workflowType, "workflowType"));
      }
      if (params.action === "init") {
        if (params.workflowId) args.push("--workflow-id", nativeName(params.workflowId, "workflowId"));
        if (params.force) { await humanDecision(ctx, "Replace workflow runtime", `Overwrite the existing workflow manifest in ${cwd}?`); args.push("--force"); }
      }
      if (params.action === "show" && params.step !== undefined) {
        if (!Number.isInteger(params.step) || params.step < 1) throw new Error("step must be a positive integer");
        args.push(String(params.step)); json = false;
      }
      const executionCwd = (params.action === "next" || (params.action === "create" && festival)) && params.phase ? await containedPath(cwd, params.phase) : cwd;
      const result = await deps.fest.raw(executionCwd, args);
      if (mutating && result.code === 0) deps.detect.bustCache?.();
      return nativeResult(result, json);
    });

  interface JudgeParams { action: "status" | "run" | "reject"; festival?: string; phase?: string; operatorOptIn?: boolean; wait?: boolean; timeoutSeconds?: number; reason?: string; summary?: string; remediationPhase?: string }
  nativeTool<JudgeParams>(pi, "fest_judge",
    "Discover effective approval-judge hooks and workflow verdict/followups; optionally run the existing configured native judge ONLY after explicit operator opt-in and human confirmation. Does not enable/configure a judge, override commands, approve checkpoints, or impersonate a human. Reject records a real operator decision with optional native remediation-phase linkage.",
    z.object({ action: z.enum(["status", "run", "reject"]), festival: z.string().optional(), phase: z.string().optional(), operatorOptIn: z.boolean().optional(), wait: z.boolean().optional(), timeoutSeconds: z.number().optional(), reason: z.string().optional(), summary: z.string().optional(), remediationPhase: z.string().optional() }),
    async (params, ctx) => {
      const cwd = await selectedFestival(deps, ctx, params.festival);
      const phaseArgs = params.phase ? ["--phase", await containedRelativePath(cwd, params.phase)] : [];
      if (params.action === "status") {
        const hooks = await deps.fest.raw(cwd, ["hooks", "list", "--json"]);
        if (hooks.code !== 0) return nativeResult(hooks);
        const status = await deps.fest.raw(cwd, ["workflow", "status", "--json", ...phaseArgs]);
        return { hooks: nativeResult(hooks, true), workflow: nativeResult(status, true), policy: "Existing operator-configured hooks remain native opt-in policy. Explicit judge re-run requires operatorOptIn plus operator confirmation; no config is changed." };
      }
      await owningMain(ctx, cwd);
      if (params.action === "run") {
        if (params.operatorOptIn !== true) throw new Error("Set operatorOptIn only after the operator explicitly requests the configured judge");
        const hooks = await deps.fest.raw(cwd, ["hooks", "list", "--json"]);
        if (hooks.code !== 0) return nativeResult(hooks);
        const discovered = nativeResult(hooks, true);
        if (discovered.kind !== "native_result") return discovered;
        await humanDecision(ctx, "Run configured approval judge", `Run the existing approval judge for ${cwd}? This may execute configured external commands. No judge configuration will be enabled or changed.\n${hooks.stdout}`);
        const args = ["workflow", "judge", ...phaseArgs];
        if (params.wait) args.push("--wait");
        if (params.timeoutSeconds !== undefined) {
          if (!Number.isFinite(params.timeoutSeconds) || params.timeoutSeconds < 0) throw new Error("timeoutSeconds must be nonnegative");
          args.push("--judge-timeout", `${params.timeoutSeconds}s`);
        }
        return nativeResult(await deps.fest.raw(cwd, args));
      }
      const reason = required(params.reason, "reason");
      const args = ["workflow", "reject", "--reason", reason, ...phaseArgs];
      if (params.summary) args.push("--summary", params.summary);
      if (params.remediationPhase) args.push("--remediation-phase", nativeName(params.remediationPhase, "remediationPhase"));
      await humanDecision(ctx, "Reject checkpoint", `Reject the checkpoint in ${cwd}?\nReason: ${reason}\nRemediation: ${params.remediationPhase ?? "none"}`);
      return nativeResult(await deps.fest.raw(cwd, args));
    });
}
