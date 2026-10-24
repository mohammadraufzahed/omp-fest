import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { claimedFestivalDir } from "../../application/fest-resolve.js";
import { listProjectReservations, reclaimProjectFiles } from "../../application/project-conflicts.js";
import { sessionIdOf } from "../../application/session-id.js";
import type { CommandDeps, PiCommandsLike } from "./commands.js";

export function conflictCommands(pi: PiCommandsLike, deps: CommandDeps) {
  return {
    conflicts: {
      desc: "inspect active per-file write locks and resolve abandoned writes",
      run: async (args: string[], ctx: { cwd: string; sessionManager?: { getSessionId?(): string }; ui: { select?(title: string, options: (string | { label: string; description?: string })[]): Promise<string | undefined>; confirm?(title: string, message: string): Promise<boolean> } }) => {
        const location = await deps.detect.locate(ctx.cwd);
        const dir = location.campRoot && deps.tracker ? await claimedFestivalDir(deps.tracker, deps.detect, sessionIdOf(ctx), location.campRoot) : undefined;
        if (!dir || !location.campRoot) throw new Error("Select the intended festival first; unrelated projects are never selected");
        const artifact: unknown = JSON.parse(await readFile(join(dir, "APPROVED_PLAN.json"), "utf8"));
        if (!artifact || typeof artifact !== "object" || !("workingDir" in artifact) || typeof artifact.workingDir !== "string") throw new Error("Approved plan has no working directory");
        const project = resolve(location.campRoot, artifact.workingDir);
        const writeLocks = await listProjectReservations(project);
        const rows = writeLocks.map((row) => `${row.sessionId} · ${row.worker ?? row.assignmentId} · ${row.festival ?? "festival"}/${row.task ?? "write"}: ${row.files.join(", ") || "legacy whole-checkout lock"}`);
        pi.sendMessage({ customType: "fest-conflicts", display: true, content: [`Project: ${project}`, ...rows, ...(rows.length ? [] : ["No active write locks."])].join("\n") }, { triggerTurn: false });
        if (args[0] === "reclaim") {
          if (!ctx.ui.select || !ctx.ui.confirm) throw new Error("Write-lock reclaim requires interactive native confirmation.");
          const chosen = await ctx.ui.select("Choose a write lock to reclaim", writeLocks.map((row) => ({ label: `${row.assignmentId} · ${row.sessionId}`, description: `${row.files.join(", ")} — verify the write process stopped first` })));
          if (!chosen) return;
          const [assignmentId, sessionId] = chosen.split(" · ");
          const expected = writeLocks.find((row) => row.assignmentId === assignmentId && row.sessionId === sessionId);
          if (!expected) return;
          const confirmed = await ctx.ui.confirm("Reclaim write lock?", `Confirm the write process is stopped and safe to retry. This releases ${expected.assignmentId} (${expected.sessionId}) on ${expected.files.join(", ")}. This does not stop a worker.`);
          if (!confirmed) return;
          const result = await reclaimProjectFiles(project, expected);
          pi.sendMessage({ customType: "fest-conflicts", display: true, content: result.kind === "busy" ? "Write-lock registry busy; nothing reclaimed." : result.released ? "Write lock reclaimed after explicit confirmation. Refresh the queue before dispatch." : "Write lock changed or was already released; reread conflicts." }, { triggerTurn: false });
          return;
        }
        if (!rows.length || !ctx.ui.select) return;
        const action = await ctx.ui.select("Resolve overlapping work without cancelling another session", [
          { label: "Keep sequential", description: "Wait for this in-progress write to return; do not bypass its file lock" },
          { label: "Plan isolated worktree", description: "Supervisor inspects available native worktree support before creating an isolated checkout" },
          { label: "Inspect only", description: "No state change" },
        ]);
        if (action === "Plan isolated worktree" && pi.sendUserMessage) pi.sendUserMessage(`Inspect available native omp worktree capabilities for isolated implementation of ${dir} in project ${project}. Show intended branch and isolated checkout before any destructive operation. Do not release another session's write lock or claim a worktree was created without actual tool evidence.`);
        if (action === "Keep sequential") pi.sendMessage({ customType: "fest-conflicts", display: true, content: "Wait for the active file write to return, then refresh the queue." }, { triggerTurn: false });
      },
    },
  };
}
