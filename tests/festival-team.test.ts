import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimFestivalTask, joinFestivalTeam, readFestivalTeam, readFestivalTeamInbox, releaseFestivalTask, reviewFestivalTask, sendFestivalTeamMessage, submitFestivalTask, transferFestivalTeamCoordinator } from "../src/application/festival-team.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "festival-team-")); roots.push(root);
  const festival = join(root, "festivals", "demo-F1"); await mkdir(festival, { recursive: true });
  return { root, festival };
}

describe("festival team store", () => {
  it("initializes only on join, keeps the first coordinator, and is visible across store calls", async () => {
    const { root, festival } = await fixture();
    expect(await readFestivalTeam(root, festival)).toBeUndefined();
    await joinFestivalTeam(root, festival, "owner", "owner");
    await joinFestivalTeam(root, festival, "worker", "different-owner", "Worker");
    const team = await readFestivalTeam(root, festival);
    expect(team?.coordinatorSessionId).toBe("owner");
    expect(team?.participants.map((p) => p.sessionId)).toEqual(["owner", "worker"]);
  });

  it("serializes concurrent claims for the same task across sessions", async () => {
    const { root, festival } = await fixture();
    await joinFestivalTeam(root, festival, "owner", "owner");
    await joinFestivalTeam(root, festival, "a", "owner");
    await joinFestivalTeam(root, festival, "b", "owner");
    const results = await Promise.allSettled([
      claimFestivalTask(root, festival, "a", "task-1", festival),
      claimFestivalTask(root, festival, "b", "task-1", festival),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await readFestivalTeam(root, festival))?.assignments).toHaveLength(1);
  });
  it("keeps team state attached to the festival when its status directory changes", async () => {
    const { root, festival } = await fixture();
    await joinFestivalTeam(root, festival, "owner", "owner");
    await joinFestivalTeam(root, festival, "worker", "owner");
    const moved = join(root, "festivals", "ready", basename(festival));
    await mkdir(join(root, "festivals", "ready"), { recursive: true });
    await rename(festival, moved);
    expect(await readFestivalTeam(root, moved)).toMatchObject({
      coordinatorSessionId: "owner",
      participants: [{ sessionId: "owner" }, { sessionId: "worker" }],
    });
  });
  it("recovers a crashed lock only after verifying its owner token and dead process", async () => {
    const { root, festival } = await fixture();
    await joinFestivalTeam(root, festival, "owner", "owner");
    const key = createHash("sha256").update(`${await realpath(root)}\0${basename(festival)}`).digest("hex");
    const lock = join(root, ".ompfest", "teams", key, "team.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "crashed-owner", pid: 2147483647, host: hostname() }));
    const stale = new Date(Date.now() - 60_000);
    await utimes(lock, stale, stale);
    await joinFestivalTeam(root, festival, "recovered-session", "owner");
    expect((await readFestivalTeam(root, festival))?.participants.map((row) => row.sessionId)).toContain("recovered-session");
  });

  it("does not reclaim an old lock while its owning process is alive", async () => {
    const { root, festival } = await fixture();
    await joinFestivalTeam(root, festival, "owner", "owner");
    const key = createHash("sha256").update(`${await realpath(root)}\0${basename(festival)}`).digest("hex");
    const lock = join(root, ".ompfest", "teams", key, "team.lock");
    await mkdir(lock);
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "live-owner", pid: process.pid, host: hostname() }));
    const stale = new Date(Date.now() - 60_000);
    await utimes(lock, stale, stale);
    await expect(joinFestivalTeam(root, festival, "waiting-session", "owner")).rejects.toThrow("busy");
    expect(await readFile(join(lock, "owner.json"), "utf8")).toContain("live-owner");
  });

  it("makes claim, submission, and release retries idempotent and permits redispatch after release", async () => {
    const { root, festival } = await fixture();
    await joinFestivalTeam(root, festival, "owner", "owner");
    const claimed = await claimFestivalTask(root, festival, "owner", "retryable-task", festival);
    expect(await claimFestivalTask(root, festival, "owner", "retryable-task", festival)).toEqual(claimed);
    const submitted = await submitFestivalTask(root, festival, "owner", claimed.id, "proof");
    expect(await submitFestivalTask(root, festival, "owner", claimed.id, "proof")).toEqual(submitted);
    const released = await releaseFestivalTask(root, festival, "owner", claimed.id, "retry");
    expect(released.status).toBe("released");
    expect(await releaseFestivalTask(root, festival, "owner", claimed.id, "retry")).toEqual(released);
    const redispatched = await claimFestivalTask(root, festival, "owner", "retryable-task", festival);
    expect(redispatched.id).not.toBe(claimed.id);
  });

  it("preserves concurrent participant joins, claims, and messages", async () => {
    const { root, festival } = await fixture();
    await joinFestivalTeam(root, festival, "owner", "owner");
    const sessions = Array.from({ length: 12 }, (_, index) => `worker-${index}`);
    await Promise.all(sessions.map((session) => joinFestivalTeam(root, festival, session, "owner")));
    await Promise.all(sessions.flatMap((session, index) => [
      claimFestivalTask(root, festival, session, `task-${index}`, festival),
      sendFestivalTeamMessage(root, festival, session, `message-${index}`),
    ]));
    const team = await readFestivalTeam(root, festival);
    expect(team?.participants).toHaveLength(13);
    expect(team?.assignments.map((assignment) => assignment.task).sort()).toEqual(sessions.map((_, index) => `task-${index}`).sort());
    expect(team?.messages.map((message) => message.body).sort()).toEqual(sessions.map((_, index) => `message-${index}`).sort());
  });

  it("enforces claimant and coordinator permissions and submission/review transitions", async () => {
    const { root, festival } = await fixture();
    await joinFestivalTeam(root, festival, "owner", "owner"); await joinFestivalTeam(root, festival, "worker", "owner");
    await expect(claimFestivalTask(root, festival, "outsider", "task", festival)).rejects.toThrow("team members");
    const assignment = await claimFestivalTask(root, festival, "worker", "task", festival);
    await expect(submitFestivalTask(root, festival, "owner", assignment.id, "proof")).rejects.toThrow("claimant");
    await expect(submitFestivalTask(root, festival, "worker", assignment.id, "  ")).rejects.toThrow("required");
    const submitted = await submitFestivalTask(root, festival, "worker", assignment.id, "Tests passed");
    expect(submitted.status).toBe("submitted");
    await expect(reviewFestivalTask(root, festival, "worker", assignment.id, "accept", "Reviewed")).rejects.toThrow("coordinator");
    const revised = await reviewFestivalTask(root, festival, "owner", assignment.id, "revise", "Add browser evidence");
    expect(revised).toMatchObject({ status: "claimed", review: "Add browser evidence", report: "Tests passed\n\nReview: Add browser evidence" });
    await submitFestivalTask(root, festival, "worker", assignment.id, "Browser evidence added");
    expect((await reviewFestivalTask(root, festival, "owner", assignment.id, "accept", "Accepted evidence")).status).toBe("accepted");
  });

  it("delivers inbox messages and marks read when requested", async () => {
    const { root, festival } = await fixture();
    await joinFestivalTeam(root, festival, "owner", "owner"); await joinFestivalTeam(root, festival, "worker", "owner");
    await sendFestivalTeamMessage(root, festival, "owner", "Please review", "worker", "task-1");
    expect(await readFestivalTeamInbox(root, festival, "worker")).toMatchObject([{ body: "Please review", toSession: "worker", task: "task-1" }]);
    expect((await readFestivalTeamInbox(root, festival, "worker", true))[0]?.readAt).toBeTruthy();
  });

  it("refuses to overwrite corrupt JSON", async () => {
    const { root, festival } = await fixture(); await joinFestivalTeam(root, festival, "owner", "owner");
    const path = join(root, ".ompfest", "teams");
    const [key] = await readdir(path); const record = join(path, key!, "team.json");
    await writeFile(record, "{");
    await expect(joinFestivalTeam(root, festival, "worker", "owner")).rejects.toThrow("corrupt");
    await expect(readFestivalTeam(root, festival)).rejects.toThrow("corrupt");
    expect(await readFile(record, "utf8")).toBe("{");
  });

  it("transfers coordinator only with the expected owner and an existing member", async () => {
    const { root, festival } = await fixture();
    await joinFestivalTeam(root, festival, "owner", "owner");
    await joinFestivalTeam(root, festival, "worker", "owner");
    await expect(transferFestivalTeamCoordinator(root, festival, "stale-owner", "worker")).rejects.toThrow("changed");
    await expect(transferFestivalTeamCoordinator(root, festival, "owner", "outsider")).rejects.toThrow("member");
    expect((await transferFestivalTeamCoordinator(root, festival, "owner", "worker")).coordinatorSessionId).toBe("worker");
  });

  it("creates missing team state for the explicitly supplied transfer target", async () => {
    const { root, festival } = await fixture();
    const team = await transferFestivalTeamCoordinator(root, festival, "old-owner", "next-owner");
    expect(team).toMatchObject({ coordinatorSessionId: "next-owner", participants: [{ sessionId: "next-owner" }] });
  });
});
