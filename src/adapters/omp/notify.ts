/**
 * Notifier adapter over omp's ui.notify plus optional camp-notify/webhook
 * fan-out for gate events on headless boxes.
 */
import type { CampCli, Notifier } from "@/ports.js";
import type { OmpFestConfig } from "@/domain/types.js";

export interface UiLike {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export class OmpNotifier implements Notifier {
  constructor(private readonly ui: UiLike) {}

  info(message: string): void {
    this.ui.notify(message, "info");
  }

  warn(message: string): void {
    this.ui.notify(message, "warning");
  }

  error(message: string): void {
    this.ui.notify(message, "error");
  }
}

/** Fans gate notifications out to ui + camp inbox + optional webhook. */
export async function notifyGate(input: {
  ui: UiLike;
  camp: CampCli;
  campRoot?: string;
  config: OmpFestConfig;
  message: string;
}): Promise<void> {
  if (input.config.gateNotify.includes("ui")) {
    input.ui.notify(input.message, "warning");
  }
  if (input.config.gateNotify.includes("camp-notify") && input.campRoot) {
    await input.camp.notify(input.campRoot, input.message);
  }
  if (input.config.gateNotify.includes("webhook") && input.config.webhookUrl) {
    await fetch(input.config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: input.message,
    }).catch(() => undefined);
  }
}
