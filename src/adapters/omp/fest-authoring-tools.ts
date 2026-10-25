import { isAbsolute, relative } from "node:path";
import { readFile } from "node:fs/promises";
import { containedPath, nativeName, nativeResult, nativeTool, owningMain, required, selectedFestival } from "./fest-native-context.js";
import type { PiLike, ToolDeps } from "./tools.js";

interface AuthoringParams {
  action: "templates_list" | "template_create" | "template_apply" | "types_list" | "types_show" | "config_list" | "config_show" | "markers_scaffold" | "markers_validate" | "markers_discover" | "markers_fill";
  festival?: string; name?: string; fromFile?: string; output?: string; variables?: { name: string; value: string }[];
  level?: "festival" | "phase" | "sequence" | "task"; template?: string; file?: string; source?: string; batchFile?: string; strict?: boolean; preview?: boolean;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
export function registerAuthoringTools(pi: PiLike, deps: ToolDeps): void {
  const z = pi.zod;
  nativeTool<AuthoringParams>(pi, "fest_authoring",
    "Native template create/apply/list, types and active config discovery, marker scaffold/validate/discover/fill. Festival-relative files only. Fill uses an existing native wizard discovery JSON with explicit nonempty values; inspect markers_discover first, author the batch file, then preview/apply. Config is read-only: this never enables judge hooks. Templates and marker writes require owning main authority.",
    z.object({ action: z.enum(["templates_list", "template_create", "template_apply", "types_list", "types_show", "config_list", "config_show", "markers_scaffold", "markers_validate", "markers_discover", "markers_fill"]), festival: z.string().optional(), name: z.string().optional(), fromFile: z.string().optional(), output: z.string().optional(), variables: z.array(z.object({ name: z.string(), value: z.string() })).optional(), level: z.enum(["festival", "phase", "sequence", "task"]).optional(), template: z.string().optional(), file: z.string().optional(), source: z.string().optional(), batchFile: z.string().optional(), strict: z.boolean().optional(), preview: z.boolean().optional() }),
    async (params, ctx) => {
      const discovery = params.action.startsWith("types_") || params.action.startsWith("config_");
      const cwd = discovery && !params.festival ? ctx.cwd : await selectedFestival(deps, ctx, params.festival);
      const writing = params.action === "template_create" || (params.action === "template_apply" && !!params.output && !params.preview)
        || (params.action === "markers_scaffold" && !!params.output) || (params.action === "markers_fill" && !params.preview);
      if (writing) await owningMain(ctx, cwd);
      let args: string[];
      let json = false;
      switch (params.action) {
        case "templates_list":
          // fest 0.9.8 emits invalid JSON for multi-variable templates; retain native plain output instead of repairing invented JSON.
          args = ["templates", "list"]; break;
        case "template_create":
          args = ["templates", "create", nativeName(params.name, "name"), "--from-file", await containedPath(cwd, required(params.fromFile, "fromFile"))]; break;
        case "template_apply": {
          const variables: Record<string, string> = Object.create(null) as Record<string, string>;
          for (const item of params.variables ?? []) {
            if (Object.hasOwn(variables, item.name)) throw new Error("Duplicate variable name");
            variables[required(item.name, "variable.name")] = item.value;
          }
          args = ["templates", "apply", nativeName(params.name, "name"), "--vars", JSON.stringify(variables)];
          if (params.preview) args.push("--preview");
          if (params.output) args.push("--output", await containedPath(cwd, params.output));
          break;
        }
        case "types_list": case "types_show":
          args = ["types", params.action === "types_list" ? "list" : "show"];
          if (params.action === "types_show") args.push(nativeName(params.name, "name"));
          if (params.level) args.push("--level", params.level);
          args.push("--json"); json = true; break;
        case "config_list": case "config_show": args = ["config", params.action === "config_list" ? "list" : "show", "--json"]; json = true; break;
        case "markers_scaffold":
          args = ["markers", "scaffold", "--format", "json"];
          if (!!params.template === !!params.file) throw new Error("Provide exactly one of template or file");
          if (params.template) args.push("--template", nativeName(params.template, "template"));
          if (params.file) args.push("--file", await containedPath(cwd, params.file));
          if (params.output) args.push("--output", await containedPath(cwd, params.output));
          json = !params.output; break;
        case "markers_validate":
          args = ["markers", "validate", "--file", await containedPath(cwd, required(params.file, "file"))];
          if (!!params.template === !!params.source) throw new Error("Provide exactly one of template or source");
          if (params.template) args.push("--template", nativeName(params.template, "template"));
          if (params.source) args.push("--source", await containedPath(cwd, params.source));
          if (params.strict) args.push("--strict"); break;
        case "markers_discover": args = ["wizard", "fill", await containedPath(cwd, params.file ?? "."), "--list-markers"]; json = true; break;
        case "markers_fill": {
          const batch = await containedPath(cwd, required(params.batchFile, "batchFile"));
          const bytes = await readFile(batch, "utf8");
          if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error("Marker batch exceeds 2 MiB");
          const value: unknown = JSON.parse(bytes);
          if (!object(value) || !Array.isArray(value.files) || !value.files.length) throw new Error("Expected native wizard batch {files:[{path,markers:[{hint,value}]}]}");
          for (const file of value.files) {
            if (!object(file) || typeof file.path !== "string" || !Array.isArray(file.markers) || !file.markers.length) throw new Error("Malformed marker batch file");
            // Native discovery emits absolute paths. Normalize only for validation; the native batch remains unchanged.
            await containedPath(cwd, isAbsolute(file.path) ? relative(cwd, file.path) : file.path);
            for (const marker of file.markers) if (!object(marker) || typeof marker.hint !== "string" || typeof marker.value !== "string" || !marker.value.trim()) throw new Error("Every batch marker needs its discovered hint and nonempty authored value");
          }
          args = ["wizard", "fill", "--batch-input", batch, "--json"];
          if (params.preview) args.push("--dry-run");
          json = true; break;
        }
      }
      const result = await deps.fest.raw(cwd, args);
      if (writing && result.code === 0) deps.detect.bustCache?.();
      return nativeResult(result, json);
    });
}
