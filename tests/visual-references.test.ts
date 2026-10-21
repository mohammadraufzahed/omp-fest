import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CampFsDetect } from "../src/adapters/fs/camp-fs.js";
import { installVisualReferences, linkedPages, prepareVisualReferences, referencesForTask, taskChecks, validateVisualReferences } from "../src/application/visual-references.js";
import { createVisualFixture as fixture, PAGE, SVG, TASK } from "./visual-fixture.js";

describe("visual planning references", () => {
  it.each([
    ["duplicate acceptance IDs", `${PAGE}- [AC-01] Duplicate\n`, SVG, "unique"],
    ["invalid acceptance IDs", PAGE.replace("[AC-01]", "[AC-search]"), SVG, "unique"],
    ["missing mobile state", PAGE.replace("| mobile | initial | unknown | Ask about layout |\n", ""), SVG, "Document mobile"],
    ["missing loading state", PAGE.replace("| desktop | loading | unknown | Ask about spinner |\n", ""), SVG, "Document mobile"],
    ["implicit states", PAGE.replace("| unknown |", "| inferred |"), SVG, "Document mobile"],
    ["mismatched component", PAGE.replace("filters.search", "filters.other"), SVG, "matching component"],
    ["undocumented SVG ID", PAGE, SVG.replace("<rect ", '<rect id="extra" '), "not documented"],
    ["duplicate SVG ID", PAGE, SVG.replace("<rect ", '<rect id="filters.search" '), "duplicate component"],
    ["duplicate attribute", PAGE, SVG.replace('id="filters.search"', 'id="filters.search" id="wrong"'), "duplicate attribute"],
  ])("rejects %s", async (_label, spec, svg, reason) => {
    const { root, referencesDir, pageDir, plan } = await fixture();
    await writeFile(join(pageDir, "PAGE.md"), spec);
    await writeFile(join(pageDir, "wireframe.svg"), svg);
    await expect(prepareVisualReferences(root, plan, referencesDir)).rejects.toThrow(reason);
  });
  it("accepts large page collections without imposing a small category or page-count ceiling", async () => {
    const { root, referencesDir, plan } = await fixture();
    const pagesDir = join(referencesDir, "pages");
    for (let index = 1; index <= 40; index++) {
      const slug = `section-${String(index).padStart(2, "0")}`;
      const pageDir = join(pagesDir, slug);
      await mkdir(pageDir);
      await writeFile(join(pageDir, "PAGE.md"), PAGE);
      await writeFile(join(pageDir, "wireframe.svg"), SVG);
    }
    const bundle = await prepareVisualReferences(root, plan, referencesDir);
    expect(bundle.pages).toHaveLength(41);
  });

  it("requires task coverage for each AC and rejects unknown or malformed Done-When IDs", async () => {
    const { root, referencesDir, plan, festival, task } = await fixture();
    await installVisualReferences(festival, await prepareVisualReferences(root, plan, referencesDir));
    await writeFile(task, TASK.replace("AC-01", "AC-99"));
    const invalid = (await validateVisualReferences(festival, new CampFsDetect())).issues.join("\n");
    expect(invalid).toContain("results/AC-01 has no linked task Done-When");
    expect(invalid).toContain("Unknown acceptance check results/AC-99");
    await writeFile(task, TASK.replace("results/AC-01", "results/AC-01/extra"));
    expect((await validateVisualReferences(festival, new CampFsDetect())).issues.join("\n")).toContain("Invalid or duplicate acceptance marker");
    await writeFile(task, TASK.replace(" — filters.search works in RTL", ""));
    expect((await validateVisualReferences(festival, new CampFsDetect())).issues.join("\n")).toContain("Invalid or duplicate acceptance marker");
    await writeFile(task, TASK.replace("[ ]", "[x]"));
    expect(taskChecks(await readFile(task, "utf8"))).toEqual([{ page: "results", id: "AC-01" }]);
    expect((await validateVisualReferences(festival, new CampFsDetect())).issues).toEqual([]);
  });

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
    expect(await readFile(page!.spec, "utf8")).toContain("| desktop | loading | unknown |");
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
