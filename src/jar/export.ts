// Export a verified browser session into the jar, and inject it back before a
// later navigation. Cookies and localStorage are always encrypted before they
// leave this module.
import type { Cookie, Page } from "playwright-core";
import { getDomain } from "tldts";
import type { Config } from "../config.js";
import type { EncryptedBlob, JarEntry } from "../types.js";
import { decrypt, encrypt } from "./keychain.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ORIGIN = "captcha-handoff v0.1";

/** Cookie shape as stored inside the encrypted blob. */
interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix time in seconds; <= 0 for session cookies. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

type SameSite = "Strict" | "Lax" | "None";

function registrableDomain(input: string): string {
  const domain = getDomain(input);
  if (domain) return domain.toLowerCase();
  return input
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "");
}

/** True when `domain` is the site itself or a subdomain of it. */
function domainBelongsToSite(domain: string, site: string): boolean {
  const normalized = domain
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "");
  if (!normalized || !site) return false;
  return (
    normalized === site ||
    normalized.endsWith(`.${site}`) ||
    getDomain(normalized) === site
  );
}

function normalizeSameSite(value: unknown): SameSite | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.toLowerCase()) {
    case "strict":
      return "Strict";
    case "lax":
      return "Lax";
    case "none":
      return "None";
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Playwright cookie expiries are seconds; tolerate ms values defensively. */
function toUnixSeconds(expires: number): number {
  if (!Number.isFinite(expires) || expires <= 0) return -1;
  return expires > 1e12 ? Math.floor(expires / 1000) : Math.floor(expires);
}

function toStoredCookie(cookie: Cookie): StoredCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: normalizeSameSite(cookie.sameSite),
  };
}

function parseStoredCookie(value: unknown): StoredCookie | undefined {
  if (!isRecord(value)) return undefined;
  const { name, value: cookieValue, domain, path } = value;
  if (
    typeof name !== "string" ||
    typeof cookieValue !== "string" ||
    typeof domain !== "string" ||
    typeof path !== "string"
  ) {
    return undefined;
  }

  return {
    name,
    value: cookieValue,
    domain,
    path,
    expires: typeof value.expires === "number" ? value.expires : -1,
    httpOnly: value.httpOnly === true,
    secure: value.secure === true,
    sameSite: normalizeSameSite(value.sameSite),
  };
}

async function decryptCookies(blob: EncryptedBlob): Promise<StoredCookie[]> {
  const plain = await decrypt(blob);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new Error("Jar entry cookies are not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Jar entry cookies are not an array");
  }
  return parsed
    .map(parseStoredCookie)
    .filter((cookie): cookie is StoredCookie => cookie !== undefined);
}

async function decryptLocalStorage(
  blob: EncryptedBlob,
): Promise<Record<string, string>> {
  const plain = await decrypt(blob);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain.toString("utf8"));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};

  const storage: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      storage[key] = value;
    } else if (value !== null && value !== undefined) {
      storage[key] = String(value);
    }
  }
  return storage;
}

function pageUrl(page: Page): string | undefined {
  try {
    const url = page.url();
    return url && url !== "about:blank" ? url : undefined;
  } catch {
    return undefined;
  }
}

function urlBelongsToSite(url: string, site: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return domainBelongsToSite(hostname, registrableDomain(site));
  } catch {
    return true; // Unknown URL shape: best effort, let evaluate() decide.
  }
}

/**
 * Capture the cookies (scoped to the site's registrable domain) and the
 * current page origin's localStorage, encrypt them, and return a jar entry.
 */
export async function exportSession(
  page: Page,
  site: string,
  cfg: Config,
): Promise<JarEntry> {
  const target = registrableDomain(site);
  const context = page.context();

  const allCookies = await context.cookies();
  const scopedCookies = allCookies.filter((cookie) =>
    domainBelongsToSite(cookie.domain, target),
  );
  const storedCookies = scopedCookies.map(toStoredCookie);

  // Cross-origin/opaque pages make localStorage access throw; that is fine.
  let localStorageJson = "{}";
  try {
    const raw: unknown = await page.evaluate(() =>
      JSON.stringify({ ...window.localStorage }),
    );
    if (typeof raw === "string" && raw.length > 0) {
      localStorageJson = raw;
    } else if (isRecord(raw)) {
      localStorageJson = JSON.stringify(raw);
    }
  } catch {
    // localStorage unavailable (about:blank, sandboxed frame, ...).
  }

  const cookies = await encrypt(
    Buffer.from(JSON.stringify(storedCookies), "utf8"),
  );
  const localStorage = await encrypt(Buffer.from(localStorageJson, "utf8"));

  const now = Date.now();
  const cookieExpiries = storedCookies
    .map((cookie) => cookie.expires)
    .filter((expires) => Number.isFinite(expires) && expires > 0)
    // Normalize to milliseconds before comparing (seconds on the wire).
    .map((expires) => (expires > 1e12 ? expires : expires * 1000));

  const fallbackExpiry = now + SEVEN_DAYS_MS;
  const minCookieExpiry =
    cookieExpiries.length > 0 ? Math.min(...cookieExpiries) : fallbackExpiry;
  const expiresHint = Math.min(now + cfg.jarExpiryCapMs, minCookieExpiry);

  return {
    site: target,
    savedAt: now,
    expiresHint,
    cookies,
    localStorage,
    origin: ORIGIN,
  };
}

/**
 * Decrypt a jar entry and restore its cookies (and, when we are on the right
 * origin, its localStorage) into the page's browser context.
 */
export async function injectSession(
  page: Page,
  entry: JarEntry,
): Promise<void> {
  const context = page.context();

  const cookies = await decryptCookies(entry.cookies);
  if (cookies.length > 0) {
    await context.addCookies(
      cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: toUnixSeconds(cookie.expires),
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      })),
    );
  }

  const storage = await decryptLocalStorage(entry.localStorage);
  if (Object.keys(storage).length === 0) return;

  const currentUrl = pageUrl(page);
  if (currentUrl && !urlBelongsToSite(currentUrl, entry.site)) return;

  // localStorage is origin-bound; injection is intentionally best effort.
  try {
    await page.evaluate((items: Record<string, string>) => {
      for (const [name, value] of Object.entries(items)) {
        try {
          window.localStorage.setItem(name, value);
        } catch {
          // Storage disabled or quota exceeded: skip this key.
        }
      }
    }, storage);
  } catch {
    // Page is not on a usable origin (about:blank, cross-origin, closed).
  }
}
