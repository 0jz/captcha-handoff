// Owns the CDP connection to Chrome and exposes pages as tabs.
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { Config } from "../config.js";
import type { Tab } from "../types.js";

export interface BrowserSessionManager {
  /** Connect over CDP, or launch a browser if none is listening. */
  attach(): Promise<void>;
  getBrowser(): Browser;
  getPage(tabId: string): Promise<Page>;
  onNewTarget(cb: (tab: Tab) => void): void;
  onFrameNavigated(cb: (tab: Tab) => void): void;
  listTabs(): Promise<Tab[]>;
  /** Full-page PNG of the given tab. */
  screenshot(tabId: string): Promise<Buffer>;
  close(): Promise<void>;
}

const CDP_HOST = "127.0.0.1";

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

/**
 * Playwright has no public browser-level "targetcreated" event, so page
 * discovery is driven by BrowserContext "page" events plus a snapshot of
 * context.pages() taken whenever we attach or list tabs.
 */
class SessionManager implements BrowserSessionManager {
  private readonly cfg: Config;
  private browser: Browser | null = null;
  private readonly trackedContexts = new Set<BrowserContext>();
  /** Alias (stable id or CDP target id) -> page. */
  private readonly pages = new Map<string, Page>();
  /** Page -> stable id, so a tab id survives navigation. */
  private readonly ids = new WeakMap<Page, string>();
  private readonly hookedPages = new WeakSet<Page>();
  private readonly aliasedPages = new WeakSet<Page>();
  private readonly newTargetCbs: Array<(tab: Tab) => void> = [];
  private readonly frameNavCbs: Array<(tab: Tab) => void> = [];

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  /**
   * Launch the user's own Chrome/Edge with a persistent profile so the agent
   * and the human share one cookie store. Playwright forbids `--user-data-dir`
   * in `launch`; the correct primitive is `launchPersistentContext`, which also
   * works with playwright-core (no bundled browsers) via `channel`/path.
   */
  private async launchPersistent(): Promise<Browser> {
    const baseArgs = [
      `--remote-debugging-port=${this.cfg.chromeDebugPort}`,
      "--no-first-run",
      "--no-default-browser-check",
    ];

    const channels = ["chrome", "msedge"] as const;
    let lastErr: unknown;
    for (const channel of channels) {
      try {
        const context = await chromium.launchPersistentContext(
          this.cfg.userDataDir,
          { headless: this.cfg.headless, channel, args: baseArgs },
        );
        return context.browser() ?? (context as unknown as Browser);
      } catch (err) {
        lastErr = err;
      }
    }

    const candidates = [
      process.env.CHROME_PATH,
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ].filter((p): p is string => typeof p === "string" && p.length > 0);

    for (const executablePath of candidates) {
      try {
        const context = await chromium.launchPersistentContext(
          this.cfg.userDataDir,
          { headless: this.cfg.headless, executablePath, args: baseArgs },
        );
        return context.browser() ?? (context as unknown as Browser);
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error("Could not launch a persistent Chrome/Edge profile.");
  }

  async attach(): Promise<void> {
    if (!this.browser) {
      const endpoint = `http://${CDP_HOST}:${this.cfg.chromeDebugPort}`;
      try {
        this.browser = await chromium.connectOverCDP(endpoint);
      } catch {
        this.browser = await this.launchPersistent();
      }

      this.browser.on("disconnected", () => {
        this.browser = null;
        this.pages.clear();
        this.trackedContexts.clear();
      });
    }

    const contexts = this.browser.contexts();
    for (const context of contexts) {
      this.trackContext(context);
    }
    for (const context of contexts) {
      for (const page of context.pages()) {
        this.registerPage(page, false);
      }
    }
  }

  getBrowser(): Browser {
    if (!this.browser) {
      throw new Error("Browser session is not attached; call attach() first.");
    }
    return this.browser;
  }

  async getPage(tabId: string): Promise<Page> {
    const cached = this.pages.get(tabId);
    if (cached && !cached.isClosed()) return cached;

    const browser = this.browser;
    if (!browser) {
      throw new Error("Browser session is not attached; call attach() first.");
    }

    for (const context of browser.contexts()) {
      this.trackContext(context);
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        if (this.ensureId(page) === tabId) {
          this.pages.set(tabId, page);
          return page;
        }
      }
    }

    // The caller may have used a raw CDP target id that we have not seen yet.
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        const targetId = await this.cdpTargetId(page);
        if (!targetId) continue;
        this.pages.set(targetId, page);
        if (targetId === tabId) return page;
      }
    }

