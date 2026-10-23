import { Supervisor, SUPERVISOR_ENTRY, SUPERVISOR_POLICY } from "../../application/supervisor.js";
import { sessionIdOf } from "../../application/session-id.js";
import { showCard, type OverlayUiLike } from "./overlay.js";
import type { PiCommandsLike } from "./commands.js";

interface SupervisorCommandContext {
  cwd: string;
  sessionManager?: { getSessionId?(): string };
  ui: OverlayUiLike & {
    notify(message: string, type?: string): void;
    select?(title: string, options: (string | { label: string; description?: string })[]): Promise<string | undefined>;
    input?(title: string, placeholder?: string): Promise<string | undefined>;
    confirm?(title: string, message: string): Promise<boolean>;
  };
}

export function supervisorCommands(pi: PiCommandsLike, supervisor: Supervisor) {
  const send = (content: string) => { pi.sendMessage({ customType: "fest-workers", content, display: true }, { triggerTurn: false }); };
  const save = (sid: string) => { pi.appendEntry?.(SUPERVISOR_ENTRY, supervisor.state(sid)); };
  return {
    workers: {
      desc: "inspect supervisor assignments and worker reports",
      run: async (_args: string[], ctx: SupervisorCommandContext) => {
        const state = supervisor.state(sessionIdOf(ctx));
        const lines = [
          `Dispatch ${state.paused ? "paused" : "enabled"}; maximum 3 outstanding assignments`,
          ...state.workers.map((worker) => `${worker.worker} · ${worker.status} · ${worker.festival}/${worker.task}\nReport: ${worker.report || "not submitted"}\nReview: ${worker.review || "pending"}`),
        ].flatMap((line) => line.split("\n"));
        if (!state.workers.length) lines.push("No workers assigned in this session.");
        if (!(await showCard(ctx.ui, { title: "Festival workers", lines }))) send(lines.join("\n"));
      },
    },
    dispatch: {
      desc: "resume dispatch and ask the supervisor to start eligible work",
      run: (_args: string[], ctx: SupervisorCommandContext) => {
        if (!pi.sendUserMessage) { send("Dispatch requires an interactive omp agent turn; no workers started."); return; }
        const sid = sessionIdOf(ctx);
        supervisor.pause(sid, false);
        save(sid);
        pi.sendUserMessage(`${SUPERVISOR_POLICY}\nResume supervisor execution for this session's explicitly selected festival. Call fest_next, assign eligible implementation through fest_supervisor, and dispatch using exposed omp subagent tools. Continue review/integration until a human gate, real blocker, or pause. Do not select an unrelated active festival.`);
      },
    },
    pause: {
      desc: "pause new worker assignments without cancelling existing workers",
      run: (_args: string[], ctx: SupervisorCommandContext) => {
        const sid = sessionIdOf(ctx);
        supervisor.pause(sid, true);
        save(sid);
        send("New worker dispatch paused. Existing workers are not cancelled; continue receiving and reviewing their results.");
      },
    },
    review: {
      desc: "review a submitted worker result; accepting does not auto-complete the festival task",
      run: async (args: string[], ctx: SupervisorCommandContext) => {
        const sid = sessionIdOf(ctx);
        const candidates = supervisor.state(sid).workers.filter((worker) => worker.status === "ready_for_review");
        if (!candidates.length) { send("No submitted worker results awaiting review."); return; }
        let id = args[0];
        if (!id && ctx.ui.select) id = await ctx.ui.select("Select worker submission", candidates.map((worker) => ({ label: worker.id, description: `${worker.worker}: ${worker.task}` })));
        const row = candidates.find((worker) => worker.id === id);
        if (!row) { send(candidates.map((worker) => `${worker.id}: ${worker.worker} · ${worker.task}`).join("\n")); return; }
        const lines = [`Task: ${row.task}`, `Worker: ${row.worker}`, "Reported evidence (not independently verified):", ...row.report.split("\n")];
        const floated = await showCard(ctx.ui, { title: "Review worker submission", lines });
        if (!ctx.ui.select || !ctx.ui.input) { send(`${lines.join("\n")}\nInteractive review requires selection and evidence input. No state changed.`); return; }
        const action = await ctx.ui.select(floated ? "Submission decision" : lines.join("\n"), ["Accept after verification", "Request changes", "Keep pending"]);
        if (!action || action === "Keep pending") return;
        const evidence = await ctx.ui.input(action === "Accept after verification" ? "Independent verification exercised and observed result" : "Required corrections", "Give concrete evidence or corrections");
        if (!evidence?.trim()) { send("Review cancelled: concrete evidence is required."); return; }
        supervisor.update(sid, row.id, action === "Accept after verification" ? "accept" : "revise", evidence);
        save(sid);
        send(action === "Accept after verification" ? "Submission accepted. Supervisor must still integrate, verify combined behavior and record fest_task_complete/fest_commit." : "Changes requested. Resume the same worker with these corrections; do not launch a duplicate editor.");
      },
    },
  };
}
