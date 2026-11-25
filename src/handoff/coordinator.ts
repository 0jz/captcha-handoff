// Handoff coordinator: one state machine per blocked tab.
//
//   detect -> BLOCKED -> AWAITING_HUMAN -> (cleared) RESUMED
//                                      \-> (timeout) EXPIRED
//
// The coordinator owns timers only. Notification and jar export are wired up
// by callers through the onCleared / onExpired callbacks.
import { randomUUID } from "node:crypto";

import type { Config } from "../config.js";
import type { BlockedSession, Detection, HandoffState } from "../types.js";

export interface HandoffCoordinator {
  open(d: Detection): BlockedSession;
  onCleared(cb: (s: BlockedSession) => void): void;
  onExpired(cb: (s: BlockedSession) => void): void;
  list(): BlockedSession[];
  get(sessionId: string): BlockedSession | undefined;
  markCleared(sessionId: string): void;
  markExpired(sessionId: string): void;
  stop(): void;
}

type SessionCallback = (s: BlockedSession) => void;

interface Entry {
  session: BlockedSession;
  expiryTimer?: NodeJS.Timeout;
  pingTimer?: NodeJS.Timeout;
}

/** States in which human action is still pending (and timers keep running). */
function isWaiting(state: HandoffState): boolean {
  return state === "BLOCKED" || state === "AWAITING_HUMAN";
}

function nextSessionId(): string {
  const rand = randomUUID().replace(/-/g, "").slice(0, 12);
  return `hs_${Date.now().toString(36)}_${rand}`;
}

function unref(t: { unref?: () => void }): void {
  try {
    t.unref?.();
  } catch {
    // Ignore: some timer shims (fake timers) do not implement unref.
  }
}

export function createCoordinator(cfg: Config): HandoffCoordinator {
  const entries = new Map<string, Entry>();
  /** Insertion order of session ids; list() reverses it to be newest-first. */
  const order: string[] = [];
  const clearedListeners: SessionCallback[] = [];
  const expiredListeners: SessionCallback[] = [];
  let stopped = false;

  function clearTimers(entry: Entry): void {
    if (entry.expiryTimer !== undefined) {
      clearTimeout(entry.expiryTimer);
      entry.expiryTimer = undefined;
    }
    if (entry.pingTimer !== undefined) {
      clearInterval(entry.pingTimer);
      entry.pingTimer = undefined;
    }
  }

  function emit(listeners: SessionCallback[], session: BlockedSession): void {
    for (const cb of listeners) {
      try {
        cb(session);
      } catch (err) {
        console.error("[handoff] coordinator callback failed:", err);
      }
    }
  }

  function expireIfDue(sessionId: string, force: boolean): void {
    const entry = entries.get(sessionId);
    if (!entry) return;
    const { session } = entry;
    if (!isWaiting(session.state)) return;

    const elapsed = Date.now() - session.detectedAt;
    if (force || elapsed >= Math.max(0, cfg.handoffTimeoutMs)) {
      markExpired(sessionId);
    }
  }

  function startTimers(entry: Entry): void {
    if (stopped) return;
    const sessionId = entry.session.sessionId;

    entry.expiryTimer = setTimeout(
      () => expireIfDue(sessionId, true),
      Math.max(0, cfg.handoffTimeoutMs),
    );
    unref(entry.expiryTimer);

    entry.pingTimer = setInterval(
      () => expireIfDue(sessionId, false),
      Math.max(50, cfg.retryPingMs),
    );
    unref(entry.pingTimer);
  }

  function markCleared(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (!entry) return;
    const { session } = entry;
    // Only a still-waiting session can be cleared; ignore double calls and
    // sessions that already expired (the human was simply too late).
    if (!isWaiting(session.state)) return;

    clearTimers(entry);
    session.state = "RESUMED";
    session.resumedAt = Date.now();
    emit(clearedListeners, session);
  }

  function markExpired(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (!entry) return;
    const { session } = entry;
    if (!isWaiting(session.state)) return;

    clearTimers(entry);
    session.state = "EXPIRED";
    session.expiredAt = Date.now();
    emit(expiredListeners, session);
  }

  function open(d: Detection): BlockedSession {
    const detectedAt =
      Number.isFinite(d.detectedAt) && d.detectedAt > 0 ? d.detectedAt : Date.now();

    const session: BlockedSession = {
      sessionId: nextSessionId(),
      site: d.site,
      tabId: d.tabId,
      kind: d.kind,
      confidence: d.confidence,
      evidence: [...d.evidence],
      state: "BLOCKED",
      detectedAt,
    };
    if (d.screenshotPath !== undefined) {
      session.screenshotPath = d.screenshotPath;
    }

    const entry: Entry = { session };
    entries.set(session.sessionId, entry);
    order.push(session.sessionId);

    // BLOCKED is transient: the notify step happens elsewhere, and the
    // agent-visible state while waiting is AWAITING_HUMAN.
    session.state = "AWAITING_HUMAN";
    startTimers(entry);

    return session;
  }

  function list(): BlockedSession[] {
    const out: BlockedSession[] = [];
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const id = order[i];
      if (id === undefined) continue;
      const entry = entries.get(id);
      if (entry) out.push(entry.session);
    }
    return out;
  }

  function get(sessionId: string): BlockedSession | undefined {
    return entries.get(sessionId)?.session;
  }

  function stop(): void {
    stopped = true;
    for (const entry of entries.values()) {
      clearTimers(entry);
    }
  }

  return {
    open,
    onCleared(cb: SessionCallback): void {
      clearedListeners.push(cb);
    },
    onExpired(cb: SessionCallback): void {
      expiredListeners.push(cb);
    },
    list,
    get,
    markCleared,
    markExpired,
    stop,
  };
}
