import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { access } from "node:fs/promises";
import type { FlowBrowser } from "../../application/browser-flows.js";

export async function playwrightAvailable(): Promise<boolean> {
  try { await access(process.env.OMP_FEST_CHROMIUM_EXECUTABLE ?? chromium.executablePath()); return true; }
  catch { return false; }
}
export async function openIsolatedBrowser(): Promise<FlowBrowser> {
  const executablePath = process.env.OMP_FEST_CHROMIUM_EXECUTABLE ?? chromium.executablePath();
  await access(executablePath);
  const browser: Browser = await chromium.launch({ headless: true, executablePath, args: ["--disable-extensions", "--disable-sync"] });
  try {
    const context: BrowserContext = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    const page: Page = await context.newPage();
    let closed = false;
    return {
      async open(url) {
        const target = new URL(url);
        if (target.protocol !== "https:" || target.username || target.password) throw new Error("Unsafe browser navigation target.");
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (new URL(page.url()).origin !== target.origin) throw new Error("Website redirected away from the configured origin.");
      },
      async fill(selector, value) { await page.locator(selector).fill(value, { timeout: 10_000 }); },
      async click(selector) { await page.locator(selector).click({ timeout: 10_000 }); },
      async visible(selector) { try { return await page.locator(selector).first().isVisible({ timeout: 1_500 }); } catch { return false; } },
      async close() { if (!closed) { closed = true; try { await context.close(); } finally { await browser.close(); } } },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
