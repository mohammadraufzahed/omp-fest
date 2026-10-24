import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimFestivalTask, joinFestivalTeam, readFestivalTeam, releaseFestivalTask, reviewFestivalTask, submitFestivalTask } from "../src/application/festival-team.js";
import { readPortfolioState, releasePortfolioAssignment, reservePortfolioAssignment, setPortfolioWorkerLimit, updatePortfolioAssignment } from "../src/application/portfolio-state.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "team-portfolio-")); roots.push(root);
  const festival = join(root, "festivals", "demo-F1"); await mkdir(festival, { recursive: true });
  await joinFestivalTeam(root, festival, "owner", "owner");
  await joinFestivalTeam(root, festival, "collaborator", "owner");
  return { root, festival };
}
async function claim(root: string, festival: string, sid: string, task: string) {
  const assignment = await claimFestivalTask(root, festival, sid, task, join(root, "project"), sid);
  await reservePortfolioAssignment(root, { id: assignment.id, festival: "demo-F1", task, sessionId: sid, worker: sid, workingDir: assignment.workingDir, files: [`${task}.ts`] });
  return assignment;
}

describe("team assignments in the durable portfolio ledger", () => {
  it("enforces the hard global limit and rolls back a team claim when reservation fails", async () => {
    const { root, festival } = await fixture();
    await setPortfolioWorkerLimit(root, 1);
    const first = await claim(root, festival, "owner", "one.md");
    const second = await claimFestivalTask(root, festival, "collaborator", "two.md", join(root, "project"));
    await expect(reservePortfolioAssignment(root, { id: second.id, festival: "demo-F1", task: second.task, sessionId: second.sessionId, worker: second.sessionId, workingDir: second.workingDir, files: ["two.ts"] })).rejects.toThrow("Portfolio worker limit reached");
    await releaseFestivalTask(root, festival, "collaborator", second.id, "Portfolio limit reached.");
    expect((await readFestivalTeam(root, festival))?.assignments.map((item) => [item.id, item.status])).toEqual([[first.id, "claimed"], [second.id, "released"]]);
    expect((await readPortfolioState(root)).assignments.map((item) => item.id)).toEqual([first.id]);
  });

  it("persists submit, revise-to-running, acceptance, and release lifecycle states", async () => {
    const { root, festival } = await fixture();
    const revised = await claim(root, festival, "collaborator", "revise.md");
    await submitFestivalTask(root, festival, "collaborator", revised.id, "verified output");
    await updatePortfolioAssignment(root, revised.id, "submitted", { report: "verified output" });
    await expect(reviewFestivalTask(root, festival, "collaborator", revised.id, "revise", "coordinator-only review")).rejects.toThrow("Only the festival coordinator");
    await reviewFestivalTask(root, festival, "owner", revised.id, "revise", "change requested");
    await updatePortfolioAssignment(root, revised.id, "running", { report: "change requested" });
    expect((await readPortfolioState(root)).assignments.find((item) => item.id === revised.id)?.status).toBe("running");
    await submitFestivalTask(root, festival, "collaborator", revised.id, "updated and verified");
    await updatePortfolioAssignment(root, revised.id, "submitted", { report: "updated and verified" });
    await reviewFestivalTask(root, festival, "owner", revised.id, "accept", "accepted");
    await updatePortfolioAssignment(root, revised.id, "accepted", { report: "accepted" });
    expect((await readPortfolioState(root)).assignments.find((item) => item.id === revised.id)?.status).toBe("accepted");

    const released = await claim(root, festival, "owner", "release.md");
    await releaseFestivalTask(root, festival, "owner", released.id, "not needed");
    await releasePortfolioAssignment(root, released.id, "not needed");
    expect((await readPortfolioState(root)).assignments.find((item) => item.id === released.id)?.status).toBe("released");
  });
});
