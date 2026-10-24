import { deleteBrowserFlow, listBrowserFlows } from "../../application/browser-flows.js";
import { deleteCredential } from "../../application/secret-store.js";
import type { FlowUi } from "../../application/host-capabilities.js";
import type { CampDetect } from "../../ports.js";
type Ui = FlowUi & { notify(message: string, type?: string): void };
interface Ctx { cwd: string; ui: Ui }
interface Pi { registerCommand(name: string, options: { description?: string; handler(args: string, ctx: Ctx): Promise<void> | void }): void; sendUserMessage?(text: string, options?: { deliverAs?: "steer" | "followUp" | "aside" }): void }
export function flowCommands(pi: Pi, detect: CampDetect) {
  return {
    flows: { desc: "List, run, or delete website flows and keyring credentials (/fest flows [run|delete|credential-delete] <name-or-ref>)", run: async (args: string[], ctx: Ctx) => {
      const root = (await detect.locate(ctx.cwd)).campRoot;
      if (!root) { ctx.ui.notify("/fest flows requires a camp.", "warning"); return; }
      try {
        const action = args[0] ?? "list", requested = args[1];
        const flows = await listBrowserFlows(root);
        if (action === "list") { ctx.ui.notify(flows.length ? flows.map((flow) => `${flow.id} — ${flow.origin}`).join("\n") : "No saved website flows.", "info"); return; }
        const flow = flows.find((item) => item.id === requested);
        if (action === "credential-delete" && requested && /^[a-f0-9-]{36}$/.test(requested)) {
          if (!await ctx.ui.confirm?.("Delete saved credential?", `Remove keyring entry ${requested}? Referencing flows will ask again.`)) return;
          ctx.ui.notify(await deleteCredential(requested) ? "Credential deleted from the OS keyring." : "Credential store unavailable or entry not found.", "info"); return;
        }
        if (!flow) { ctx.ui.notify(`Unknown flow. Available: ${flows.map((item) => item.id).join(", ") || "none"}`, "warning"); return; }
        if (action === "delete") {
          if (!await ctx.ui.confirm?.("Delete website flow?", `Delete ${flow.id}? This does not delete its OS keyring credential; remove that credential separately.`)) return;
          await deleteBrowserFlow(root, flow.id, flow.revision); ctx.ui.notify(`Deleted flow ${flow.id}.`, "info"); return;
        }
        if (action === "run" && pi.sendUserMessage) { pi.sendUserMessage(`Run saved website flow ${flow.id} using fest_flow {action:"run",id:${JSON.stringify(flow.id)}}. Do not delegate it; collect all inputs only through the native UI.`, { deliverAs: "followUp" }); return; }
        ctx.ui.notify("Usage: /fest flows [list | run <name> | delete <name> | credential-delete <opaque-ref>]", "info");
      } catch (error) { ctx.ui.notify(`Flow manager failed: ${String(error)}`, "error"); }
    } },
  };
}
