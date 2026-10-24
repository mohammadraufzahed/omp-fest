import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { festivalOwner } from "../../application/festival-ownership.js";
import { readEvidenceBundle, storeEvidenceBundle } from "../../application/evidence-bundles.js";
import { INTEGRATION_GUIDE, integrationReviewStatus, recordIntegrationReview, type IntegrationCheck, type VisualComparison } from "../../application/integration-review.js";
import { sessionIdOf } from "../../application/session-id.js";
import type { PiLike, ToolDeps } from "./tools.js";

export function registerQualityTools(pi: PiLike, deps: ToolDeps) {
  const z = pi.zod;
  interface Context { cwd: string; sessionManager?: { getSessionId?(): string }; agent?: { kind?: string } }
  const selected = async (ctx: Context, selector?: string) => {
    const location = await deps.detect.locate(ctx.cwd);
    if (!location.campRoot) throw new Error("Not inside a camp");
    const match = selector ? matchFestival(await deps.detect.listFestivals(location.campRoot), selector) : undefined;
    if (selector && match?.kind !== "match") throw new Error("Choose one exact festival");
    const dir = match?.kind === "match" ? match.festival.path : await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), location.campRoot);
    if (!dir) throw new Error("No festival selected; use /fest select");
    return dir;
  };
  const output = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
  pi.registerTool({
    name: "fest_integration", label: "Final Integration Review",
    description: `Record actual final integration and visual comparison evidence; no browser is launched by this tool. ${INTEGRATION_GUIDE}`,
    parameters: z.object({
      action: z.enum(["status", "record"]), festival: z.string().optional(), summary: z.string().optional(), details: z.string().optional(),
      checks: z.array(z.object({ id: z.enum(["acceptance", "integration", "layout", "interactions", "responsive", "console"]), status: z.enum(["verified", "failed", "untested", "not_applicable"]), proof: z.string() })).optional(),
      comparisons: z.array(z.object({ page: z.string(), route: z.string(), viewport: z.string(), browserTool: z.string(), reference: z.string(), capture: z.string(), differences: z.array(z.string()), status: z.enum(["verified", "failed", "untested"]) })).optional(),
    }),
    async execute(_id: string, params: { action: "status" | "record"; festival?: string; summary?: string; details?: string; checks?: IntegrationCheck[]; comparisons?: VisualComparison[] }, _signal: unknown, _update: unknown, ctx: Context) {
      try {
        if (ctx.agent?.kind === "sub" && params.action === "record") return output({ kind: "integration_blocked", error: "Only the main supervisor records final integration evidence." });
        const dir = await selected(ctx, params.festival);
        if (params.action === "status") return output(await integrationReviewStatus(dir, deps.detect));
        if ((await festivalOwner(dir))?.sessionId !== sessionIdOf(ctx)) throw new Error("Only the owning supervisor can record integration; select/confirm ownership first.");
        if (deps.supervisor?.state(sessionIdOf(ctx)).workers.some((worker) => worker.status !== "accepted")) throw new Error("Review outstanding worker submissions before final integration");
        return output(await recordIntegrationReview(dir, deps.detect, { sessionId: sessionIdOf(ctx), checks: params.checks ?? [], comparisons: params.comparisons ?? [], summary: params.summary ?? "", details: params.details ?? "" }));
      } catch (error) { return output({ kind: "integration_blocked", error: String(error) }); }
    },
  });
  pi.registerTool({
    name: "fest_evidence", label: "Festival Evidence Bundle",
    description: "Store full verification output and festival-relative screenshot/file attachments in a private evidence bundle; return a compact summary and artifact path. Read by id when detail is needed. Does not claim verification itself.",
    parameters: z.object({ action: z.enum(["store", "read"]), festival: z.string().optional(), id: z.string().optional(), kind: z.enum(["integration", "visual", "worker", "release"]).optional(), summary: z.string().optional(), details: z.string().optional(), attachments: z.array(z.string()).optional() }),
    async execute(_id: string, params: { action: "store" | "read"; festival?: string; id?: string; kind?: "integration" | "visual" | "worker" | "release"; summary?: string; details?: string; attachments?: string[] }, _signal: unknown, _update: unknown, ctx: Context) {
      try {
        if (ctx.agent?.kind === "sub" && params.action === "store") return output({ kind: "evidence_failed", error: "Only the main supervisor stores festival evidence; return worker evidence through the native result." });
        const dir = await selected(ctx, params.festival);
        if (params.action === "read") return output(await readEvidenceBundle(dir, params.id ?? ""));
        if ((await festivalOwner(dir))?.sessionId !== sessionIdOf(ctx)) throw new Error("Only the owning supervisor may store evidence; select/confirm ownership first.");
        return output(await storeEvidenceBundle(dir, { kind: params.kind ?? "worker", summary: params.summary ?? "", details: params.details ?? "", attachments: params.attachments, ownerSessionId: sessionIdOf(ctx) }));
      } catch (error) { return output({ kind: "evidence_failed", error: String(error) }); }
    },
  });
}
