import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { Supervisor, SUPERVISOR_ENTRY, SUPERVISOR_POLICY } from "../../application/supervisor.js";
import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { claimFestivalOwnership } from "../../application/festival-ownership.js";
import { BROWSER_VERIFICATION_POLICY } from "../../domain/orientation.js";
import { sessionIdOf } from "../../application/session-id.js";
import type { PiLike, ToolDeps } from "./tools.js";

export function registerSupervisorTools(pi: PiLike, deps: ToolDeps, supervisor: Supervisor): void {
  const z = pi.zod;
  pi.registerTool({
    name: "fest_supervisor",
    label: "Supervise Festival Workers",
    description: "Assign eligible festival tasks and track real omp subagent dispatches, blockers, submissions and independent supervisor review. Does not launch workers or complete festival tasks. Main agent only; workers return results through their native subagent channel.",
    parameters: z.object({
      action: z.enum(["status", "assign", "running", "submit", "block", "accept", "revise"]),
      festival: z.string().optional(), task: z.string().optional(), worker: z.string().optional(),
      assignment: z.string().optional(), evidence: z.string().optional(),
    }),
    async execute(_id: string, params: { action: "status" | "assign" | "running" | "submit" | "block" | "accept" | "revise"; festival?: string; task?: string; worker?: string; assignment?: string; evidence?: string }, _signal: unknown, _update: unknown, ctx: { cwd: string; sessionManager?: { getSessionId?(): string } }) {
      const sid = sessionIdOf(ctx);
      const output = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
      if (params.action === "status") return output(supervisor.state(sid));
      try {
        let result;
        if (params.action === "assign") {
          const location = await deps.detect.locate(ctx.cwd);
          if (!location.campRoot) throw new Error("Select a festival inside a camp first.");
          const match = params.festival ? matchFestival(await deps.detect.listFestivals(location.campRoot), params.festival) : undefined;
          const dir = match?.kind === "match" ? match.festival.path : await claimedFestivalDir(deps.tracker, deps.detect, sid, location.campRoot);
          if (params.festival && match?.kind !== "match") throw new Error("Choose one exact festival.");
          if (!dir) throw new Error("No selected festival. Use /fest select first.");
          const owner = await claimFestivalOwnership(dir, sid);
          if (owner.kind !== "claimed") throw new Error("Festival belongs to another session; transfer only through /fest select.");
          const current = await deps.fest.next(dir);
          if (current.kind !== "task") throw new Error("No eligible implementation task: resolve the current gate or blocker first.");
          const pending = await deps.detect.pendingTasks(dir);
          const task = pending.find((item) => item.path === params.task && !item.done);
          if (!task || !params.worker) throw new Error("Choose an exact pending task and a worker name.");
          const document = await readFile(join(dir, task.path), "utf8");
          if (current.path !== task.path && current.path !== join(dir, task.path)) {
            const currentRelative = current.path.startsWith(`${dir}/`) ? current.path.slice(dir.length + 1) : current.path;
            const first = pending.find((item) => !item.done && item.sequence === task.sequence);
            if (task.path.split("/")[0] !== currentRelative.split("/")[0] || first?.path !== task.path) throw new Error("Only the first pending task in a sequence of the current phase is eligible.");
            const dependencies = /^Dependencies: (.+)$/m.exec(document)?.[1];
            if (!dependencies) throw new Error("Parallel dispatch needs an explicit approved dependency contract.");
            const completed = new Set<string>();
            for (const done of pending.filter((item) => item.done)) {
              const doc = await readFile(join(dir, done.path), "utf8");
              const id = /^Task ID: (.+)$/m.exec(doc)?.[1];
              if (id) completed.add(id);
            }
            if (dependencies !== "none" && dependencies.split(", ").some((id) => !completed.has(id))) throw new Error("Task dependencies are not completed.");
          }
          const files = [...document.matchAll(/^- (.+) \((?:existing|proposed)\)$/gm)].flatMap((match) => match[1] ? [match[1]] : []);
          const row = supervisor.assign(sid, basename(dir), task.path, params.worker, files);
          deps.tracker.taskOpened(sid, task.path);
          result = { assignment: row, contract: { festivalDir: dir, task: task.path, workingDir: current.workingDir, document, policy: SUPERVISOR_POLICY, browserVerification: BROWSER_VERIFICATION_POLICY }, nextSteps: "Launch this named worker using the exposed omp subagent tool and contract, then mark running. No subagent capability means blocked, not launched." };
        } else {
          if (!params.assignment) throw new Error("Assignment id is required.");
          result = supervisor.update(sid, params.assignment, params.action, params.evidence ?? "");
        }
        pi.appendEntry?.(SUPERVISOR_ENTRY, supervisor.state(sid));
        return output(result);
      } catch (error) {
        return output({ kind: "supervisor_blocked", error: String(error) });
      }
    },
  });
}
