// Static CAPTCHA fingerprints. Each rule contributes weight when any of its
// markers is present in the page HTML or URL.
import type { CaptchaKind } from "../types.js";

export interface MarkerRule {
  kind: CaptchaKind;
  /** Base weight for a marker hit. */
  weight: number;
  iframePatterns: RegExp[];
  /** Substring matches on the class attribute (and raw HTML). */
  classNames: string[];
  selectors: string[];
  scriptHosts: RegExp[];
  /** Case-insensitive text heuristics. */
  textPatterns: RegExp[];
}

const SHARED_UNKNOWN_TEXT: RegExp[] = [
  /prove you(?:'|’)?re not a bot/i,
  /are you a robot/i,
  /verify you are human/i,
];

export const MARKERS: MarkerRule[] = [
  {
    kind: "recaptcha_v2",
    weight: 2,
    iframePatterns: [/google\.com\/recaptcha\//i, /recaptcha\/api2\/anchor/i],
    classNames: ["g-recaptcha"],
    selectors: ["#g-recaptcha", ".g-recaptcha"],
    scriptHosts: [/google\.com\/recaptcha\/api\.js/i, /gstatic\.com\/recaptcha\//i],
    textPatterns: [/verify you are human/i],
  },
  {
    kind: "recaptcha_v3",
    weight: 0.8,
    iframePatterns: [/recaptcha\/api2\/bframe/i],
    classNames: ["grecaptcha"],
    selectors: [".grecaptcha-badge"],
    scriptHosts: [/grecaptcha\.execute/i, /recaptcha\/api\.js\?render=/i],
    textPatterns: [],
  },
  {
    kind: "turnstile",
    weight: 1,
    iframePatterns: [/challenges\.cloudflare\.com/i, /turnstile/i],
    classNames: ["cf-turnstile", "cf-chl-widget"],
    selectors: ["#cf-turnstile", ".cf-turnstile"],
    scriptHosts: [/challenges\.cloudflare\.com\/turnstile/i],
    textPatterns: [/security check/i, /verify you are human/i],
  },
  {
    kind: "hcaptcha",
    weight: 2,
    iframePatterns: [/hcaptcha\.com\/iframe/i, /hcaptcha\.com\/captcha/i],
    classNames: ["h-captcha"],
    selectors: ["#h-captcha", ".h-captcha"],
    scriptHosts: [/hcaptcha\.com\/1\/api\.js/i],
    textPatterns: [/are you a robot/i, /verify you are human/i],
  },
  {
    kind: "arkose",
    weight: 1.5,
    iframePatterns: [/funcaptcha\.com/i, /arkoselabs/i],
    classNames: ["arkose", "funcaptcha"],
    selectors: ["#funcaptcha", "#arkose"],
    scriptHosts: [/funcaptcha\.com/i, /arkoselabs\.com/i],
    textPatterns: [],
  },
  {
    kind: "slider",
    weight: 1,
    iframePatterns: [],
    classNames: ["slider-captcha", "puzzle-slider", "geetest"],
    selectors: ["#geetest", ".geetest_slider"],
    scriptHosts: [/geetest\.com/i],
    textPatterns: [/press & hold/i, /complete the puzzle/i, /slide to/i],
  },
  {
    kind: "unknown",
    weight: 0.5,
    iframePatterns: [],
    classNames: [],
    selectors: [],
    scriptHosts: [],
    textPatterns: SHARED_UNKNOWN_TEXT,
  },
];

/** Text heuristics shared with the behavioral detector. */
export const CHALLENGE_TEXT_PATTERNS: RegExp[] = Array.from(
  new Set(MARKERS.flatMap((rule) => rule.textPatterns.map((p) => p.source))),
).map((source) => new RegExp(source, "i"));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Rough check for simple "#id" / ".class" selectors without a DOM. */
function selectorMatches(html: string, selector: string): boolean {
  const match = /^([#.])(.+)$/.exec(selector);
  if (!match) return html.includes(selector);
  const [, prefix, name] = match;
  const escaped = escapeRegExp(name);

  if (prefix === "#") {
    return new RegExp(`id\\s*=\\s*["']?${escaped}(?:["'\\s>])`, "i").test(html);
  }

  const classAttr = /class\s*=\s*["']([^"']*)["']/gi;
  let found: RegExpExecArray | null;
  while ((found = classAttr.exec(html)) !== null) {
    if (found[1].split(/\s+/).includes(name)) return true;
  }
  return false;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function extractIframeSrcs(html: string): string[] {
  const srcs: string[] = [];
  const iframeTag = /<iframe\b[^>]*>/gi;
  const srcAttr = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
  let tag: RegExpExecArray | null;
  while ((tag = iframeTag.exec(html)) !== null) {
    const match = srcAttr.exec(tag[0]);
    const src = match?.[1] ?? match?.[2] ?? match?.[3];
    if (src) srcs.push(decodeEntities(src));
  }
  return srcs;
}

/** Visible-ish text: drop script/style bodies and all tags. */
function extractText(html: string): string {
  const stripped = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

export function matchMarkers(
  html: string,
  url: string,
): { kind: CaptchaKind; weight: number; evidence: string[] } {
  const haystack = html.toLowerCase();
  const text = extractText(html).toLowerCase();
  const iframeSrcs = extractIframeSrcs(html);
  const evidence: string[] = [];
  const counted = new Set<string>();
  const evidenceSeen = new Set<string>();

  let bestKind: CaptchaKind = "unknown";
  let bestWeight = 0;
  let totalWeight = 0;

  const record = (rule: MarkerRule, label: string, factor = 1): number => {
    const key = `${rule.kind}|${label}`;
    if (counted.has(key)) return 0;
    counted.add(key);
    if (!evidenceSeen.has(label)) {
      evidenceSeen.add(label);
      evidence.push(label);
    }
    return rule.weight * factor;
  };

  for (const rule of MARKERS) {
    let ruleWeight = 0;

    // iframePatterns only look at real iframe src values (plus the page URL),
    // never at script URLs that happen to share the host path.
    for (const pattern of rule.iframePatterns) {
      const inIframe = iframeSrcs.some((src) => pattern.test(src));
      if (inIframe || pattern.test(url)) {
        ruleWeight += record(rule, `iframe ${pattern.source}`);
      }
    }

    for (const className of rule.classNames) {
      if (haystack.includes(className.toLowerCase())) {
        ruleWeight += record(rule, `class ${className}`);
      }
    }

    for (const selector of rule.selectors) {
      if (selectorMatches(html, selector)) {
        ruleWeight += record(rule, `selector ${selector}`);
      }
    }

    for (const pattern of rule.scriptHosts) {
      if (pattern.test(html)) {
        ruleWeight += record(rule, `script ${pattern.source}`);
      } else if (pattern.test(url)) {
        ruleWeight += record(rule, `url ${pattern.source}`);
      }
    }

    // Text alone is weaker evidence than a concrete widget marker, so a
    // shared phrase like "verify you are human" cannot outvote a real iframe.
    for (const pattern of rule.textPatterns) {
      const match = pattern.exec(text);
      if (match) {
        ruleWeight += record(rule, `text: '${match[0].trim()}'`, 0.5);
      }
    }

    totalWeight += ruleWeight;
    if (ruleWeight > bestWeight) {
      bestWeight = ruleWeight;
      bestKind = rule.kind;
    }
  }

  return { kind: bestKind, weight: totalWeight, evidence };
}
