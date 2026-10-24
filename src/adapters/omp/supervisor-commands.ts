import { Supervisor, SUPERVISOR_ENTRY, SUPERVISOR_POLICY, type RuntimeObservation } from "../../application/supervisor.js";
import { PORTFOLIO_MAX_WORKERS, type PortfolioCandidate } from "../../application/portfolio-queue.js";
import type { PortfolioStateAssignment } from "../../application/portfolio-state.js";
import { sessionIdOf } from "../../application/session-id.js";
import { showCard, type OverlayUiLike } from "./overlay.js";
import type { PiCommandsLike } from "./commands.js";
export interface PortfolioCommandData {
  workerLimit: number;
  activeWorkers: number;
  availableSlots: number;
  paused?: boolean;
  festivalRows?: { festival: string; status: string; progress?: string }[];
  candidates?: PortfolioCandidate[];
  waiting?: { festival: string; task: string; reason: string }[];
  activeAssignments?: PortfolioStateAssignment[];
  failedTasks?: PortfolioStateAssignment[];
  fileLockConflicts?: { festival: string; task: string; files: string[]; reason?: string }[];
  staleAssignments?: PortfolioStateAssignment[];
  errors?: { festival: string; error: string }[];
}

const assignmentLabel = (row: PortfolioStateAssignment) => `${row.festival}/${row.task} · ${row.worker} · ${row.status} · ${row.id}`;

function portfolioLines(data: PortfolioCommandData): string[] {
  return [
    `Workers: ${data.activeWorkers}/${data.workerLimit} active in camp · ${data.availableSlots} available${data.paused ? " · portfolio dispatch paused" : ""}`,
    "Festivals:",
    ...(data.festivalRows?.length ? data.festivalRows.map((row) => `• ${row.festival} · ${row.status}${row.progress ? ` · ${row.progress}` : ""}`) : ["• None"]),
    "Fair candidates:",
    ...(data.candidates?.length ? data.candidates.map((row) => `• ${row.festival}/${row.task} · ${row.priority ?? "normal"} · ${row.files.join(", ") || "file boundary unavailable"}`) : ["• None"]),
    "Waiting / festival errors:",
    ...((data.waiting?.map((row) => `• ${row.festival}/${row.task}: ${row.reason}`) ?? [])),
    ...((data.errors?.map((row) => `• ${row.festival}: ${row.error}`) ?? [])),
    ...(!(data.waiting?.length || data.errors?.length) ? ["• None"] : []),
    "Active workers:",
    ...(data.activeAssignments?.length ? data.activeAssignments.map((row) => `• ${assignmentLabel(row)}`) : ["• None"]),
    "Failed tasks:",
    ...(data.failedTasks?.length ? data.failedTasks.map((row) => `• ${row.festival}/${row.task}${row.failure ? `: ${row.failure}` : ""}`) : ["• None"]),
    "Current file-lock conflicts:",
    ...(data.fileLockConflicts?.length ? data.fileLockConflicts.map((row) => `• ${row.festival}/${row.task}: ${row.files.join(", ") || "files"}${row.reason ? ` · ${row.reason}` : ""}`) : ["• None"]),
    "Stale assignment recovery candidates (advisory only):",
    ...(data.staleAssignments?.length ? data.staleAssignments.map(assignmentLabel) : ["• None"]),
    "Stale recovery is advisory only; assignments are never auto-released or relaunched.",
  ];
}

export interface SupervisorCommandContext {
  cwd: string;
  sessionManager?: { getSessionId?(): string };
  agent?: { kind?: "main" | "sub" };
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
  portfolio?(ctx: SupervisorCommandContext): Promise<PortfolioCommandData>;
  setPortfolioWorkerLimit?(ctx: SupervisorCommandContext, limit: number): Promise<unknown>;
  setPortfolioPaused?(ctx: SupervisorCommandContext, paused: boolean): Promise<void>;
}

