// Watches tabs for navigation/target events and reports CAPTCHA challenges.
import { detectOnPage } from "../detector/detect.js";
import type { Config } from "../config.js";
import type { Detection, Tab } from "../types.js";
import type { BrowserSessionManager } from "./session-manager.js";

export interface Watchman {
  start(): void;
  stop(): void;
  onChallenge(cb: (d: Detection) => void): void;
}

/** Ignore repeat detections for the same tab inside this window. */
const DEBOUNCE_MS = 500;

export function createWatchman(
  browser: BrowserSessionManager,
  cfg: Config,
): Watchman {
  const callbacks: Array<(d: Detection) => void> = [];
  const lastFiredAt = new Map<string, number>();
  const inFlight = new Set<string>();
  let active = false;
  let subscribed = false;

  const runDetection = async (tab: Tab): Promise<void> => {
    if (!active) return;

    const now = Date.now();
    const last = lastFiredAt.get(tab.id) ?? 0;
    if (now - last < DEBOUNCE_MS || inFlight.has(tab.id)) return;

    inFlight.add(tab.id);
    try {
      const page = await browser.getPage(tab.id);
      const detection = await detectOnPage(page, tab.id, cfg);
      if (!detection || !active) return;

      lastFiredAt.set(tab.id, Date.now());
      for (const cb of callbacks) {
        try {
          cb(detection);
        } catch {
          // A broken consumer must not stop the watcher.
        }
      }
    } catch {
      // The page may have closed between the event and the check.
    } finally {
      inFlight.delete(tab.id);
    }
  };

  const subscribe = (): void => {
    if (subscribed) return;
    subscribed = true;
    browser.onNewTarget((tab) => {
      void runDetection(tab);
    });
    browser.onFrameNavigated((tab) => {
      void runDetection(tab);
    });
  };

  return {
    start(): void {
      active = true;
      subscribe();
    },
    stop(): void {
      active = false;
      inFlight.clear();
    },
    onChallenge(cb: (d: Detection) => void): void {
      callbacks.push(cb);
    },
  };
}
