import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { festivalOwner } from "../../application/festival-ownership.js";
import { sessionIdOf } from "../../application/session-id.js";
import { recordVerificationResult, verificationRequirements, verificationResultStatus, type VerificationResultInput } from "../../application/verification-results.js";
import type { PiLike, ToolDeps } from "./tools.js";

interface Context { cwd: string; sessionManager?: { getSessionId?(): string }; agent?: { kind?: string } }
export function registerVerificationTools(pi: PiLike, deps: ToolDeps): void {
  const z = pi.zod;
  const output = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  pi.registerTool({
    name: "fest_verification", label: "Record Actual Verification",
    description: "Inspect declared task checks or record actual results. Planned command provenance never counts as execution evidence. Verified results require an existing fest_evidence bundle, actual tool, matching command/cwd and exitCode:0 for commands, or route/viewport/state for browser observations. Failed/untested checks remain explicit and do not satisfy completion.",
    parameters: z.object({ action: z.enum(["requirements", "record", "status"]), festival: z.string().optional(), task: z.string().optional(), check: z.string().optional(), status: z.enum(["verified", "failed", "untested"]).optional(), proof: z.string().optional(), tool: z.string().optional(), command: z.string().optional(), cwd: z.string().optional(), exitCode: z.number().optional(), route: z.string().optional(), viewport: z.string().optional(), state: z.string().optional(), evidenceId: z.string().optional() }),
    async execute(_id: string, params: Partial<VerificationResultInput> & { action: "requirements" | "record" | "status"; festival?: string }, _signal: unknown, _update: unknown, ctx: Context) {
      try {
        const location = await deps.detect.locate(ctx.cwd);
        if (!location.campRoot) throw new Error("Not inside a camp");
        const match = params.festival ? matchFestival(await deps.detect.listFestivals(location.campRoot), params.festival) : undefined;
        if (params.festival && match?.kind !== "match") throw new Error("Choose one exact festival");
        const dir = match?.kind === "match" ? match.festival.path : await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), location.campRoot);
        if (!dir) throw new Error("Select the intended festival first");
        if (params.action === "requirements") return output({ kind: "verification_requirements", checks: await verificationRequirements(dir, params.task) });
        if (params.action === "status") return output({ kind: "verification_status", ...await verificationResultStatus(dir, params.task) });
        if (ctx.agent?.kind === "sub" || (await festivalOwner(dir))?.sessionId !== sessionIdOf(ctx)) throw new Error("Only the owning supervisor records verification; workers return actual evidence to the coordinator");
        if (!params.task || !params.check || !params.status || !params.proof) throw new Error("record requires task, check, status and proof");
        return output({ kind: "verification_recorded", result: await recordVerificationResult(dir, { ...params, task: params.task, check: params.check, status: params.status, proof: params.proof }) });
      } catch (error) { return output({ kind: "verification_failed", error: String(error), nextAction: "Read requirements/status, exercise the exact declared check, store actual output with fest_evidence, and record only observed results." }); }
    },
  });
}
