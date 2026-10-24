import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { claimedFestivalDir } from "../../application/fest-resolve.js";
import { festivalOwner } from "../../application/festival-ownership.js";
import { INTEGRATION_GUIDE, integrationReviewStatus } from "../../application/integration-review.js";
import { previewRelease, executeRelease } from "../../application/release-workflow.js";
import { storeEvidenceBundle } from "../../application/evidence-bundles.js";
import { listProjectReservations } from "../../application/project-conflicts.js";
import { NodeExecRunner } from "../cli/node-exec.js";
import { sessionIdOf } from "../../application/session-id.js";
import type { CommandDeps, PiCommandsLike } from "./commands.js";

interface QualityContext {
  cwd: string; sessionManager?: { getSessionId?(): string };
  ui: { notify(message: string, type?: string): void; confirm?(title: string, message: string): Promise<boolean>; input?(title: string, placeholder?: string): Promise<string | undefined>; select?(title: string, options: (string | { label: string; description?: string })[]): Promise<string | undefined> };
}
export function qualityCommands(pi: PiCommandsLike, deps: CommandDeps) {
  const send = (content: string) => { pi.sendMessage({ customType: "fest-quality", content, display: true }, { triggerTurn: false }); };
  const selected = async (ctx: QualityContext) => {
    const location = await deps.detect.locate(ctx.cwd);
    const sid = sessionIdOf(ctx);
    const dir = location.campRoot && deps.tracker ? await claimedFestivalDir(deps.tracker, deps.detect, sid, location.campRoot) : undefined;
    if (!dir) throw new Error("Select a festival with /fest select first; unrelated active festivals are never selected.");
    if ((await festivalOwner(dir))?.sessionId !== sid) throw new Error("Festival ownership changed; confirm transfer before mutation.");
    if (!location.campRoot) throw new Error("Selected festival has no camp root");
    return { dir, root: location.campRoot, sid };
  };
  return {
    finish: {
      desc: "run the final integration and visual comparison pass before human gates",
      run: async (_args: string[], ctx: QualityContext) => {
        const { dir } = await selected(ctx);
        const workers = deps.supervisor?.state(sessionIdOf(ctx)).workers ?? [];
        if (workers.some((worker) => worker.status !== "accepted")) { send("Finish blocked: receive and independently review outstanding workers first. No worker cancelled."); return; }
        const status = await integrationReviewStatus(dir, deps.detect);
        if (!pi.sendUserMessage) { send(`${JSON.stringify(status)}\n${INTEGRATION_GUIDE}`); return; }
        pi.sendUserMessage(`${INTEGRATION_GUIDE}\nFestival: ${dir}. Prior review: ${JSON.stringify(status)}. Do not claim completion until actual verification is recorded. Do not add scope or approve your own gate.`);
      },
    },
    release: {
      desc: "authorized package version/check/commit/push checklist: /fest release [patch|minor|major]",
      run: async (args: string[], ctx: QualityContext) => {
        const { dir, root } = await selected(ctx);
        if (deps.supervisor?.state(sessionIdOf(ctx)).workers.some((worker) => worker.status !== "accepted")) throw new Error("Settle outstanding workers before release");
        const review = await integrationReviewStatus(dir, deps.detect);
        if (review.status !== "verified") throw new Error(`Release requires current verified final integration review (got ${review.status}); run /fest finish`);
        const artifact: unknown = JSON.parse(await readFile(resolve(dir, "APPROVED_PLAN.json"), "utf8"));
        if (!artifact || typeof artifact !== "object" || !("workingDir" in artifact) || typeof artifact.workingDir !== "string") throw new Error("Release needs the approved project working directory");
        let bump = args[0];
        if (!bump && ctx.ui.select) bump = await ctx.ui.select("Semantic release", [{ label: "patch", description: "Compatible fixes" }, { label: "minor", description: "New compatible features" }, { label: "major", description: "Breaking public contract" }]);
        if (bump !== "patch" && bump !== "minor" && bump !== "major") { send("Release cancelled; choose patch, minor or major."); return; }
        const exec = new NodeExecRunner();
        const project = resolve(root, artifact.workingDir);
        const reservations = await listProjectReservations(project);
        if (reservations.length) throw new Error(`Release blocked by active project writes: ${reservations.map((item) => `${item.sessionId}/${item.assignmentId}: ${item.files.join(", ")}`).join("; ")}`);
        const preview = await previewRelease(project, bump, exec);
        const confirmed = await ctx.ui.confirm?.("Authorize release, commit and push", `${preview.currentVersion} → ${preview.nextVersion}\nBranch: ${preview.branch}\nChecks: ${preview.checks.join(", ")}\nExact changed files:\n${preview.files.join("\n")}\nVersion, verify, stage these files, commit and push to the configured upstream?`);
        if (!confirmed) { send("Release cancelled; no version, commit or push performed."); return; }
        const message = await ctx.ui.input?.("Release commit message", `chore: release ${preview.nextVersion}`);
        if (!message?.trim()) { send("Release cancelled; commit message required."); return; }
        const currentReservations = await listProjectReservations(preview.cwd);
        if (currentReservations.length) throw new Error(`Release blocked by active project writes before execution: ${currentReservations.map((item) => `${item.sessionId}/${item.assignmentId}: ${item.files.join(", ")}`).join("; ")}`);
        const result = await executeRelease(preview, bump, message, exec);
        const evidence = await storeEvidenceBundle(dir, { kind: "release", summary: `${result.status}: ${preview.nextVersion}`, details: JSON.stringify(result, null, 2), ownerSessionId: sessionIdOf(ctx) });
        send(JSON.stringify({ status: result.status, version: preview.nextVersion, evidence }));
      },
    },
  };
}
