import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { claimedFestivalDir } from "../../application/fest-resolve.js";
import { listProjectReservations } from "../../application/project-conflicts.js";
import { sessionIdOf } from "../../application/session-id.js";
import type { CommandDeps, PiCommandsLike } from "./commands.js";

export function conflictCommands(pi: PiCommandsLike, deps: CommandDeps) {
  return {
    conflicts: {
      desc: "inspect project-wide worker reservations and choose safe sequential or isolated execution",
      run: async (_args: string[], ctx: { cwd: string; sessionManager?: { getSessionId?(): string }; ui: { select?(title: string, options: (string | { label: string; description?: string })[]): Promise<string | undefined> } }) => {
        const location = await deps.detect.locate(ctx.cwd);
        const dir = location.campRoot && deps.tracker ? await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), location.campRoot) : undefined;
        if (!dir || !location.campRoot) throw new Error("Select the intended festival first; unrelated projects are never selected");
        const artifact: unknown = JSON.parse(await readFile(join(dir, "APPROVED_PLAN.json"), "utf8"));
        if (!artifact || typeof artifact !== "object" || !("workingDir" in artifact) || typeof artifact.workingDir !== "string") throw new Error("Approved plan has no working directory");
        const project = resolve(location.campRoot, artifact.workingDir);
        const reservations = await listProjectReservations(project);
        const rows = reservations.map((row) => `${row.sessionId} · ${row.worker ?? row.assignmentId} · ${row.festival ?? "festival"}/${row.task ?? "task"}: ${row.files.join(", ") || "whole project (unknown boundary)"}`);
        pi.sendMessage({ customType: "fest-conflicts", display: true, content: [`Project: ${project}`, ...rows, ...(rows.length ? [] : ["No outstanding reservations."])].join("\n") }, { triggerTurn: false });
        if (!rows.length || !ctx.ui.select) return;
        const action = await ctx.ui.select("Resolve overlapping work without cancelling another session", [
          { label: "Keep sequential", description: "Wait for existing reservation settlement; do not bypass locks" },
          { label: "Plan isolated worktree", description: "Supervisor inspects available native worktree support before creating an isolated checkout" },
          { label: "Inspect only", description: "No state change" },
        ]);
        if (action === "Plan isolated worktree" && pi.sendUserMessage) pi.sendUserMessage(`Inspect available native omp worktree capabilities for isolated implementation of ${dir} in project ${project}. Show intended branch and isolated checkout before any destructive operation. Do not release another session's reservation, steal ownership, or claim a worktree was created without actual tool evidence.`);
        if (action === "Keep sequential") pi.sendMessage({ customType: "fest-conflicts", display: true, content: "Sequential resolution selected. Existing reservations retained; dispatch may resume only after actual settlement/release." }, { triggerTurn: false });
      },
    },
  };
}
