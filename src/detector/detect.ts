// Combines static markers with behavioral signals into a Detection.
import { getDomain } from "tldts";
import { collectBehavioral } from "./behavioral.js";
import { matchMarkers } from "./markers.js";
import type { Config } from "../config.js";
import type { CaptchaKind, Detection } from "../types.js";
import type { Page } from "playwright-core";

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function siteForUrl(url: string): string {
  try {
    const domain = getDomain(url);
    if (domain) return domain;
  } catch {
    // Fall through to the raw URL.
  }
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function confidenceForWeight(weight: number, kind: CaptchaKind): number {
  const base = clamp01(weight >= 2 ? 0.9 : 0.6);
  // Invisible challenges (v3, Turnstile) can only be confirmed by the
  // behavioral pass, so cap their confidence below visible-widget detections.
  if (kind === "recaptcha_v3" || kind === "turnstile") {
    return Math.min(base, 0.7);
  }
  return base;
}

/** Best-effort label for a behavioral hint (text or aria-label). */
function kindFromHint(hint: string): CaptchaKind {
  const value = hint.toLowerCase();
  if (/press & hold|complete the puzzle|slide to|slider|puzzle/.test(value)) {
    return "slider";
  }
  if (/security check|cloudflare|turnstile/.test(value)) return "turnstile";
  if (/verify you are human/.test(value)) return "recaptcha_v2";
  if (/are you a robot/.test(value)) return "hcaptcha";
  if (/not a robot|not a bot|prove you/.test(value)) return "recaptcha_v2";
  return "unknown";
}

export function detectFromHtml(
  html: string,
  url: string,
  tabId: string,
): Detection | null {
  const markers = matchMarkers(html, url);
  if (markers.weight <= 0) return null;

  return {
    site: siteForUrl(url),
    tabId,
    kind: markers.kind,
    confidence: confidenceForWeight(markers.weight, markers.kind),
    evidence: markers.evidence,
    detectedAt: Date.now(),
  };
}

export async function detectOnPage(
  page: Page,
  tabId: string,
  cfg: Config,
): Promise<Detection | null> {
  let url = "";
  try {
    url = page.url();
  } catch {
    url = "";
  }

  let html = "";
  try {
    html = await page.content();
  } catch {
    html = "";
  }

  const fromHtml = detectFromHtml(html, url, tabId);
  if (fromHtml) return fromHtml;

  // cfg is reserved for tuning thresholds / screenshot behaviour.
  void cfg;

  const signals = await collectBehavioral(page);
  if (signals.textHits.length === 0 && signals.ariaHits.length === 0) {
    return null;
  }

  const evidence: string[] = [
    ...signals.textHits.map((hit) => `text: '${hit}'`),
    ...signals.ariaHits.map((hit) => `aria: '${hit}'`),
  ];
  if (signals.noAdvance) evidence.push("behavioral: no navigation advance");
  if (signals.submitRetries > 0) {
    evidence.push(`behavioral: ${signals.submitRetries} visible submit control(s)`);
  }

  const hint = signals.textHits[0] ?? signals.ariaHits[0] ?? "";

  return {
    site: siteForUrl(url),
    tabId,
    kind: kindFromHint(hint),
    confidence: 0.5,
    evidence,
    detectedAt: Date.now(),
  };
}
