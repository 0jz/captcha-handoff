// Cleared-detection watcher.
//
// Polls every blocked tab in AWAITING_HUMAN state and marks the session RESUMED
// once the challenge widget is gone *and* has stayed gone for the configured
// debounce window. The debounce protects against mid-solve flicker and v3 /
// Turnstile widgets that briefly unmount and re-render.
import type { Config } from "../config.js";
import type { BlockedSession, CaptchaKind } from "../types.js";
import type { BrowserSessionManager } from "../browser/session-manager.js";
import type { HandoffCoordinator } from "./coordinator.js";

export interface ResumeWatcher {
  start(): void;
  stop(): void;
}

/** Canonical (lower-cased) marker strings per challenge kind. */
const MARKERS: Record<CaptchaKind, string[]> = {
  recaptcha_v2: ["recaptcha", "g-recaptcha"],
  recaptcha_v3: ["recaptcha", "grecaptcha"],
  turnstile: ["challenges.cloudflare.com", "cf-turnstile", "cf-chl-widget"],
  hcaptcha: ["hcaptcha", "h-captcha"],
  arkose: ["funcaptcha", "arkoselabs"],
  slider: ["slider", "slide to verify", "press & hold", "complete the puzzle"],
  unknown: [
    "captcha",
    "verify you are human",
    "are you a robot",
    "security check",
    "prove you're not a bot",
  ],
};

const POLL_INTERVAL_MS = 1500;

interface PageHandle {
  url(): string;
  content(): Promise<string>;
}

function unref(t: { unref?: () => void }): void {
  try {
    t.unref?.();
  } catch {
    // Ignore: fake timers used in tests may not implement unref.
  }
}

export function createResumeWatcher(
  browser: BrowserSessionManager,
  coordinator: HandoffCoordinator,
  cfg: Config,
): ResumeWatcher {
  /** sessionId -> timestamp when the challenge marker was first absent. */
  const goneSince = new Map<string, number>();
  const debounceMs = Math.max(0, cfg.clearDebounceMs);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function checkSession(session: BlockedSession): Promise<void> {
    const page = (await browser.getPage(session.tabId)) as
      | PageHandle
      | null
      | undefined;
    if (!page) {
      // Tab is gone (or not resolvable) — nothing to watch, let it time out.
      goneSince.delete(session.sessionId);
      return;
    }

    let url: string;
    let html: string;
    try {
      url = page.url();
      html = await page.content();
    } catch {
      // Page navigated away mid-read; treat as unknown, try again next tick.
      return;
    }

    // An empty/blank document is not evidence that the challenge cleared.
    if (html.trim().length === 0) {
      return;
    }

    const haystack = `${html}\n${url}`.toLowerCase();
    const markers = MARKERS[session.kind] ?? MARKERS.unknown;
    const stillPresent = markers.some((marker) => haystack.includes(marker));

    if (stillPresent) {
      goneSince.delete(session.sessionId);
      return;
    }

    const now = Date.now();
    const since = goneSince.get(session.sessionId);
    if (since === undefined) {
      // First tick where the widget was absent; start the debounce clock.
      goneSince.set(session.sessionId, now);
      return;
    }

    if (now - since >= debounceMs) {
      goneSince.delete(session.sessionId);
      coordinator.markCleared(session.sessionId);
    }
  }

  async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const pending = coordinator
        .list()
        .filter((s) => s.state === "AWAITING_HUMAN" || s.state === "BLOCKED");

      // Drop debounce tracking for sessions that are no longer waiting.
      const pendingIds = new Set(pending.map((s) => s.sessionId));
      for (const id of [...goneSince.keys()]) {
        if (!pendingIds.has(id)) goneSince.delete(id);
      }

      for (const session of pending) {
        try {
          await checkSession(session);
        } catch (err) {
          console.warn(
            `[handoff] resume check failed for ${session.site}:`,
            err,
          );
        }
      }
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer !== null) return;
    void tick();
    timer = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    unref(timer);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    goneSince.clear();
  }

  return { start, stop };
}
