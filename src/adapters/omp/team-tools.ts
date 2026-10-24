import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { claimedFestivalDir, matchFestival } from "../../application/fest-resolve.js";
import { festivalOwner } from "../../application/festival-ownership.js";
import {
  claimFestivalTask,
  joinFestivalTeam,
  readFestivalTeam,
  readFestivalTeamInbox,
  releaseFestivalTask,
  reviewFestivalTask,
  sendFestivalTeamMessage,
  submitFestivalTask,
} from "../../application/festival-team.js";
import { listFestivalCreationOrphans } from "../../application/festival-creation.js";
import { releasePortfolioAssignment, reservePortfolioAssignment, updatePortfolioAssignment } from "../../application/portfolio-state.js";
import { FESTIVAL_CLAIM_ENTRY } from "../../application/session-claim.js";
import { sessionIdOf } from "../../application/session-id.js";
import { Supervisor } from "../../application/supervisor.js";
import { supervisorQueue } from "./supervisor-tools.js";
import type { PiLike, ToolDeps } from "./tools.js";

interface TeamToolContext {
  cwd: string;
  sessionManager?: { getSessionId?(): string };
  agent?: { kind?: string };
}

async function teamLocation(deps: ToolDeps, sid: string, cwd: string, selector?: string) {
  const location = await deps.detect.locate(cwd);
  if (!location.campRoot) throw new Error("Festival team actions require a camp root.");
  let dir: string | undefined;
  if (selector) {
    const match = matchFestival(await deps.detect.listFestivals(location.campRoot), selector);
    if (match.kind !== "match") throw new Error(match.kind === "ambiguous"
      ? `Festival selector is ambiguous: ${match.matches.map((item) => item.id).join(", ")}`
      : `Unknown festival ${selector}.`);
    dir = match.festival.path;
  } else {
    dir = await claimedFestivalDir(deps.tracker, deps.detect, sid, location.campRoot);
  }
  if (!dir) throw new Error("No festival selected for this session. Use /fest join <festival> or /fest select <festival> first.");
  return { campRoot: location.campRoot, dir };
}

