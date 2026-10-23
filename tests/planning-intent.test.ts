import { describe, expect, it } from "vitest";
import { classifyPlanningIntent, planningIntentGuidance } from "../src/domain/planning-intent.js";

describe("planning intent", () => {
  it("only treats explicit UI requests as visual references", () => {
    expect(classifyPlanningIntent("rebuild this dashboard screen", true)).toBe("ui_visual");
    expect(classifyPlanningIntent("fix this PDF export", true)).toBe("document_or_pdf");
    expect(classifyPlanningIntent("investigate this error screenshot", true)).toBe("bug_diagnostic");
    expect(classifyPlanningIntent("fix the API response shown here", true)).toBe("backend_or_api");
  });

  it("instructs non-UI image plans not to create wireframes or iframes", () => {
    const guidance = planningIntentGuidance("bug_diagnostic");
    expect(guidance).toContain("Do not call fest_wireframe_create");
    expect(guidance).toContain("iframe");
  });
});
