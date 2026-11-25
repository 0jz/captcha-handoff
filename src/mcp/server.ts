// MCP server wiring: tool registration, detection events, and the async
// handoff pipeline (screenshot -> notify -> auto-resume -> jar export).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Config } from "../config.js";
import type { BrowserSessionManager } from "../browser/session-manager.js";
import type { Watchman } from "../browser/watchman.js";
import type { HandoffCoordinator } from "../handoff/coordinator.js";
import type { ResumeWatcher } from "../handoff/resume.js";
import type { Notifier } from "../notify/notifier.js";
import type { JarStore } from "../jar/store.js";
import { exportSession, injectSession } from "../jar/export.js";
import { detectOnPage } from "../detector/detect.js";
import { attemptSolve } from "../solver/solver.js";
import type { BlockedSession, Detection, Tab } from "../types.js";

import {
  detectCaptchaInput,
  getHandoffStatusInput,
  listKnownSitesInput,
  requestHumanSolveInput,
  restoreSessionInput,
  saveSessionInput,
  solveCaptchaInput,
  waitForClearInput,
} from "./schemas.js";

export interface ServerDeps {
  config: Config;
  browser: BrowserSessionManager;
  watchman: Watchman;
  coordinator: HandoffCoordinator;
  resume: ResumeWatcher;
  notifier: Notifier;
  jar: JarStore;
}

const NAME = "captcha-handoff";
const VERSION = "0.1.0";
const LOGGER = "captcha-handoff";

type LogLevel = "debug" | "info" | "notice" | "warning" | "error";

function json(content: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(content, null, 2) }] };
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Save a full-page PNG of a tab and return its absolute path (or undefined). */
async function captureScreenshot(
  browser: BrowserSessionManager,
  tabId: string,
  cfg: Config,
): Promise<string | undefined> {
  try {
    const buf = await browser.screenshot(tabId);
    await mkdir(cfg.screenshotDir, { recursive: true });
    const file = path.join(
      cfg.screenshotDir,
      `handoff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`,
    );
    await writeFile(file, buf);
    return file;
  } catch {
    return undefined;
  }
}

