import { lstat, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { checkNativeChainEligibility } from "../../application/native-chain.js";
import { containedPath, humanDecision, nativeName, nativeResult, nativeTool, owningMain, selectedFestival } from "./fest-native-context.js";
import { registerAuthoringTools } from "./fest-authoring-tools.js";
import { registerFestivalRecordTools } from "./fest-record-tools.js";
import { registerWorkflowNativeTools } from "./fest-workflow-native-tools.js";
import type { PiLike, ToolDeps } from "./tools.js";

/** Native fest owns runtime state; these tools provide bounded typed arguments and authority. */
export function registerFestNativeTools(pi: PiLike, deps: ToolDeps): void {
  registerWorkflowNativeTools(pi, deps);
  registerAuthoringTools(pi, deps);
  registerFestivalRecordTools(pi, deps);
  const z = pi.zod;
  interface RitualParams { action: "convert" | "run"; festival?: string; name?: string; frequency?: string; moveSource?: boolean; resetProgress?: boolean; dryRun?: boolean }
  nativeTool<RitualParams>(pi, "fest_ritual", "Native ritual convert/run with explicit source resolution and human decision. Conversion preserves the source unless moveSource is explicitly approved; copied runtime progress resets by default. Running creates a new active copy but does not transfer or claim ownership of it.",
    z.object({ action: z.enum(["convert", "run"]), festival: z.string().optional(), name: z.string().optional(), frequency: z.string().optional(), moveSource: z.boolean().optional(), resetProgress: z.boolean().optional(), dryRun: z.boolean().optional() }),
    async (params, ctx) => {
      const cwd = await selectedFestival(deps, ctx, params.festival);
      await owningMain(ctx, cwd);
      if (params.action === "run" && (params.name || params.frequency || params.moveSource !== undefined || params.resetProgress !== undefined || params.dryRun)) throw new Error("run does not support conversion options or dry-run");
      const args = ["ritual", params.action, basename(cwd), "--json"];
      if (params.action === "convert") {
        if (params.name) args.push("--name", nativeName(params.name, "name"));
        if (params.frequency) args.push("--frequency", params.frequency);
        if (params.moveSource) args.push("--move-source");
        if (params.resetProgress === false) args.push("--reset-progress=false");
        if (params.dryRun) args.push("--dry-run");
      }
      if (!params.dryRun) await humanDecision(ctx, params.action === "convert" ? "Convert festival to ritual" : "Create active ritual run", `${params.action} ${cwd}\n${params.moveSource ? "Archive the original source after conversion." : "Preserve the original source."}\nNo ownership will be transferred or claimed for the new copy.`);
      const result = await deps.fest.raw(cwd, args);
      if (result.code === 0 && !params.dryRun) deps.detect.bustCache?.();
      return { ...nativeResult(result, true), ownership: "New ritual/template copies are unclaimed; explicitly select before mutation." };
    });

  interface ChainParams { action: "create" | "add" | "check" | "status" | "validate" | "complete" | "list"; festival?: string; chain?: string; name?: string; goal?: string; after?: string[]; type?: "hard" | "soft"; note?: string; cross?: boolean; force?: boolean; notes?: string }
  nativeTool<ChainParams>(pi, "fest_chain", "Typed native festival-chain create/add/check/status/validate/complete/list. Chain changes require main authority and a human decision; adding requires selected festival ownership. Complete archives the chain and force explicitly bypasses native completion requirements. check delegates native hard-dependency readiness and fails closed on unknown output.",
    z.object({ action: z.enum(["create", "add", "check", "status", "validate", "complete", "list"]), festival: z.string().optional(), chain: z.string().optional(), name: z.string().optional(), goal: z.string().optional(), after: z.array(z.string()).optional(), type: z.enum(["hard", "soft"]).optional(), note: z.string().optional(), cross: z.boolean().optional(), force: z.boolean().optional(), notes: z.string().optional() }),
    async (params, ctx) => {
      const location = await deps.detect.locate(ctx.cwd);
      if (!location.campRoot) throw new Error("Chain operations require a camp workspace");
      const festival = ["add", "check"].includes(params.action) || params.festival ? await selectedFestival(deps, ctx, params.festival) : undefined;
      const cwd = festival ?? location.campRoot;
      if (params.action === "check" && festival && !params.chain) return checkNativeChainEligibility(deps.fest, festival);
      const mutating = ["create", "add", "complete"].includes(params.action);
      if (mutating) await owningMain(ctx, festival);
      const args = ["chain", params.action];
      let json = false;
      if (params.action === "create") { args.push("--name", nativeName(params.name, "name"), "--json"); if (params.goal) args.push("--goal", params.goal); json = true; }
      else if (params.action === "add") {
        if (!festival) throw new Error("Choose the exact festival before adding it to a chain");
        args.push("--chain", nativeName(params.chain, "chain"), "--festival", festival, "--type", params.type ?? "hard", "--json");
        for (const after of params.after ?? []) args.push("--after", nativeName(after, "after"));
        if (params.note) args.push("--note", params.note);
        json = true;
      } else if (params.action === "check") args.push("--chain", nativeName(params.chain, "chain"));
      else if (params.action === "list") { args.push("--json"); json = true; }
      else {
        if (params.chain) args.push(nativeName(params.chain, "chain"));
        else if (!(params.action === "validate" && params.cross)) throw new Error("An explicit chain id is required for status/validate/complete");
        if (params.action === "validate" && params.cross) args.push("--cross");
        if (params.action === "complete") {
          if (params.force) args.push("--force");
          if (params.notes) args.push("--notes", params.notes);
        }
      }
      if (mutating) await humanDecision(ctx, `Confirm chain ${params.action}`, `Run native chain ${params.action} for ${params.chain ?? params.name}?\nFestival: ${festival ?? "none"}\nPrerequisites: ${(params.after ?? []).join(", ") || "none"}\n${params.force ? "FORCE bypasses native completion prerequisites." : "Native validation remains enforced."}`);
      const result = await deps.fest.raw(cwd, args);
      if (mutating && result.code === 0) deps.detect.bustCache?.();
      return nativeResult(result, json);
    });

  interface ReplayParams { action: "inspect" | "generate" | "embed"; festival?: string; output?: string; mp4?: boolean; speed?: number }
  nativeTool<ReplayParams>(pi, "fest_replay", "Inspect actual replay/progress artifacts, generate native GIF/MP4, or embed the native replay in FESTIVAL_OVERVIEW.md. Outputs stay festival-relative. Embedding modifies festival documents; generation requires owning main authority. Rendering is not proof of task or visual verification.",
    z.object({ action: z.enum(["inspect", "generate", "embed"]), festival: z.string().optional(), output: z.string().optional(), mp4: z.boolean().optional(), speed: z.number().optional() }),
    async (params, ctx) => {
      const cwd = await selectedFestival(deps, ctx, params.festival);
      if (params.action === "inspect") {
        const files: { path: string; exists: boolean; bytes?: number }[] = [];
        for (const path of [".fest/progress_events.jsonl", "festival-replay.gif", "FESTIVAL_OVERVIEW.md"]) {
          try { const info = await lstat(await containedPath(cwd, path)); files.push({ path, exists: info.isFile(), bytes: info.size }); }
          catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error; files.push({ path, exists: false }); }
        }
        const overview = files.find((file) => file.path === "FESTIVAL_OVERVIEW.md" && file.exists);
        const embedded = overview ? /!\[[^\]]*\]\([^)]*festival-replay\.gif[^)]*\)/.test(await readFile(await containedPath(cwd, "FESTIVAL_OVERVIEW.md"), "utf8")) : false;
        return { kind: "replay_artifacts", files, embedded, hint: "These are existing artifacts only; inspect or regenerate before presenting a replay as current." };
      }
      await owningMain(ctx, cwd);
      const args = ["gif"];
      if (params.action === "embed") {
        if (params.mp4 || params.output) throw new Error("embed cannot combine mp4/output");
        args.push("--embed");
      } else {
        const output = params.output ?? (params.mp4 ? "festival-replay.mp4" : "festival-replay.gif");
        args.push("--out", await containedPath(cwd, output));
        if (params.mp4) args.push("--mp4");
      }
      if (params.speed !== undefined) {
        if (!Number.isFinite(params.speed) || params.speed <= 0) throw new Error("speed must be positive");
        args.push("--speed", String(params.speed));
      }
      return nativeResult(await deps.fest.raw(cwd, args));
    });
}
