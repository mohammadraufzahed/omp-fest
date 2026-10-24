import { Supervisor, SUPERVISOR_ENTRY, SUPERVISOR_POLICY, type RuntimeObservation } from "../../application/supervisor.js";
import { releaseProjectFiles } from "../../application/project-conflicts.js";
import { sessionIdOf } from "../../application/session-id.js";
import { showCard, type OverlayUiLike } from "./overlay.js";
import type { PiCommandsLike } from "./commands.js";

export interface SupervisorCommandContext {
  cwd: string;
  sessionManager?: { getSessionId?(): string };
  ui: OverlayUiLike & {
    notify(message: string, type?: string): void;
    select?(title: string, options: (string | { label: string; description?: string })[]): Promise<string | undefined>;
    input?(title: string, placeholder?: string): Promise<string | undefined>;
    confirm?(title: string, message: string): Promise<boolean>;
  };
}
export interface SupervisorCommandHooks {
  isMainSession?(ctx: SupervisorCommandContext): boolean;
  runtimeObservations?(ctx: SupervisorCommandContext): Promise<RuntimeObservation[]>;
  queue?(ctx: SupervisorCommandContext): Promise<unknown>;
}

export function supervisorCommands(pi: PiCommandsLike, supervisor: Supervisor, hooks: SupervisorCommandHooks = {}) {
  const send = (content: string) => { pi.sendMessage({ customType: "fest-workers", content, display: true }, { triggerTurn: false }); };
  const save = (sid: string) => { pi.appendEntry?.(SUPERVISOR_ENTRY, supervisor.state(sid)); };
  const mainOnly = (ctx: SupervisorCommandContext) => {
    if (!hooks.isMainSession || hooks.isMainSession(ctx)) return true;
    send("Festival supervision is main-session only. Return worker reports through the native worker channel."); return false;
  };
  return {
    workers: {
      desc: "inspect supervisor assignments and observed native lifecycle separately",
      run: async (_args: string[], ctx: SupervisorCommandContext) => {
        if (!mainOnly(ctx)) return;
        const state = supervisor.state(sessionIdOf(ctx));
        const lines = [
          `Dispatch ${state.paused ? "paused" : "enabled"}; maximum 3 outstanding assignments`,
          ...state.workers.map((worker) => `${worker.worker} · reported: ${worker.status} · ${worker.festival}/${worker.task}\nNative: ${worker.runtime ? `${worker.runtime.status} (${worker.runtime.source}, ${worker.runtime.runtimeId ?? "identity unavailable"})` : "unverified"}\nReport: ${worker.report || "not submitted"}${worker.reportArtifact ? `\nEvidence artifact: ${worker.reportArtifact}` : ""}\nReview: ${worker.review || "pending"}`),
        ].flatMap((line) => line.split("\n"));
        if (!state.workers.length) lines.push("No workers assigned in this session.");
        if (!(await showCard(ctx.ui, { title: "Festival workers", lines }))) send(lines.join("\n"));
      },
    },
    resume: {
      desc: "reconcile unfinished native workers without unpausing or relaunching",
      run: async (_args: string[], ctx: SupervisorCommandContext) => {
        if (!mainOnly(ctx)) return;
        const sid = sessionIdOf(ctx);
        let observations: RuntimeObservation[] = [];
        try { observations = await hooks.runtimeObservations?.(ctx) ?? []; }
        catch (error) { send(`Native observations unavailable: ${String(error)}. Existing assignments remain reserved; no relaunch.`); }
        const reconciliation = supervisor.reconcile(sid, observations);
        save(sid);
        send(`Resume reconciliation (dispatch ${reconciliation.paused ? "remains paused" : "enabled"}):\n${reconciliation.unfinished.map(({ assignment, next }) => `${assignment.id}: ${assignment.worker} · reported ${assignment.status} · native ${assignment.runtime?.status ?? "unverifiable"}. ${next}`).join("\n") || "No unfinished assignments."}${reconciliation.unknownObservations.length ? `\nObservation issues: ${reconciliation.unknownObservations.join("; ")}` : ""}`);
        if (!pi.sendUserMessage) { send("Resume requires an interactive native omp agent turn; no workers started and pause is unchanged."); return; }
        pi.sendUserMessage(`${SUPERVISOR_POLICY}\nResume this selected festival after reconciliation: ${JSON.stringify(reconciliation)}. Preserve pause. Never relaunch an unfinished or unverified assignment. Message/observe existing native workers, review returned submissions, and call fest_supervisor queue before new dispatch. Continue until a human gate, pause, or genuine blocker.`);
      },
    },
    dispatch: {
      desc: "explicitly unpause dispatch and ask the supervisor to start eligible work",
      run: (_args: string[], ctx: SupervisorCommandContext) => {
        if (!mainOnly(ctx)) return;
        if (!pi.sendUserMessage) { send("Dispatch requires an interactive omp agent turn; no workers started."); return; }
        const sid = sessionIdOf(ctx);
        supervisor.pause(sid, false);
        const reconciliation = supervisor.reconcile(sid);
        save(sid);
        pi.sendUserMessage(`${SUPERVISOR_POLICY}\nResume supervisor execution for this session's explicitly selected festival. Reconcile existing assignments first: ${JSON.stringify(reconciliation)}. Call fest_next and fest_supervisor queue, assign eligible implementation, and dispatch using exposed omp subagent tools. Continue review/integration until a human gate, real blocker, or pause. Do not select an unrelated active festival or duplicate unfinished workers.`);
      },
    },
    pause: {
      desc: "pause new worker assignments without cancelling existing workers",
      run: (_args: string[], ctx: SupervisorCommandContext) => {
        if (!mainOnly(ctx)) return;
        const sid = sessionIdOf(ctx); supervisor.pause(sid, true); save(sid);
        send("New worker dispatch paused. Existing workers are not cancelled; continue receiving and reviewing their results.");
      },
    },
    blockers: {
      desc: "answer retained worker questions and hand the answer to the native supervisor",
      run: async (args: string[], ctx: SupervisorCommandContext) => {
        if (!mainOnly(ctx)) return;
        const sid = sessionIdOf(ctx), state = supervisor.state(sid);
        const pending = (state.blockers ?? []).filter((row) => row.answer === undefined);
        if (!pending.length) {
          send((state.blockers ?? []).map((row) => `${row.id}: ${row.question}\nAnswer: ${row.answer ?? "pending"}`).join("\n") || "No worker blockers in this session."); return;
        }
        let id = args[0];
        if (!id && ctx.ui.select) id = await ctx.ui.select("Select worker blocker", pending.map((row) => ({ label: row.id, description: `${state.workers.find((worker) => worker.id === row.assignmentId)?.worker ?? row.assignmentId}: ${row.question}` })));
        const blocker = pending.find((row) => row.id === id);
        if (!blocker) { send(pending.map((row) => `${row.id}: ${row.question}`).join("\n")); return; }
        if (!ctx.ui.input || !pi.sendUserMessage) { send(`${blocker.question}\nAnswering requires interactive input and a native supervisor turn. No state changed.`); return; }
        const answer = await ctx.ui.input(`Answer worker question: ${blocker.question}`, "Concrete decision or information for this worker");
        if (!answer?.trim()) { send("Blocker answer cancelled; question remains pending."); return; }
        const row = supervisor.answer(sid, blocker.id, answer); save(sid);
        const worker = state.workers.find((item) => item.id === row.assignmentId);
        pi.sendUserMessage(`Worker blocker answer retained: ${JSON.stringify(row)}. Deliver this answer to the existing native worker ${worker?.worker ?? row.assignmentId}${worker?.runtime?.runtimeId ? ` (${worker.runtime.runtimeId})` : " after reconciling its native identity"}. Use the native worker messaging capability, never relaunch a duplicate. Preserve dispatch pause. If messaging is unavailable, report that blocker; the recorded answer remains available through fest_supervisor status.`);
        send("Answer recorded and handed to the supervisor for native delivery to the existing worker. Delivery is not yet confirmed.");
      },
    },
    review: {
      desc: "review a submitted worker result; accepting does not auto-complete the festival task",
      run: async (args: string[], ctx: SupervisorCommandContext) => {
        if (!mainOnly(ctx)) return;
        const sid = sessionIdOf(ctx), candidates = supervisor.state(sid).workers.filter((worker) => worker.status === "ready_for_review");
        if (!candidates.length) { send("No submitted worker results awaiting review."); return; }
        let id = args[0];
        if (!id && ctx.ui.select) id = await ctx.ui.select("Select worker submission", candidates.map((worker) => ({ label: worker.id, description: `${worker.worker}: ${worker.task}` })));
        const row = candidates.find((worker) => worker.id === id);
        if (!row) { send(candidates.map((worker) => `${worker.id}: ${worker.worker} · ${worker.task}`).join("\n")); return; }
        const lines = [`Task: ${row.task}`, `Worker: ${row.worker}`, "Reported evidence (not independently verified):", ...row.report.split("\n"), ...(row.reportArtifact ? [`Full evidence: ${row.reportArtifact}`] : [])];
        const floated = await showCard(ctx.ui, { title: "Review worker submission", lines });
        if (!ctx.ui.select || !ctx.ui.input) { send(`${lines.join("\n")}\nInteractive review requires selection and evidence input. No state changed.`); return; }
        const action = await ctx.ui.select(floated ? "Submission decision" : lines.join("\n"), ["Accept after verification", "Request changes", "Keep pending"]);
        if (!action || action === "Keep pending") return;
        const evidence = await ctx.ui.input(action === "Accept after verification" ? "Independent verification exercised and observed result" : "Required corrections", "Give concrete evidence or corrections");
        if (!evidence?.trim()) { send("Review cancelled: concrete evidence is required."); return; }
        try { supervisor.update(sid, row.id, action === "Accept after verification" ? "accept" : "revise", evidence); }
        catch (error) { send(`Review not applied: ${String(error)}`); return; }
        save(sid);
        if (action === "Accept after verification") {
          if (row.projectDir) {
            try { const released = await releaseProjectFiles(row.projectDir, sid, row.id); if (released.kind === "busy") send("Accepted, but project reservation release is busy; retry release before dispatching overlapping work."); }
            catch (error) { send(`Accepted, but project reservation remains held: ${String(error)}`); }
          }
          if (hooks.queue) { try { send(`Eligible next candidates: ${JSON.stringify(await hooks.queue(ctx))}`); } catch (error) { send(`Queue unavailable: ${String(error)}`); } }
        }
        send(action === "Accept after verification" ? "Submission accepted. Supervisor must still integrate, verify combined behavior and record fest_task_complete/fest_commit." : "Changes requested. Resume the same worker with these corrections; do not launch a duplicate editor.");
      },
    },
  };
}
