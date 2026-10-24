export type AttachmentRole = "ui_design" | "error_screenshot" | "document_pdf" | "context" | "unknown";
export interface ClassifiedAttachment { name: string; role: AttachmentRole; reason: string }

/** User-specified roles win; otherwise classify only strong evidence, never infer design from an image alone. */
export function classifyAttachment(name: string, description: string, explicitRole?: AttachmentRole): ClassifiedAttachment {
  const value = `${name} ${description}`.toLowerCase();
  let role: AttachmentRole = explicitRole ?? "unknown";
  if (!explicitRole) {
    if (/\b(error|exception|stack trace|failure|bug|diagnostic)\b/.test(value)) role = "error_screenshot";
    else if (/\b(pdf|document|report|invoice|letter|export)\b/.test(value)) role = "document_pdf";
    else if (/\b(ui design|design reference|mockup|wireframe|redesign|screen design)\b/.test(value)) role = "ui_design";
    else if (/\b(context|background|example|reference only)\b/.test(value)) role = "context";
  }
  if (role === "unknown") return { name, role, reason: "Attachment role is ambiguous; ask the user before generating visual references." };
  if (role !== "ui_design") return { name, role, reason: "Evidence or document attachment; never generate a wireframe from this attachment." };
  return { name, role, reason: "Explicit UI design reference; use only for the requested UI change." };
}
