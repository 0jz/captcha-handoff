// Central configuration. Values come from env vars with sane defaults.
import os from "node:os";
import path from "node:path";

export interface SolverConfig {
  /** Master switch for the self-solve feature. */
  enabled: boolean;
  /** Whether to humanize mouse movement (bezier + jitter + variable speed). */
  mouseHumanize: boolean;
  /** Min/max delay between mouse steps, in ms. */
  stepDelayMs: [number, number];
  /** Whether to overshoot slightly past the target before settling. */
  overshoot: boolean;
  /** How long to wait (ms) for a click to clear a challenge before giving up. */
  clearWaitMs: number;
}

export interface NotifyConfig {
  enabled: boolean;
  /** Optional webhook URL for remote handoff (POST {site, screenshotBase64, tabId}). */
  webhookUrl?: string;
  /** Window (ms) in which notifications are batched together. */
  batchWindowMs: number;
}

export interface Config {
  chromeDebugPort: number;
  /** Persistent Chrome profile dir. */
  userDataDir: string;
  headless: boolean;
  /** Timeout (ms) for the AWAITING_HUMAN state before EXPIRED. */
  handoffTimeoutMs: number;
  /** Interval (ms) between expiry pings. */
  retryPingMs: number;
  /** Debounce (ms) for cleared detection. */
  clearDebounceMs: number;
  /** Directory for temporary screenshots. */
  screenshotDir: string;
  /** Screenshots older than this are cleaned (ms). */
  screenshotTtlMs: number;
  /** Directory for the encrypted session jar. */
  jarDir: string;
  /** Cap on jar expiry (ms), default 30 days. */
  jarExpiryCapMs: number;
  notify: NotifyConfig;
  solver: SolverConfig;
  logLevel: "debug" | "info" | "warn" | "error";
}

const DEFAULT_PROFILE_DIR = path.join(
  os.homedir(),
  ".captcha-handoff",
  "chrome-profile",
);
const DEFAULT_JAR_DIR = path.join(os.homedir(), ".captcha-handoff", "jar");
const DEFAULT_SCREENSHOT_DIR = path.join(os.tmpdir(), "opencode", "handoff");

function toBool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function toInt(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : dflt;
}

function toPair(v: string | undefined, dflt: [number, number]): [number, number] {
  if (!v) return dflt;
  const [a, b] = v.split(",").map((x) => Number(x.trim()));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return dflt;
  return [a, b];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    chromeDebugPort: toInt(env.CH_CHROME_DEBUG_PORT, 9222),
    userDataDir: env.CH_USER_DATA_DIR ?? DEFAULT_PROFILE_DIR,
    headless: toBool(env.CH_HEADLESS, false),
    handoffTimeoutMs: toInt(env.CH_HANDOFF_TIMEOUT_MS, 10 * 60 * 1000),
    retryPingMs: toInt(env.CH_RETRY_PING_MS, 2 * 60 * 1000),
    clearDebounceMs: toInt(env.CH_CLEAR_DEBOUNCE_MS, 3000),
    screenshotDir: env.CH_SCREENSHOT_DIR ?? DEFAULT_SCREENSHOT_DIR,
    screenshotTtlMs: toInt(env.CH_SCREENSHOT_TTL_MS, 24 * 60 * 60 * 1000),
    jarDir: env.CH_JAR_DIR ?? DEFAULT_JAR_DIR,
    jarExpiryCapMs: toInt(env.CH_JAR_EXPIRY_CAP_MS, 30 * 24 * 60 * 60 * 1000),
    notify: {
      enabled: toBool(env.CH_NOTIFY_ENABLED, true),
      webhookUrl: env.CH_NOTIFY_WEBHOOK_URL,
      batchWindowMs: toInt(env.CH_NOTIFY_BATCH_WINDOW_MS, 3000),
    },
    solver: {
      enabled: toBool(env.CH_SOLVER_ENABLED, true),
      mouseHumanize: toBool(env.CH_SOLVER_MOUSE_HUMANIZE, true),
      stepDelayMs: toPair(env.CH_SOLVER_STEP_DELAY_MS, [3, 14]),
      overshoot: toBool(env.CH_SOLVER_OVERSHOOT, true),
      clearWaitMs: toInt(env.CH_SOLVER_CLEAR_WAIT_MS, 2500),
    },
    logLevel: (env.CH_LOG_LEVEL as Config["logLevel"]) ?? "info",
  };
}

export const config = loadConfig();
