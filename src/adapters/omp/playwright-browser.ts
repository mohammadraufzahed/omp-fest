import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { access } from "node:fs/promises";
import type { FlowBrowser } from "../../application/browser-flows.js";

export async function playwrightAvailable(): Promise<boolean> {
  try { await access(process.env.OMP_FEST_CHROMIUM_EXECUTABLE ?? chromium.executablePath()); return true; }
  catch { return false; }
}

export async function createGuardedBrowser(browser: Browser, context: BrowserContext, page: Page): Promise<FlowBrowser> {
  let closed = false, configuredOrigin: string | undefined, escaped = false;
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (configuredOrigin && request.isNavigationRequest() && new URL(request.url()).origin !== configuredOrigin) {
      escaped = true;
      await route.abort();
      return;
    }
    await route.continue();
  });
  context.on("page", (popup) => { escaped = true; void popup.close(); });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && configuredOrigin && new URL(frame.url()).origin !== configuredOrigin) escaped = true;
  });
  const assertOrigin = () => {
    if (!configuredOrigin || escaped || new URL(page.url()).origin !== configuredOrigin) throw new Error("Browser navigation escaped the configured origin.");
  };
  return {
    async open(url, allowedOrigin) {
      const target = new URL(url), allowed = new URL(allowedOrigin);
      if (allowed.protocol !== "https:" || target.protocol !== "https:" || target.origin !== allowed.origin || target.username || target.password) throw new Error("Unsafe browser navigation target.");
      configuredOrigin = allowed.origin; escaped = false;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      assertOrigin();
    },
    async fill(selector, value) { assertOrigin(); await page.locator(selector).fill(value, { timeout: 10_000 }); assertOrigin(); },
    async click(selector) { assertOrigin(); await page.locator(selector).click({ timeout: 10_000 }); assertOrigin(); },
    async visible(selector) { assertOrigin(); try { const result = await page.locator(selector).first().isVisible({ timeout: 1_500 }); assertOrigin(); return result; } catch { assertOrigin(); return false; } },
    async close() { if (!closed) { closed = true; try { await context.close(); } finally { await browser.close(); } } },
  };
}

export async function openIsolatedBrowser(): Promise<FlowBrowser> {
  const executablePath = process.env.OMP_FEST_CHROMIUM_EXECUTABLE ?? chromium.executablePath();
  await access(executablePath);
  const browser: Browser = await chromium.launch({ headless: true, executablePath, args: ["--disable-extensions", "--disable-sync"] });
  try {
    const context: BrowserContext = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    const page: Page = await context.newPage();
    return await createGuardedBrowser(browser, context, page);
  } catch (error) {
    await browser.close();
    throw error;
  }
}
