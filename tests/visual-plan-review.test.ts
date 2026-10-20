import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { recordVisualEvidence, visualEvidenceStatus } from "../src/application/visual-evidence.js";
import { applyReferenceRevision, findReuseCandidates, inspectReferenceRevision, renderPlanPreview } from "../src/application/visual-plan-review.js";
import { installVisualReferences, prepareVisualReferences } from "../src/application/visual-references.js";
import { createVisualFixture, PAGE, SVG, TASK } from "./visual-fixture.js";

describe("reviewing and revising a visual plan", () => {
  it("renders an inert, local wireframe beside escaped page notes, never the original image", async () => {
    const { root, plan, pageDir, referencesDir } = await createVisualFixture();
    await writeFile(join(pageDir, "PAGE.md"), `${PAGE}\n## Open questions\n- <script>alert('hi')</script>\n`);
    const bundle = await prepareVisualReferences(root, plan, referencesDir);
    const preview = await renderPlanPreview(plan, bundle);
    expect(preview.file).toBe(join(root, ".ompfest", "plans", "feature.preview.html"));
    expect(preview.url).toMatch(/^file:\/\//);
    const html = await readFile(preview.file, "utf8");
    expect(html).toContain('id="filters.search"');
    expect(html).toContain("&lt;script&gt;alert(&#39;hi&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("default-src 'none'");
    expect(await readdir(referencesDir)).toEqual(["pages"]);
    await expect(renderPlanPreview(plan, { pages: ["results"], files: [{ path: "pages/results/wireframe.svg", content: "<svg><script>bad</script></svg>" }] }))
      .rejects.toThrow("unsupported element");
  });

  it("discovers project-local reuse candidates without following links or editing code", async () => {
    const { root, plan, referencesDir } = await createVisualFixture();
    const project = join(root, "projects", "web");
    await mkdir(join(project, "src", "components"), { recursive: true });
    await mkdir(join(project, "node_modules", "x"), { recursive: true });
    await writeFile(join(project, "src", "components", "SearchInput.tsx"), "export const SearchInput = () => null;");
    await writeFile(join(project, "src", "components", "Layout.tsx"), "export const Layout = () => null;");
    await writeFile(join(project, "node_modules", "x", "SearchFake.tsx"), "do not use");
    await symlink(join(root, "outside"), join(project, "src", "components", "linked.tsx"));
    const bundle = await prepareVisualReferences(root, plan, referencesDir);
    const candidates = await findReuseCandidates(root, "projects/web", bundle);
    expect(candidates).toEqual(["projects/web/src/components/SearchInput.tsx", "projects/web/src/components/Layout.tsx"]);
    expect(await readFile(join(project, "src", "components", "SearchInput.tsx"), "utf8")).toContain("export const");
    expect(await findReuseCandidates(root, "../outside", bundle)).toEqual([]);
  });

  it("previews affected acceptance checks and tasks, then requires unchanged base and proposal before applying", async () => {
    const { root, referencesDir, pageDir, plan, festival, taskPath, markDone } = await createVisualFixture();
    const original = await prepareVisualReferences(root, plan, referencesDir);
    await installVisualReferences(festival, original);
    await markDone();
    const detect = new CampFsDetect();
    await recordVisualEvidence(festival, taskPath, TASK, [{
      page: "results", check: "AC-01", status: "verified", proof: "Test run passed",
      route: "/results", viewport: "1280x800", state: "initial",
    }]);
    await writeFile(join(pageDir, "wireframe.svg"), SVG.replace("Search</text>", "Find</text>"));
    const revised = await prepareVisualReferences(root, plan, referencesDir);
    const impact = await inspectReferenceRevision(festival, revised, detect);
    expect(impact.changedPages).toEqual(["results"]);
    expect(impact.affectedChecks).toEqual([{ page: "results", ids: ["AC-01"] }]);
    expect(impact.affectedTasks[0]).toMatchObject({ path: taskPath, done: true, pages: ["results"], checks: ["results/AC-01"] });
    expect(impact.affectedTasks[0]?.followUp).toContain("Reverify");
    await expect(applyReferenceRevision(festival, revised, detect, "wrong-base", impact.proposalRevision))
      .rejects.toThrow("Review the new impact");
    expect(await readFile(join(festival, "references", "pages", "results", "wireframe.svg"), "utf8")).toBe(SVG);
    await applyReferenceRevision(festival, revised, detect, impact.baseRevision, impact.proposalRevision);
    expect((await visualEvidenceStatus(festival, detect)).issues.join("\n")).toContain("Stale evidence");
    expect((await detect.pendingTasks(festival))[0]?.done).toBe(true);
    await expect(applyReferenceRevision(festival, revised, detect, impact.baseRevision, impact.proposalRevision))
      .rejects.toThrow("Review the new impact");
    expect((await readdir(join(festival, "references", "pages", "results"))).sort()).toEqual(["PAGE.md", "wireframe.svg"]);
  });

  it("rejects removing an approved page while an existing task still links it", async () => {
    const { root, referencesDir, plan, festival } = await createVisualFixture();
    await installVisualReferences(festival, await prepareVisualReferences(root, plan, referencesDir));
    const empty = { pages: [], files: [] };
    const impact = await inspectReferenceRevision(festival, empty, new CampFsDetect());
    await expect(applyReferenceRevision(festival, empty, new CampFsDetect(), impact.baseRevision, impact.proposalRevision))
      .rejects.toThrow("still linked by a task");
  });

  it("rejects unexpected reference paths before staging a revision", async () => {
    const { root, referencesDir, plan, festival } = await createVisualFixture();
    const bundle = await prepareVisualReferences(root, plan, referencesDir);
    await installVisualReferences(festival, bundle);
    const unexpected = { pages: bundle.pages, files: [...bundle.files, { path: "pages/../../unrelated", content: "tamper" }] };
    const impact = await inspectReferenceRevision(festival, unexpected, new CampFsDetect());
    await expect(applyReferenceRevision(festival, unexpected, new CampFsDetect(), impact.baseRevision, impact.proposalRevision))
      .rejects.toThrow("exactly PAGE.md and wireframe.svg");
    expect((await readdir(join(festival, "references"))).sort()).toEqual(["pages"]);
  });

  it("refuses to preview a symlinked output or read a symlinked installed page", async () => {
    const { root, plan, referencesDir, festival } = await createVisualFixture();
    const bundle = await prepareVisualReferences(root, plan, referencesDir);
    await symlink(join(root, "outside.html"), plan.replace(/\.STRUCTURE\.md$/, ".preview.html"));
    await expect(renderPlanPreview(plan, bundle)).rejects.toThrow("not a symlink");
    await installVisualReferences(festival, bundle);
    const page = join(festival, "references", "pages", "results", "wireframe.svg");
    await rm(page);
    await symlink(join(root, "outside.svg"), page);
    await expect(inspectReferenceRevision(festival, bundle, new CampFsDetect())).rejects.toThrow("regular file");
  });
});
