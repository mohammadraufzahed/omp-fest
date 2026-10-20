import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { installVisualReferences, linkedPages, prepareVisualReferences, referencesForTask, validateVisualReferences } from "../src/application/visual-references.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 100"><rect x="4" y="4" width="300" height="80" fill="none" stroke="black"/><text x="8" y="22">Search</text></svg>';
const TASK = "---\nfest_type: task\n---\n# UI\nVisual reference: references/pages/results/PAGE.md\n- [ ] filters.search works in RTL";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "visual-plan-"));
  const plans = join(root, ".ompfest", "plans");
  const referencesDir = join(plans, "feature.references");
  const pageDir = join(referencesDir, "pages", "results");
  const plan = join(plans, "feature.STRUCTURE.md");
  const festival = join(root, "festivals", "planning", "feature");
  const sequence = join(festival, "001_BUILD", "01_ui");
  await mkdir(pageDir, { recursive: true });
  await mkdir(sequence, { recursive: true });
  await writeFile(plan, "# Festival Structure");
  await writeFile(join(pageDir, "PAGE.md"), "# Results\n\nfilters.search; RTL; loading/empty/error states; Done When: search works");
  await writeFile(join(pageDir, "wireframe.svg"), SVG);
  await writeFile(join(sequence, "01_results.md"), TASK);
  return { root, referencesDir, pageDir, plan, festival, task: join(sequence, "01_results.md") };
}

describe("visual planning references", () => {
  it("installs a reviewed page bundle and resolves task references", async () => {
    const { root, referencesDir, plan, festival } = await fixture();
    const bundle = await prepareVisualReferences(root, plan, referencesDir);
    expect(bundle.pages).toEqual(["results"]);
    await installVisualReferences(festival, bundle);
    const [page] = await referencesForTask(festival, TASK);
    expect(page?.content).toContain("filters.search");
    expect(page?.wireframe).toBe(join(festival, "references", "pages", "results", "wireframe.svg"));
    expect((await validateVisualReferences(festival, new CampFsDetect())).issues).toEqual([]);
    expect(linkedPages(`${TASK}\n${TASK}`)).toEqual(["results"]);
    expect(await readFile(page!.spec, "utf8")).toContain("loading/empty/error");
  });

  it("rejects source paths outside the matching planning directory", async () => {
    const { root, referencesDir, plan } = await fixture();
    await expect(prepareVisualReferences(root, plan, root)).rejects.toThrow("referencesDir");
    await expect(prepareVisualReferences(root, join(root, "other.STRUCTURE.md"), referencesDir)).rejects.toThrow("Visual plans");
  });

  it("rejects unsafe SVG, extraneous raw images and symlink escapes before scaffold", async () => {
    const { root, referencesDir, pageDir, plan } = await fixture();
    await writeFile(join(pageDir, "wireframe.svg"), '<svg onload="alert(1)"><rect/></svg>');
    await expect(prepareVisualReferences(root, plan, referencesDir)).rejects.toThrow("unsupported attribute");
    await writeFile(join(pageDir, "wireframe.svg"), '<svg><image href="https://example.org/secret"/></svg>');
    await expect(prepareVisualReferences(root, plan, referencesDir)).rejects.toThrow("unsupported element");
    await writeFile(join(pageDir, "wireframe.svg"), SVG);
    await writeFile(join(pageDir, "screenshot.png"), "raw image");
    await expect(prepareVisualReferences(root, plan, referencesDir)).rejects.toThrow("exactly PAGE.md");
  });

  it("refuses symlinked page artifacts", async () => {
    const { root, referencesDir, pageDir, plan } = await fixture();
    await rm(join(pageDir, "PAGE.md"));
    await symlink(join(root, "other.STRUCTURE.md"), join(pageDir, "PAGE.md"));
    await expect(prepareVisualReferences(root, plan, referencesDir)).rejects.toThrow("regular file");
  });

  it("flags broken and unlinked task references after scaffold", async () => {
    const { root, referencesDir, plan, festival, task } = await fixture();
    await installVisualReferences(festival, await prepareVisualReferences(root, plan, referencesDir));
    await writeFile(task, "# UI\nNo visual reference yet");
    expect((await validateVisualReferences(festival, new CampFsDetect())).issues).toContain("Page results is not linked by any task document");
    await writeFile(task, TASK.replace("results/PAGE.md", "other/PAGE.md"));
    expect((await validateVisualReferences(festival, new CampFsDetect())).issues).toContain("Task links missing visual reference: references/pages/other/PAGE.md");
  });

  it("detects unsafe edits and path traversal links during validation", async () => {
    const { root, referencesDir, plan, festival, task } = await fixture();
    await installVisualReferences(festival, await prepareVisualReferences(root, plan, referencesDir));
    await writeFile(join(festival, "references", "pages", "results", "wireframe.svg"), '<svg><script>bad</script></svg>');
    expect((await validateVisualReferences(festival, new CampFsDetect())).issues.join("\n")).toContain("unsupported element: script");
    await writeFile(task, "Visual reference: references/pages/../../outside/PAGE.md");
    expect((await validateVisualReferences(festival, new CampFsDetect())).issues.join("\n")).toContain("Invalid visual reference");
  });

  it("does not require visual pages in text-only festivals with ordinary references", async () => {
    const { festival, task } = await fixture();
    await mkdir(join(festival, "references"));
    await writeFile(task, "# Backend task");
    expect((await validateVisualReferences(festival, new CampFsDetect())).issues).toEqual([]);
    expect(await referencesForTask(festival, "# Backend task")).toEqual([]);
  });
});
