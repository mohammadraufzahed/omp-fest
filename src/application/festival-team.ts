import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep, join } from "node:path";

export interface FestivalTeamParticipant { sessionId: string; joinedAt: string; label?: string }
export interface FestivalTeamAssignment {
  id: string; task: string; workingDir: string; sessionId: string; label?: string;
  status: "claimed" | "submitted" | "accepted" | "released"; createdAt: string; updatedAt: string;
  report?: string; review?: string; reviewSource?: "worker-submission" | "coordinator-worktree";
}
export interface FestivalTeamMessage { id: string; fromSession: string; toSession?: string; body: string; task?: string; createdAt: string; readAt?: string }
export interface FestivalTeam {
  version: 1; festivalId: string; coordinatorSessionId?: string;
  participants: FestivalTeamParticipant[]; assignments: FestivalTeamAssignment[]; messages: FestivalTeamMessage[];
}

const BUSY_MS = 2_000;
const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const required = (value: string, name: string) => { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); };
const timestamp = () => new Date().toISOString();

async function safeDirectory(path: string): Promise<boolean> {
  try { const stat = await lstat(path); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
async function storage(campRoot: string, festivalDir: string, create: boolean) {
  const camp = await realpath(campRoot), festival = resolve(festivalDir);
  const rel = relative(camp, festival);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Festival directory must be inside the camp root");
  const base = join(camp, ".ompfest");
  const teams = join(base, "teams");
  const key = createHash("sha256").update(`${camp}\0${basename(festival)}`).digest("hex");
  const directory = join(teams, key);
  for (const path of [base, teams, directory]) {
    if (await safeDirectory(path)) continue;
    try { await lstat(path); throw new Error("Festival team storage must not be a symlink or non-directory"); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } else return { file: join(directory, "team.json"), lock: join(directory, "team.lock") };
    if (!(await safeDirectory(path))) throw new Error("Festival team storage must not be a symlink or non-directory");
  }
  return { file: join(directory, "team.json"), lock: join(directory, "team.lock") };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validTeam(value: unknown): value is FestivalTeam {
  if (!isRecord(value) || value.version !== 1 || typeof value.festivalId !== "string" || !value.festivalId ||
      (value.coordinatorSessionId !== undefined && typeof value.coordinatorSessionId !== "string") ||
      !Array.isArray(value.participants) || !Array.isArray(value.assignments) || !Array.isArray(value.messages) || value.messages.length > 100) return false;
  const participantIds: string[] = [];
  for (const participant of value.participants as unknown[]) {
    if (!isRecord(participant) || typeof participant.sessionId !== "string" || !participant.sessionId ||
        typeof participant.joinedAt !== "string" || !Number.isFinite(Date.parse(participant.joinedAt)) ||
        (participant.label !== undefined && typeof participant.label !== "string")) return false;
    participantIds.push(participant.sessionId);
  }
  if (new Set(participantIds).size !== participantIds.length) return false;
  const assignmentIds: string[] = [];
  for (const assignment of value.assignments as unknown[]) {
    if (!isRecord(assignment) || typeof assignment.id !== "string" || !assignment.id ||
        typeof assignment.task !== "string" || !assignment.task || typeof assignment.workingDir !== "string" || !assignment.workingDir ||
        typeof assignment.sessionId !== "string" || !assignment.sessionId ||
        !["claimed", "submitted", "accepted", "released"].includes(String(assignment.status)) ||
        typeof assignment.createdAt !== "string" || !Number.isFinite(Date.parse(assignment.createdAt)) ||
        typeof assignment.updatedAt !== "string" || !Number.isFinite(Date.parse(assignment.updatedAt)) ||
        (assignment.label !== undefined && typeof assignment.label !== "string") ||
        (assignment.report !== undefined && typeof assignment.report !== "string") ||
        (assignment.review !== undefined && typeof assignment.review !== "string") ||
        (assignment.reviewSource !== undefined && assignment.reviewSource !== "worker-submission" && assignment.reviewSource !== "coordinator-worktree")) return false;
    assignmentIds.push(assignment.id);
  }
  if (new Set(assignmentIds).size !== assignmentIds.length) return false;
  for (const message of value.messages as unknown[]) {
    if (!isRecord(message) || typeof message.id !== "string" || !message.id ||
        typeof message.fromSession !== "string" || !message.fromSession || typeof message.body !== "string" || !message.body ||
        (message.toSession !== undefined && typeof message.toSession !== "string") ||
        (message.task !== undefined && typeof message.task !== "string") ||
        typeof message.createdAt !== "string" || !Number.isFinite(Date.parse(message.createdAt)) ||
        (message.readAt !== undefined && (typeof message.readAt !== "string" || !Number.isFinite(Date.parse(message.readAt))))) return false;
  }
  return true;
}
async function readFileTeam(file: string): Promise<FestivalTeam | undefined> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Festival team record is corrupt; refusing to overwrite it."); }
  if (!validTeam(parsed)) throw new Error("Festival team record is invalid; refusing to overwrite it.");
  return parsed;
}
interface LockOwner { token: string; pid: number; host: string }
async function readLockOwner(lock: string): Promise<LockOwner | undefined> {
  try {
    const owner: unknown = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
    if (!isRecord(owner) || typeof owner.token !== "string" || !owner.token || typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || typeof owner.host !== "string") return undefined;
    return { token: owner.token, pid: owner.pid, host: owner.host };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}
function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function locked<T>(paths: { file: string; lock: string }, operation: (team: FestivalTeam | undefined) => { team: FestivalTeam; result: T } | Promise<{ team: FestivalTeam; result: T }>): Promise<T> {
  const start = Date.now();
  const token = randomUUID();
  for (;;) {
    let acquired = false;
    try {
      await mkdir(paths.lock, { mode: 0o700 });
      acquired = true;
      await writeFile(join(paths.lock, "owner.json"), JSON.stringify({ token, pid: process.pid, host: hostname() }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      break;
    } catch (error) {
      if (acquired) {
        await rm(paths.lock, { recursive: true, force: true });
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(paths.lock).catch((statError: unknown) => {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw statError;
      });
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Festival team lock is unsafe", { cause: error });
      const owner = await readLockOwner(paths.lock);
      if (owner?.host === hostname() && !processIsAlive(owner.pid)) {
        const stale = `${paths.lock}.stale-${randomUUID()}`;
        try {
          await rename(paths.lock, stale);
          const movedOwner = await readLockOwner(stale);
          if (movedOwner?.token === owner.token && movedOwner.pid === owner.pid && movedOwner.host === owner.host) {
            await rm(stale, { recursive: true, force: true });
          } else {
            try { await rename(stale, paths.lock); } catch (restoreError) {
              if ((restoreError as NodeJS.ErrnoException).code !== "EEXIST") throw restoreError;
            }
          }
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
        }
        continue;
      }
      if (Date.now() - start >= BUSY_MS) throw new Error("Festival team is busy; retry later.", { cause: error });
      await sleep(10);
    }
  }
  try {
    const team = await readFileTeam(paths.file);
    const changed = await operation(team);
    const temp = join(paths.lock, `${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(changed.team, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temp, paths.file);
    return changed.result;
  } finally {
    if ((await readLockOwner(paths.lock))?.token === token) await rm(paths.lock, { recursive: true, force: true });
  }
}
function freshTeam(festivalDir: string, coordinator: string): FestivalTeam {
  return { version: 1, festivalId: basename(resolve(festivalDir)), coordinatorSessionId: coordinator, participants: [], assignments: [], messages: [] };
}
export async function readFestivalTeam(campRoot: string, festivalDir: string): Promise<FestivalTeam | undefined> {
  const paths = await storage(campRoot, festivalDir, false);
  return readFileTeam(paths.file);
}
export async function joinFestivalTeam(campRoot: string, festivalDir: string, sessionId: string, coordinatorSessionId: string, label?: string): Promise<FestivalTeam> {
  required(sessionId, "Session ID"); required(coordinatorSessionId, "Coordinator session ID");
  const paths = await storage(campRoot, festivalDir, true);
  return locked(paths, (existing) => {
    const team = existing ?? freshTeam(festivalDir, coordinatorSessionId);
    team.coordinatorSessionId ??= coordinatorSessionId;
    if (!team.participants.some((participant) => participant.sessionId === sessionId)) {
      team.participants.push({ sessionId, joinedAt: timestamp(), ...(label ? { label } : {}) });
    }
    return { team, result: team };
  });
}
export async function claimFestivalTask(campRoot: string, festivalDir: string, sessionId: string, task: string, workingDir: string, label?: string): Promise<FestivalTeamAssignment> {
  required(sessionId, "Session ID"); required(task, "Task"); required(workingDir, "Working directory");
  const paths = await storage(campRoot, festivalDir, false);
  return locked(paths, (team) => {
    if (!team) throw new Error("Join the festival team before claiming a task.");
    if (!team.participants.some((p) => p.sessionId === sessionId)) throw new Error("Only team members may claim tasks.");
    const active = team.assignments.find((a) => a.task === task && a.status !== "accepted" && a.status !== "released");
    if (active) {
      if (active.sessionId === sessionId && active.workingDir === resolve(workingDir)) return { team, result: active };
      throw new Error("This task already has an active assignment.");
    }
    const now = timestamp(); const assignment: FestivalTeamAssignment = { id: randomUUID(), task, workingDir: resolve(workingDir), sessionId, status: "claimed", createdAt: now, updatedAt: now, ...(label ? { label } : {}) };
    team.assignments.push(assignment); return { team, result: assignment };
  });
}
export async function submitFestivalTask(campRoot: string, festivalDir: string, sessionId: string, assignmentId: string, report: string): Promise<FestivalTeamAssignment> {
  required(report, "Submission evidence"); const paths = await storage(campRoot, festivalDir, false);
  return locked(paths, (team) => {
    if (!team) throw new Error("Festival team not found.");
    const assignment = team.assignments.find((item) => item.id === assignmentId);
    if (!assignment) throw new Error("Festival assignment not found.");
    if (assignment.sessionId !== sessionId) throw new Error("Only the claimant may submit this task.");
    if (assignment.status === "submitted" && assignment.report === report) return { team, result: assignment };
    if (assignment.status !== "claimed") throw new Error("Only claimed assignments may be submitted.");
    assignment.status = "submitted";
    assignment.report = report;
    assignment.updatedAt = timestamp();
    return { team, result: assignment };
  });
}
export async function reviewFestivalTask(campRoot: string, festivalDir: string, coordinatorSessionId: string, assignmentId: string, action: "accept" | "revise", evidence: string): Promise<FestivalTeamAssignment> {
  required(evidence, "Review evidence"); const paths = await storage(campRoot, festivalDir, false);
  return locked(paths, (team) => {
    if (team?.coordinatorSessionId !== coordinatorSessionId) throw new Error("Only the festival coordinator may review tasks.");
    const assignment = team.assignments.find((item) => item.id === assignmentId);
    if (!assignment) throw new Error("Festival assignment not found.");
    if (assignment.status !== "submitted") throw new Error("Only submitted assignments may be reviewed.");
    assignment.review = evidence;
    if (action === "accept") {
      assignment.status = "accepted";
      assignment.reviewSource = "worker-submission";
    } else {
      assignment.status = "claimed";
      assignment.report ??= "";
      assignment.report += `\n\nReview: ${evidence}`;
    }
    assignment.updatedAt = timestamp();
    return { team, result: assignment };
  });
}
export async function acceptFestivalTaskFromCoordinator(campRoot: string, festivalDir: string, coordinatorSessionId: string, assignmentId: string, evidence: string): Promise<FestivalTeamAssignment> {
  required(evidence, "Coordinator review evidence"); const paths = await storage(campRoot, festivalDir, false);
  return locked(paths, (team) => {
    if (team?.coordinatorSessionId !== coordinatorSessionId) throw new Error("Only the festival coordinator may attest to shared-worktree completion.");
    const assignment = team.assignments.find((item) => item.id === assignmentId);
    if (!assignment) throw new Error("Festival assignment not found.");
    if (assignment.status !== "claimed") throw new Error("Coordinator worktree attestation requires a claimed, not worker-submitted, assignment.");
    assignment.status = "accepted";
    assignment.review = evidence;
    assignment.reviewSource = "coordinator-worktree";
    assignment.updatedAt = timestamp();
    return { team, result: assignment };
  });
}
export async function releaseFestivalTask(campRoot: string, festivalDir: string, sessionId: string, assignmentId: string, reason: string): Promise<FestivalTeamAssignment> {
  required(reason, "Release reason"); const paths = await storage(campRoot, festivalDir, false);
  return locked(paths, (team) => {
    if (!team) throw new Error("Festival team not found.");
    const assignment = team.assignments.find((item) => item.id === assignmentId);
    if (!assignment) throw new Error("Festival assignment not found.");
    if (assignment.sessionId !== sessionId && team.coordinatorSessionId !== sessionId) throw new Error("Only the claimant or coordinator may release this task.");
    if (assignment.status === "accepted") throw new Error("Accepted assignments cannot be released.");
    if (assignment.status === "released") return { team, result: assignment };
    assignment.status = "released";
    assignment.updatedAt = timestamp();
    team.messages.push({ id: randomUUID(), fromSession: sessionId, body: `Assignment released: ${reason}`, task: assignment.task, createdAt: timestamp() });
    team.messages = team.messages.slice(-100);
    return { team, result: assignment };
  });
}
export async function sendFestivalTeamMessage(campRoot: string, festivalDir: string, fromSession: string, body: string, toSession?: string, task?: string): Promise<FestivalTeamMessage> {
  required(body, "Message body"); const paths = await storage(campRoot, festivalDir, false);
  return locked(paths, (team) => {
    if (!team) throw new Error("Festival team not found.");
    const senderIsMember = team.participants.some((participant) => participant.sessionId === fromSession);
    if (!senderIsMember && team.coordinatorSessionId !== fromSession) throw new Error("Only team members may send messages.");
    const recipientIsMember = toSession ? team.participants.some((participant) => participant.sessionId === toSession) : false;
    if (toSession && !recipientIsMember && team.coordinatorSessionId !== toSession) throw new Error("Message recipient is not on the team.");
    const message: FestivalTeamMessage = { id: randomUUID(), fromSession, body, createdAt: timestamp(), ...(toSession ? { toSession } : {}), ...(task ? { task } : {}) };
    team.messages.push(message);
    team.messages = team.messages.slice(-100);
    return { team, result: message };
  });
}
export async function readFestivalTeamInbox(campRoot: string, festivalDir: string, sessionId: string, markRead = false): Promise<FestivalTeamMessage[]> {
  const paths = await storage(campRoot, festivalDir, false);
  if (!markRead) {
    const team = await readFileTeam(paths.file);
    if (!team || (team.coordinatorSessionId !== sessionId && !team.participants.some((participant) => participant.sessionId === sessionId))) return [];
    return team.messages.filter((message) => (!message.toSession || message.toSession === sessionId) && message.fromSession !== sessionId);
  }
  return locked(paths, (team) => {
    if (!team) throw new Error("Festival team not found.");
    if (team.coordinatorSessionId !== sessionId && !team.participants.some((participant) => participant.sessionId === sessionId)) throw new Error("Only team members may read the inbox.");
    const now = timestamp();
    const inbox = team.messages.filter((message) => (!message.toSession || message.toSession === sessionId) && message.fromSession !== sessionId);
    for (const message of inbox) message.readAt ??= now;
    return { team, result: inbox };
  });
}
export async function transferFestivalTeamCoordinator(campRoot: string, festivalDir: string, previousCoordinatorSessionId: string, nextCoordinatorSessionId: string): Promise<FestivalTeam> {
  required(previousCoordinatorSessionId, "Previous coordinator session ID");
  required(nextCoordinatorSessionId, "Next coordinator session ID");
  const paths = await storage(campRoot, festivalDir, true);
  return locked(paths, (existing) => {
    if (!existing) {
      const team = freshTeam(festivalDir, nextCoordinatorSessionId);
      team.participants.push({ sessionId: nextCoordinatorSessionId, joinedAt: timestamp() });
      return { team, result: team };
    }
    if (existing.coordinatorSessionId !== previousCoordinatorSessionId) throw new Error("Festival coordinator changed; refusing transfer.");
    if (!existing.participants.some((participant) => participant.sessionId === nextCoordinatorSessionId)) throw new Error("Next coordinator must be a team member.");
    existing.coordinatorSessionId = nextCoordinatorSessionId;
    return { team: existing, result: existing };
  });
}