export function registerFestivalTeamTools(pi: PiLike, deps: ToolDeps, supervisor: Supervisor): void {
  const z = pi.zod;
  pi.registerTool({
    name: "fest_team",
    label: "Festival Team",
    description: "Coordinate AI work across explicitly joined omp sessions on one shared worktree. Join never transfers festival ownership. Claims are per-task; project files are serialized only during native write/edit operations. Use the board/inbox to coordinate, submit evidence, and leave integration, task completion, gates, and commits to the coordinator.",
    parameters: z.object({
      action: z.enum(["join", "board", "queue", "claim", "submit", "review", "release", "message", "inbox"]),
      festival: z.string().optional(), task: z.string().optional(), assignment: z.string().optional(),
      evidence: z.string().optional(), label: z.string().optional(), decision: z.enum(["accept", "revise"]).optional(), toSession: z.string().optional(), markRead: z.boolean().optional(),
    }),
    async execute(_id: string, params: {
      action: "join" | "board" | "queue" | "claim" | "submit" | "review" | "release" | "message" | "inbox";
      festival?: string; task?: string; assignment?: string; evidence?: string; label?: string; decision?: "accept" | "revise"; toSession?: string; markRead?: boolean;
    }, _signal: unknown, _update: unknown, ctx: TeamToolContext) {
      const output = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
      const sid = sessionIdOf(ctx);
      if (ctx.agent?.kind === "sub" && (!["board", "queue", "inbox"].includes(params.action) || (params.action === "inbox" && params.markRead))) {
        return output({ kind: "team_blocked", error: "Native task workers cannot claim, review, submit, message, release, join, or mark team messages read; return results to the main supervisor." });
      }
      try {
        const { campRoot, dir } = await teamLocation(deps, sid, ctx.cwd, params.festival);
        const owner = await festivalOwner(dir);
        if (params.action === "join") {
          if (!owner) throw new Error("Festival has no coordinator; use /fest select <id> in its coordinating session first.");
          const pending = (await listFestivalCreationOrphans(campRoot)).find((item) => item.receipt.name === basename(dir) || item.festivalDir === dir);
          if (pending) throw new Error("This festival has an incomplete scaffold transaction. Resolve it with /fest orphans before joining.");
          const team = await joinFestivalTeam(campRoot, dir, sid, owner.sessionId, params.label);
          deps.tracker.claimFestival(sid, dir);
          pi.appendEntry?.(FESTIVAL_CLAIM_ENTRY, { festivalId: basename(dir), festivalDir: dir, campRoot });
          return output({ kind: "team_joined", festival: basename(dir), coordinatorSessionId: team.coordinatorSessionId, ownershipTransferred: false, hint: "Work only on tasks claimed through fest_team; send a concise submission when done." });
        }
        const team = await readFestivalTeam(campRoot, dir);
        if (params.action === "board") return output({ kind: "team_board", festival: basename(dir), ownerSessionId: owner?.sessionId, team });
        if (!team?.participants.some((participant) => participant.sessionId === sid) && team?.coordinatorSessionId !== sid) {
          throw new Error("This session is not a festival team member. Join explicitly with /fest join <festival>.");
        }
        if (params.action === "queue") {
          const { queue } = await supervisorQueue(deps, supervisor, sid, ctx.cwd, basename(dir));
          return output({ kind: "team_queue", festival: basename(dir), queue, assignments: team.assignments.filter((assignment) => assignment.status !== "accepted") });
        }
        if (params.action === "claim") {
          if (!params.task) throw new Error("Claim requires the exact task path from the team queue.");
          const { queue } = await supervisorQueue(deps, supervisor, sid, ctx.cwd, basename(dir));
          const candidate = queue.candidates.find((item) => item.task === params.task);
          if (!candidate?.workingDir) throw new Error(queue.waiting.find((item) => item.task === params.task)?.reason ?? "Task is not currently dependency-eligible; refresh the team queue.");
          const assignment = await claimFestivalTask(campRoot, dir, sid, candidate.task, candidate.workingDir, params.label ?? sid);
          try {
            await reservePortfolioAssignment(campRoot, {
              id: assignment.id,
              festival: basename(dir),
              task: candidate.task,
              sessionId: sid,
              worker: params.label ?? sid,
              workingDir: candidate.workingDir,
              files: candidate.files,
            });
          } catch (error) {
            await releaseFestivalTask(campRoot, dir, sid, assignment.id, "Portfolio slot reservation failed.");
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("Portfolio worker limit reached")) throw new Error(`Portfolio limit reached: ${message}`, { cause: error });
            throw error;
          }
          deps.tracker.taskOpened(sid, candidate.task);
          const taskDocument = await readFile(join(dir, candidate.task), "utf8");
          return output({ kind: "team_task_claimed", assignment, taskFile: candidate.task, taskDocument, workingDir: candidate.workingDir, instructions: "Implement only this task in the shared worktree. Use native write/edit tools so exact-file locks cover writes only. Do not mark the festival task complete, integrate, or commit; submit files changed and actual verification evidence here." });
        }
        if (params.action === "submit") {
          if (!params.assignment || !params.evidence?.trim()) throw new Error("Submission requires assignment id and concrete evidence.");
          const assignment = await submitFestivalTask(campRoot, dir, sid, params.assignment, params.evidence);
          await updatePortfolioAssignment(campRoot, assignment.id, "submitted", { report: params.evidence });
          deps.tracker.cleared(sid);
          return output({ kind: "team_submission", assignment });
        }
        if (params.action === "review") {
          if (!params.assignment || !params.evidence?.trim()) throw new Error("Review requires assignment id and evidence.");
          if (!params.decision) throw new Error("Review requires decision accept or revise.");
          const assignment = await reviewFestivalTask(campRoot, dir, sid, params.assignment, params.decision, params.evidence);
          await updatePortfolioAssignment(campRoot, assignment.id, params.decision === "accept" ? "accepted" : "running", { report: assignment.review });
          return output({ kind: "team_review", assignment });
        }
        if (params.action === "release") {
          if (!params.assignment || !params.evidence?.trim()) throw new Error("Release requires assignment id and a reason.");
          const assignment = await releaseFestivalTask(campRoot, dir, sid, params.assignment, params.evidence);
          await releasePortfolioAssignment(campRoot, assignment.id, params.evidence);
          return output({ kind: "team_assignment_released", assignment });
        }
        if (params.action === "message") {
          if (!params.evidence?.trim()) throw new Error("Message body is required.");
          return output({ kind: "team_message_sent", message: await sendFestivalTeamMessage(campRoot, dir, sid, params.evidence, params.toSession, params.task) });
        }
        return output({ kind: "team_inbox", festival: basename(dir), messages: await readFestivalTeamInbox(campRoot, dir, sid, params.markRead) });
          
      } catch (error) {
        return output({ kind: "team_blocked", error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}
