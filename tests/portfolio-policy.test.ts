import { describe, expect, it } from "vitest";
import { SUPERVISOR_POLICY } from "../src/application/supervisor.js";

describe("portfolio supervisor policy", () => {
  it("makes explicit-ownership portfolio coordination the default without implicit transfers", () => {
    expect(SUPERVISOR_POLICY).toMatch(/portfolio supervisor mode is the default/i);
    expect(SUPERVISOR_POLICY).toMatch(/across every festival it explicitly owns/i);
    expect(SUPERVISOR_POLICY).toMatch(/never implicitly select, claim, join, transfer or assume ownership/i);
  });

  it("uses native workers and fairly caps safe concurrent task assignments", () => {
    expect(SUPERVISOR_POLICY).toMatch(/native parallel\/subagent tools/i);
    expect(SUPERVISOR_POLICY).toMatch(/fair dependency-eligible candidate set across owned festivals/i);
    expect(SUPERVISOR_POLICY).toMatch(/portfolio limit \(20 by default, never above 20\)/i);
  });
  it("starts native portfolio dispatch in the activation turn only after authorization", () => {
    expect(SUPERVISOR_POLICY).toMatch(/after human-authorized activation\/promotion reaches active/i);
    expect(SUPERVISOR_POLICY).toMatch(/immediately call fest_supervisor with action=portfolio/i);
    expect(SUPERVISOR_POLICY).toMatch(/same agent turn/i);
    expect(SUPERVISOR_POLICY).toMatch(/do not end the turn after activation/i);
    expect(SUPERVISOR_POLICY).toMatch(/if no native agent capability is exposed, report a blocker and do not fabricate launch/i);
  });

  it("limits activation dispatch to owned festivals, not joined-only collaborator claims", () => {
    expect(SUPERVISOR_POLICY).toMatch(/main agent dispatches only festivals owned by this session/i);
    expect(SUPERVISOR_POLICY).toMatch(/joined-only festivals remain collaborator task claims through fest_team/i);
  });


  it("isolates task failures and limits file locks to native writes", () => {
    expect(SUPERVISOR_POLICY).toMatch(/failure, cancellation, pause or blocker is local to its festival\/task/i);
    expect(SUPERVISOR_POLICY).toMatch(/never cancel, discard or block unrelated festival plans or assignments/i);
    expect(SUPERVISOR_POLICY).toMatch(/exact-file locks are held only while a native write\/edit call is executing/i);
  });

  it("keeps workers scoped and main-agent integration and acceptance responsibilities", () => {
    expect(SUPERVISOR_POLICY).toMatch(/keep assignment and execution task-scoped/i);
    expect(SUPERVISOR_POLICY).toMatch(/compact report of changed files, evidence, failures and blockers/i);
    expect(SUPERVISOR_POLICY).toMatch(/integration, review, task completion, gates and commits under the main agent's responsibility/i);
  });

  it("does not claim that the extension itself launches agents", () => {
    expect(SUPERVISOR_POLICY).toMatch(/the extension requests native tools and does not itself launch agents/i);
  });
});
