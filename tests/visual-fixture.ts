import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";

export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100"><rect x="4" y="4" width="300" height="80" fill="none" stroke="black"/><text id="filters.search" x="8" y="22">Search</text></svg>';
export const TASK = "---\nfest_type: task\n---\n# UI\nVisual reference: references/pages/results/PAGE.md\n- [ ] Acceptance: results/AC-01 — filters.search works in RTL";
export const PAGE = `# Results
## Components
- \`filters.search\` — search input
## States
| Viewport | State | Status | Expected |
| --- | --- | --- | --- |
| desktop | initial | observed | Search is visible |
| mobile | initial | unknown | Ask about layout |
| desktop | loading | unknown | Ask about spinner |
| desktop | empty | unknown | Ask about empty state |
| desktop | error | unknown | Ask about error state |
## Acceptance checks
- [AC-01] Search works in RTL
`;

export async function createVisualFixture() {
  const root = await mkdtemp(join(tmpdir(), "visual-plan-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const plans = join(root, ".ompfest", "plans");
  const referencesDir = join(plans, "feature.references");
  const pageDir = join(referencesDir, "pages", "results");
  const plan = join(plans, "feature.STRUCTURE.md");
  const festival = join(root, "festivals", "planning", "feature");
  const taskPath = "001_BUILD/01_ui/01_results.md";
  const task = join(festival, taskPath);
  await mkdir(pageDir, { recursive: true });
  await mkdir(join(festival, "001_BUILD", "01_ui"), { recursive: true });
  await mkdir(join(festival, ".fest"));
  await mkdir(join(root, "projects"));
  await writeFile(plan, "# Festival Structure");
  await writeFile(join(festival, "fest.yaml"), "id: feature\n");
  await writeFile(join(pageDir, "PAGE.md"), PAGE);
  await writeFile(join(pageDir, "wireframe.svg"), SVG);
  await writeFile(task, TASK);
  async function markDone(paths: string[] = [taskPath]) {
    await writeFile(join(festival, ".fest", "progress_events.jsonl"), paths
      .map((path) => JSON.stringify({ ts: "2026-10-20T00:00:00Z", event: "completed", task: path })).join("\n"));
  }
  return { root, referencesDir, pageDir, plan, festival, task, taskPath, markDone };
}
