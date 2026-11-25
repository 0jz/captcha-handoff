// Notifier: OS toast + optional webhook, with a small batching window so that
// several simultaneously-blocked tabs produce a single "N sites need you" ping.
//
// Non-blocking by contract: nothing here ever awaits human action. `notify()`
// resolves as soon as the sessions are queued; delivery happens on the batch
// timer (or on an explicit `flush()`).
import { readFile } from "node:fs/promises";

import notifier from "node-notifier";

import type { Config } from "../config.js";
import type { BlockedSession } from "../types.js";

export interface Notifier {
  notify(sessions: BlockedSession[]): Promise<void>;
  notifyMessage(message: string): Promise<void>;
  flush(): Promise<void>;
}

const TOAST_TITLE = "captcha-handoff";
const WEBHOOK_TIMEOUT_MS = 10_000;
const BELL = "\x07";

function unref(t: { unref?: () => void }): void {
  try {
    t.unref?.();
  } catch {
    // Ignore: fake timers used in tests may not implement unref.
  }
}

function consoleFallback(message: string): void {
  console.log(`[handoff] ${message}`);
  try {
    process.stdout.write(BELL);
  } catch {
    // stdout may be closed (e.g. during shutdown); nothing else to do.
  }
}

export function createNotifier(cfg: Config): Notifier {
  const queue = new Map<string, BlockedSession>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function toast(message: string): void {
    if (!cfg.notify.enabled) {
      consoleFallback(message);
      return;
    }
    try {
      notifier.notify({ title: TOAST_TITLE, message, wait: false }, (err) => {
        if (err) consoleFallback(message);
      });
    } catch {
      consoleFallback(message);
    }
  }

  function buildMessage(sessions: BlockedSession[]): string {
    const sites = [...new Set(sessions.map((s) => s.site))];
    if (sites.length === 1) {
      return `1 site needs you: ${sites[0]}`;
    }
    return `${sites.length} sites need you: ${sites.join(", ")}`;
  }

  async function postWebhook(session: BlockedSession): Promise<void> {
    const url = cfg.notify.webhookUrl;
    if (!url) return;

    const payload: Record<string, unknown> = {
      site: session.site,
      tabId: session.tabId,
    };

    if (session.screenshotPath) {
      try {
        const buf = await readFile(session.screenshotPath);
        payload.screenshotBase64 = buf.toString("base64");
      } catch {
        // Screenshot missing/unreadable: omit the field, keep the notification.
      }
    }

    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn("[handoff] webhook delivery failed:", err);
    }
  }

  async function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.size === 0) return;

    const batch = [...queue.values()];
    queue.clear();

    toast(buildMessage(batch));

    if (cfg.notify.webhookUrl) {
      // Fire-and-forget per session; allSettled keeps flush() from ever throwing.
      await Promise.allSettled(batch.map((s) => postWebhook(s)));
    }
  }

  async function notify(sessions: BlockedSession[]): Promise<void> {
    if (sessions.length === 0) return;

    for (const session of sessions) {
      queue.set(session.sessionId, session);
    }

    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, Math.max(0, cfg.notify.batchWindowMs));
      unref(timer);
    }
  }

  async function notifyMessage(message: string): Promise<void> {
    toast(message);
  }

  return { notify, notifyMessage, flush };
}
