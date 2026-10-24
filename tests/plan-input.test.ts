import { describe, expect, it } from "vitest";
import { planningDiagnostic } from "../src/application/planning-errors.js";
import { normalizePlanInput } from "../src/application/plan-input.js";
import type { StructuredPlan } from "../src/application/structured-plan.js";

describe("plan input normalization", () => {
  it("normalizes absolute project paths and unstable ids without inventing files", () => {
    const project = "/camp/projects/client";
    const input: StructuredPlan = {
      goal: "Fix sidebar overflow",
      scope: ["Sidebar layout"],
      exclusions: [],
      acceptance: [{ id: "bad id", description: "Sidebar remains usable" }],
      questions: [],
      inspection: [{ path: `${project}/src/Layout.tsx`, reason: "Existing shell" }],
      phases: [{ id: "01_IMPLEMENT", name: "Implement", type: "implementation", sequences: [{
        id: "01_ui", name: "UI", tasks: [{
          id: "01 fix sidebar", title: "Fix sidebar", description: "Fix overflow", dependsOn: [],
          implements: ["bad id"], verifies: ["bad id"],
          files: [{ path: `${project}/src/Layout.tsx`, status: "existing" }],
          verification: [{ command: "npm test", cwd: project, evidencePath: `${project}/package.json`, expected: "passes" }],
        }],
      }] }],
    };
    const result = normalizePlanInput(input, project);
    expect(result.spec.acceptance[0]?.id).toBe("ac-1");
    expect(result.spec.phases[0]?.id).toBe("step-01-implement");
    expect(result.spec.phases[0]?.sequences[0]?.tasks[0]?.id).toBe("step-01-fix-sidebar");
    expect(result.spec.inspection[0]?.path).toBe("src/Layout.tsx");
    expect(result.spec.phases[0]?.sequences[0]?.tasks[0]?.verification[0]?.cwd).toBe(".");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects incomplete runtime input with one concise diagnostic", () => {
    expect(() => normalizePlanInput({ phases: [] } as unknown as StructuredPlan, "/project")).toThrow(
      "Plan input must be a complete structured plan with valid phase, sequence, and task arrays",
    );
  });

  it("normalizes common path and verification failures to stable concise diagnostics", () => {
    const pathError = planningDiagnostic(new Error("Inspection path does not exist: /private/work/project/missing.ts"));
    expect(pathError).toMatchObject({ code: "PATH_NOT_FOUND", message: "A required project path does not exist." });
    expect(pathError.message).not.toContain("/private");
    const verification = planningDiagnostic(new Error("Verification evidencePath is missing and cannot be inferred from command"));
    expect(verification.code).toBe("INVALID_VERIFICATION");
    expect(verification.message).toBe("Verification command or evidence is invalid.");
  });
});
