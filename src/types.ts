// Shared types for captcha-handoff.
// Every module imports from here so interfaces stay consistent.

export type CaptchaKind =
  | "recaptcha_v2"
  | "recaptcha_v3"
  | "turnstile"
  | "hcaptcha"
  | "arkose"
  | "slider"
  | "unknown";

/** A browser tab (CDP target). */
export interface Tab {
  /** CDP target id. */
  id: string;
  url?: string;
  title?: string;
}

/** Result of the detector running against a page. */
export interface Detection {
  /** Registrable domain, via tldts. */
  site: string;
  /** CDP target id. */
  tabId: string;
  kind: CaptchaKind;
  /** 0..1 */
  confidence: number;
  /** Human-readable matched markers. */
  evidence: string[];
  /** Absolute path to a screenshot captured at detection time (may be undefined). */
  screenshotPath?: string;
  /** Raw PNG captured at detection time (may be undefined). */
  screenshot?: Buffer;
  detectedAt: number;
}

export type HandoffState =
  | "BLOCKED"
  | "AWAITING_HUMAN"
  | "RESUMED"
  | "EXPIRED";

export interface BlockedSession {
  sessionId: string;
  site: string;
  tabId: string;
  kind: CaptchaKind;
  confidence: number;
  evidence: string[];
  state: HandoffState;
  detectedAt: number;
  screenshotPath?: string;
  resumedAt?: number;
  expiredAt?: number;
}

/** AEAD-encrypted blob (aes-256-gcm). All fields base64 strings. */
export interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
  alg: "aes-256-gcm";
}

export interface JarEntry {
  /** Registrable domain. */
  site: string;
  savedAt: number;
  /** Min cookie expiry, capped at 30 days. */
  expiresHint: number;
  cookies: EncryptedBlob;
  localStorage: EncryptedBlob;
  origin: string;
}

/** Result of an automated solve attempt. */
export interface SolveResult {
  attempted: boolean;
  solved: boolean;
  kind: CaptchaKind;
  /** Human-readable list of actions the solver took. */
  actions: string[];
  message: string;
  /** What to do next if not solved. */
  fallback: "human" | "none";
}

/** A lightweight logging helper shared across modules. */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}