    throw new Error(`No page found for tab "${tabId}".`);
  }

  onNewTarget(cb: (tab: Tab) => void): void {
    this.newTargetCbs.push(cb);
  }

  onFrameNavigated(cb: (tab: Tab) => void): void {
    this.frameNavCbs.push(cb);
  }

  async listTabs(): Promise<Tab[]> {
    const browser = this.browser;
    if (!browser) return [];

    const seen = new Set<Page>();
    const tabs: Tab[] = [];
    for (const context of browser.contexts()) {
      this.trackContext(context);
      for (const page of context.pages()) {
        if (seen.has(page) || page.isClosed()) continue;
        seen.add(page);
        this.registerPage(page, false);

        let title: string | undefined;
        try {
          title = await page.title();
        } catch {
          title = undefined;
        }
        tabs.push({ id: this.ensureId(page), url: safeUrl(page), title });
      }
    }
    return tabs;
  }

  async screenshot(tabId: string): Promise<Buffer> {
    const page = await this.getPage(tabId);
    return page.screenshot({ fullPage: true, type: "png" });
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.pages.clear();
    this.trackedContexts.clear();
    if (!browser) return;
    try {
      await browser.close();
    } catch {
      // Already gone (e.g. the human closed Chrome).
    }
  }

  private trackContext(context: BrowserContext): void {
    if (this.trackedContexts.has(context)) return;
    this.trackedContexts.add(context);
    context.on("page", (page) => {
      this.registerPage(page, true);
    });
  }

  private registerPage(page: Page, emit: boolean): string {
    const id = this.ensureId(page);
    this.pages.set(id, page);
    this.hookPage(page);
    this.aliasCdpTargetId(page, id);
    if (emit) this.emitNewTarget(id, page);
    return id;
  }

  private hookPage(page: Page): void {
    if (this.hookedPages.has(page)) return;
    this.hookedPages.add(page);

    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame() || page.isClosed()) return;
      const id = this.ensureId(page);
      this.pages.set(id, page);
      this.emitFrameNavigated(id, page);
    });

    page.on("close", () => {
      for (const [key, value] of this.pages) {
        if (value === page) this.pages.delete(key);
      }
    });
  }

  /** Store the CDP target id as an extra lookup key once it is available. */
  private aliasCdpTargetId(page: Page, id: string): void {
    if (this.aliasedPages.has(page)) return;
    this.aliasedPages.add(page);
    void this.cdpTargetId(page)
      .then((targetId) => {
        if (!targetId || targetId === id || page.isClosed()) return;
        this.pages.set(targetId, page);
      })
      .catch(() => {
        // Target info is best-effort; the stable id still works.
      });
  }

  private async cdpTargetId(page: Page): Promise<string | null> {
    let session: Awaited<ReturnType<BrowserContext["newCDPSession"]>> | null = null;
    try {
      session = await page.context().newCDPSession(page);
      const info = (await session.send("Target.getTargetInfo")) as unknown as {
        targetInfo?: { targetId?: string };
      };
      return info?.targetInfo?.targetId ?? null;
    } catch {
      return null;
    } finally {
      if (session) {
        try {
          await session.detach();
        } catch {
          // Session already detached.
        }
      }
    }
  }

  private ensureId(page: Page): string {
    let id = this.ids.get(page);
    if (!id) {
      id = randomUUID();
      this.ids.set(page, id);
    }
    return id;
  }

  private emitNewTarget(id: string, page: Page): void {
    const tab: Tab = { id, url: safeUrl(page) };
    for (const cb of this.newTargetCbs) {
      try {
        cb(tab);
      } catch {
        // A broken listener must not take down the session.
      }
    }
  }

  private emitFrameNavigated(id: string, page: Page): void {
    const tab: Tab = { id, url: safeUrl(page) };
    for (const cb of this.frameNavCbs) {
      try {
        cb(tab);
      } catch {
        // A broken listener must not take down the session.
      }
    }
  }
}

export function createSessionManager(cfg: Config): BrowserSessionManager {
  return new SessionManager(cfg);
}