export function createServer(deps: ServerDeps): McpServer {
  const { config: cfg, browser, watchman, coordinator, notifier, jar } = deps;
  const mcp = new McpServer({ name: NAME, version: VERSION });

  function push(level: LogLevel, data: string): void {
    try {
      void mcp.server
        .sendLoggingMessage({ level, logger: LOGGER, data })
        .catch(() => {});
    } catch {
      // Not connected yet (or transport closed): the message is best-effort.
    }
  }

  /** Idempotent attach: connect over CDP, or launch Chrome if none is running. */
  async function ensureAttached(): Promise<void> {
    await browser.attach();
  }

  function findActiveSessionByTab(tabId: string): BlockedSession | undefined {
    return coordinator
      .list()
      .find(
        (s) =>
          s.tabId === tabId &&
          (s.state === "BLOCKED" || s.state === "AWAITING_HUMAN"),
      );
  }

  /** Shared detection pipeline: screenshot, open a handoff, notify the human. */
  async function handleDetection(detection: Detection): Promise<BlockedSession> {
    const existing = findActiveSessionByTab(detection.tabId);
    if (existing) return existing;

    const screenshotPath = await captureScreenshot(browser, detection.tabId, cfg);
    const session = coordinator.open({ ...detection, screenshotPath });

    const humanMsg =
      `[handoff] blocked on ${session.site} — screenshot at ` +
      `${screenshotPath ?? "<none>"} — human notified (state=${session.state})`;
    push("notice", humanMsg);
    await notifier.notify([session]);

    return session;
  }

  // ---------------------------------------------------------------------------
  // Event wiring: watchman -> coordinator -> notifier/jar, plus MCP pushes.
  // ---------------------------------------------------------------------------
  watchman.onChallenge((detection) => {
    void handleDetection(detection).catch((err) => {
      console.warn("[handoff] detection handling failed:", err);
    });
  });

  coordinator.onCleared((session) => {
    push(
      "info",
      `[handoff] cleared on ${session.site} (state=${session.state})`,
    );
    // Auto-persist the now-verified session into the jar.
    void (async () => {
      try {
        const page = await browser.getPage(session.tabId);
        const entry = await exportSession(page, session.site, cfg);
        await jar.save(entry);
        push(
          "info",
          `[handoff] session for ${session.site} saved to the jar (expires ${new Date(
            entry.expiresHint,
          ).toISOString()})`,
        );
      } catch (err) {
        console.warn("[handoff] jar export failed:", err);
      }
    })();
  });

  coordinator.onExpired((session) => {
    push(
      "warning",
      `[handoff] expired on ${session.site} — task parked; human never responded (state=${session.state})`,
    );
    void notifier.notifyMessage(
      `${session.site} needs you — handoff expired, task parked.`,
    );
  });

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  mcp.registerTool(
    "detect_captcha",
    {
      title: "Detect CAPTCHA",
      description:
        "Scan a tab (or all tabs) for a CAPTCHA challenge. On a hit, screenshots the tab, opens a handoff session and notifies the human. Usable without a blocking event.",
      inputSchema: detectCaptchaInput,
    },
    async (args) => {
      await ensureAttached();
      const tabs: Tab[] = args.tabId
        ? [{ id: args.tabId }]
        : await browser.listTabs();

      for (const tab of tabs) {
        const page = await browser.getPage(tab.id);
        const detection = await detectOnPage(page, tab.id, cfg);
        if (!detection) continue;

        const session = await handleDetection(detection);
        return json({
          blocked: true,
          site: session.site,
          kind: session.kind,
          confidence: session.confidence,
          evidence: session.evidence,
          screenshotPath: session.screenshotPath,
          sessionId: session.sessionId,
        });
      }

      return json({ blocked: false });
    },
  );

  mcp.registerTool(
    "solve_captcha",
    {
      title: "Attempt to solve a CAPTCHA",
      description:
        "Try to solve a detected CAPTCHA by itself using human-like mouse movement (cubic-bezier paths with jitter, variable speed and overshoot). Only runs when the agent explicitly calls it. On failure it falls back to the human handoff. Works on checkbox-style challenges (reCAPTCHA v2, hCaptcha, Turnstile), sliders, and generic 'I am human' buttons; image/audio challenges are handed to a human.",
      inputSchema: solveCaptchaInput,
    },
    async (args) => {
      await ensureAttached();

      let detection: Detection;
      let associatedSession: BlockedSession | undefined;

      if (args.sessionId) {
        const session = coordinator.get(args.sessionId);
        if (!session) {
          return json({ error: `no session found for "${args.sessionId}"` });
        }
        associatedSession = session;
        detection = {
          site: session.site,
          tabId: session.tabId,
          kind: session.kind,
          confidence: session.confidence,
          evidence: session.evidence,
          detectedAt: session.detectedAt,
        };
      } else if (args.tabId) {
        const page = await browser.getPage(args.tabId);
        const found = await detectOnPage(page, args.tabId, cfg);
        if (!found) {
          return json({ attempted: false, message: "no CAPTCHA detected on tab" });
        }
        detection = found;
      } else {
        const tabs = await browser.listTabs();
        let found: Detection | null = null;
        for (const tab of tabs) {
          const page = await browser.getPage(tab.id);
          found = await detectOnPage(page, tab.id, cfg);
          if (found) break;
        }
        if (!found) {
          return json({ attempted: false, message: "no CAPTCHA detected on any tab" });
        }
        detection = found;
      }

      const page = await browser.getPage(detection.tabId);
      const result = await attemptSolve(page, detection, cfg);

      if (result.solved) {
        // A successful solve is a verified session: persist it immediately.
        try {
          const entry = await exportSession(page, detection.site, cfg);
          await jar.save(entry);
        } catch (err) {
          console.warn("[handoff] jar export after solve failed:", err);
        }
        if (associatedSession) coordinator.markCleared(associatedSession.sessionId);
        return json(result);
      }

      // Fall back to the human handoff (open one if none exists yet).
      if (associatedSession) {
        await notifier.notify([associatedSession]);
        push(
          "notice",
          `[handoff] self-solve failed on ${associatedSession.site}; human still needed`,
        );
      } else {
        const session = await handleDetection(detection);
        associatedSession = session;
      }

      return json({
        ...result,
        fallback: "human",
        handoffSessionId: associatedSession?.sessionId,
      });
    },
  );

  mcp.registerTool(
    "request_human_solve",
    {
      title: "Request human solve",
      description:
        "Explicitly ping the human for a handoff session. Returns immediately; the session auto-resumes when the challenge clears.",
      inputSchema: requestHumanSolveInput,
    },
    async (args) => {
      const session = coordinator.get(args.sessionId);
      if (!session) {
        return json({ notified: false, message: `no session found for "${args.sessionId}"` });
      }
      await notifier.notify([session]);
      push(
        "notice",
        `[handoff] human pinged for ${session.site} (state=${session.state})`,
      );
      return json({
        notified: true,
        message:
          `Human pinged for ${session.site}. Tab is open in Chrome. ` +
          `Continue other work; this session auto-resumes when the challenge clears.`,
      });
    },
  );

  mcp.registerTool(
    "get_handoff_status",
    {
      title: "Get handoff status",
      description: "Poll-free read of handoff session state. Omit sessionId to list all.",
      inputSchema: getHandoffStatusInput,
    },
    async (args) => {
      const sessions = args.sessionId
        ? coordinator
            .list()
            .filter((s) => s.sessionId === args.sessionId)
        : coordinator.list();

      return json({
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          site: s.site,
          state: s.state,
          kind: s.kind,
          confidence: s.confidence,
          detectedAt: s.detectedAt,
          resumedAt: s.resumedAt,
          expiredAt: s.expiredAt,
        })),
      });
    },
  );

  mcp.registerTool(
    "wait_for_clear",
    {
      title: "Wait for clear",
      description:
        "Long-poll a handoff session until it clears (or expires). Prefer get_handoff_status for most agents.",
      inputSchema: waitForClearInput,
    },
    async (args) => {
      const timeoutMs = args.timeoutMs ?? 60_000;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const session = coordinator.get(args.sessionId);
        if (!session) {
          return json({ cleared: false, still: "UNKNOWN_SESSION" });
        }
        if (session.state === "RESUMED") {
          return json({ cleared: true, resumedAt: session.resumedAt });
        }
        if (session.state === "EXPIRED") {
          return json({ cleared: false, still: "EXPIRED" });
        }
        if (Date.now() >= deadline) {
          return json({ cleared: false, still: session.state });
        }
        await sleep(250);
      }
    },
  );

  mcp.registerTool(
    "save_session",
    {
      title: "Save session",
      description:
        "Persist the current verified session for a site into the encrypted jar. Auto-called on clear; exposed to force-save after a manual login.",
      inputSchema: saveSessionInput,
    },
    async (args) => {
      await ensureAttached();
      const tabs = await browser.listTabs();
      const page = await browser.getPage(tabs[0]?.id ?? "");
      const entry = await exportSession(page, args.site, cfg);
      await jar.save(entry);
      return json({ saved: true, expiresHint: entry.expiresHint });
    },
  );

  mcp.registerTool(
    "restore_session",
    {
      title: "Restore session",
      description:
        "Inject a saved session (cookies + localStorage) before navigating to a site. Call this before opening the site.",
      inputSchema: restoreSessionInput,
    },
    async (args) => {
      await ensureAttached();
      const entry = await jar.get(args.site);
      if (!entry) {
        return json({ restored: false, reason: "no-entry" });
      }
      const tabs = await browser.listTabs();
      const page = await browser.getPage(tabs[0]?.id ?? "");
      await injectSession(page, entry);
      return json({ restored: true, savedAt: entry.savedAt });
    },
  );

  mcp.registerTool(
    "list_known_sites",
    {
      title: "List known sites",
      description: "List all sites with a saved (verified) session in the jar.",
      inputSchema: listKnownSitesInput,
    },
    async () => {
      const entries = await jar.list();
      return json({
        sites: entries.map((e) => ({
          site: e.site,
          savedAt: e.savedAt,
          expiresHint: e.expiresHint,
          entries: 1,
        })),
      });
    },
  );

  return mcp;
}