export function supervisorCommands(pi: PiCommandsLike, supervisor: Supervisor, hooks: SupervisorCommandHooks = {}) {
  const send = (content: string) => { pi.sendMessage({ customType: "fest-workers", content, display: true }, { triggerTurn: false }); };
  const save = (sid: string) => { pi.appendEntry?.(SUPERVISOR_ENTRY, supervisor.state(sid)); };
  const mainOnly = (ctx: SupervisorCommandContext) => {
    if (!hooks.isMainSession || hooks.isMainSession(ctx)) return true;
    send("Festival supervision is main-session only. Return worker reports through the native worker channel."); return false;
  };
  return {
    portfolio: {
      desc: "inspect the multi-festival worker portfolio or set its worker limit",
      run: async (args: string[], ctx: SupervisorCommandContext) => {
        if (!mainOnly(ctx)) return;
        if (args.length) {
          if (args.length !== 2 || args[0]?.toLowerCase() !== "limit") {
            send(`Usage: /fest portfolio [limit N] (N must be an integer from 1 to ${PORTFOLIO_MAX_WORKERS}).`); return;
          }
          const rawLimit = args[1] ?? "";
          const limit = Number(rawLimit);
          if (!/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > PORTFOLIO_MAX_WORKERS) {
            send(`Invalid portfolio worker limit "${rawLimit}". Choose an integer from 1 to ${PORTFOLIO_MAX_WORKERS}.`); return;
          }
          if (!hooks.setPortfolioWorkerLimit) { send("Portfolio worker limit is unavailable; no setting changed."); return; }
          try {
            await hooks.setPortfolioWorkerLimit(ctx, limit);
            send(`Portfolio worker limit set to ${limit}.`);
          } catch (error) { send(`Portfolio worker limit was not changed: ${String(error)}`); }
          return;
        }
        if (!hooks.portfolio) { send("Portfolio data is unavailable."); return; }
        try {
          const data = await hooks.portfolio(ctx);
          const lines = portfolioLines(data);
          if (!(await showCard(ctx.ui, { title: "Festival portfolio", lines }))) send(lines.join("\n"));
        } catch (error) { send(`Portfolio dashboard unavailable: ${String(error)}`); }
      },
    },
    workers: {
      desc: "inspect supervisor assignments and observed native lifecycle separately",
      run: async (_args: string[], ctx: SupervisorCommandContext) => {
        if (!mainOnly(ctx)) return;
        const state = supervisor.state(sessionIdOf(ctx));
        const lines = [
          `Dispatch ${state.paused ? "paused" : "enabled"}; no fixed assignment cap; file locks cover writes only`,
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
      run: async (_args: string[], ctx: SupervisorCommandContext) => {
        if (!mainOnly(ctx)) return;
        if (!pi.sendUserMessage) { send("Dispatch requires an interactive omp agent turn; no workers started."); return; }
        const sid = sessionIdOf(ctx);
        supervisor.pause(sid, false);
        save(sid);
        if (hooks.setPortfolioPaused) {
          try { await hooks.setPortfolioPaused(ctx, false); }
          catch (error) { send(`Portfolio dispatch was not resumed: ${String(error)}. No portfolio dispatch was requested.`); return; }
        }
        const reconciliation = supervisor.reconcile(sid);
        pi.sendUserMessage(`${SUPERVISOR_POLICY}\nResume portfolio orchestration for festivals explicitly owned by this session; never select unowned, joined, or unrelated festivals, and never transfer ownership. Reconcile existing assignments first: ${JSON.stringify(reconciliation)}. Call fest_supervisor with the portfolio action to get candidates across every explicitly owned festival, then dispatch eligible implementation through native omp agents fairly across those owned festivals until available slots are filled (maximum 20 workers), respecting the configured worker limit. Never use one festival's queue as a global queue. Never duplicate unfinished assignments. Do not cancel unrelated work or weaken festival-local dependency, gate, and file-lock checks.`);
      },
    },
    pause: {
      desc: "pause new worker assignments without cancelling existing workers",
      run: async (_args: string[], ctx: SupervisorCommandContext) => {
        if (!mainOnly(ctx)) return;
        const sid = sessionIdOf(ctx); supervisor.pause(sid, true); save(sid);
        try {
          await hooks.setPortfolioPaused?.(ctx, true);
          send("New portfolio worker dispatch paused. Existing workers are not cancelled; continue receiving and reviewing their results.");
        } catch (error) { send(`Local dispatch paused, but the portfolio pause was not saved: ${String(error)}. Existing workers are not cancelled.`); }
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
          if (hooks.queue) { try { send(`Eligible next candidates: ${JSON.stringify(await hooks.queue(ctx))}`); } catch (error) { send(`Queue unavailable: ${String(error)}`); } }
        }
        send(action === "Accept after verification" ? "Submission accepted. Supervisor must still integrate, verify combined behavior and record fest_task_complete/fest_commit." : "Changes requested. Resume the same worker with these corrections; do not launch a duplicate editor.");
      },
    },
  };
}
