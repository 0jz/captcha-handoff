import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoordinator } from "../src/handoff/coordinator.js";
import { loadConfig } from "../src/config.js";
import type { Config, Detection } from "../src/types.js";

function makeDetection(tabId = "tab-1"): Detection {
  return {
    site: "example.com",
    tabId,
    kind: "recaptcha_v2",
    confidence: 0.9,
    evidence: ["iframe google.com/recaptcha/"],
    detectedAt: Date.now(),
  };
}

describe("handoff coordinator", () => {
  let cfg: Config;

  beforeEach(() => {
    vi.useFakeTimers();
    cfg = { ...loadConfig({}), handoffTimeoutMs: 10_000, retryPingMs: 2_000 };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a session in AWAITING_HUMAN state", () => {
    const c = createCoordinator(cfg);
    const s = c.open(makeDetection());
    expect(s.state).toBe("AWAITING_HUMAN");
    expect(s.sessionId.startsWith("hs_")).toBe(true);
    expect(c.get(s.sessionId)).toBe(s);
    c.stop();
  });

  it("marks cleared and fires onCleared exactly once", () => {
    const c = createCoordinator(cfg);
    const onCleared = vi.fn();
    c.onCleared(onCleared);
    const s = c.open(makeDetection());
    c.markCleared(s.sessionId);
    c.markCleared(s.sessionId); // double call is a no-op
    expect(s.state).toBe("RESUMED");
    expect(s.resumedAt).toBeTypeOf("number");
    expect(onCleared).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it("expires after the timeout and fires onExpired", () => {
    const c = createCoordinator(cfg);
    const onExpired = vi.fn();
    c.onExpired(onExpired);
    const s = c.open(makeDetection());
    vi.advanceTimersByTime(10_001);
    expect(s.state).toBe("EXPIRED");
    expect(onExpired).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it("does not expire a session that already cleared", () => {
    const c = createCoordinator(cfg);
    const onExpired = vi.fn();
    c.onExpired(onExpired);
    const s = c.open(makeDetection());
    c.markCleared(s.sessionId);
    vi.advanceTimersByTime(20_000);
    expect(s.state).toBe("RESUMED");
    expect(onExpired).not.toHaveBeenCalled();
    c.stop();
  });

  it("lists sessions newest-first", () => {
    const c = createCoordinator(cfg);
    const a = c.open(makeDetection("tab-1"));
    const b = c.open(makeDetection("tab-2"));
    expect(c.list().map((s) => s.sessionId)).toEqual([b.sessionId, a.sessionId]);
    c.stop();
  });
});
