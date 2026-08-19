import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { AppConfig } from "../config/config.js";
import type { ProviderName } from "../types/index.js";
import { findInstalledBrowser } from "./installed-browser.js";

export class BrowserSession {
  context?: BrowserContext;
  page?: Page;

  constructor(
    private readonly provider: ProviderName,
    private readonly config: AppConfig,
    private readonly headed = true,
    private readonly debug = false,
  ) {}

  async launch(): Promise<{ context: BrowserContext; page: Page }> {
    const userDataDir = resolve(this.config.stateDir, "browser", this.provider);
    await mkdir(userDataDir, { recursive: true });
    const common = {
      headless: !this.headed,
      slowMo: this.debug ? Math.max(150, this.config.browser.slowMo) : this.config.browser.slowMo,
      viewport: null,
      args: ["--start-maximized"],
    };

    const installed = findInstalledBrowser();
    if (installed) {
      this.context = await chromium.launchPersistentContext(userDataDir, {
        ...common,
        executablePath: installed.executablePath,
      });
    } else {
      try {
        this.context = await chromium.launchPersistentContext(userDataDir, {
          ...common,
          channel: this.config.browser.channel,
        });
      } catch (error) {
        if (this.debug) console.warn(`Installed Chrome unavailable; using Playwright Chromium: ${String(error)}`);
        this.context = await chromium.launchPersistentContext(userDataDir, common);
      }
    }

    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.page.setDefaultTimeout(this.debug ? 20_000 : 15_000);
    // Navigation is much slower than an element lookup on both sites, and a
    // navigation that times out leaves the previous conversation on screen —
    // which used to be read as if it were the requested one.
    this.page.setDefaultNavigationTimeout(this.debug ? 45_000 : 30_000);
    return { context: this.context, page: this.page };
  }

  async close(): Promise<void> {
    await this.context?.close();
  }

}
