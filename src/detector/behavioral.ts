// Heuristics that run inside the page when static markers are inconclusive.
import type { Page } from "playwright-core";
import { CHALLENGE_TEXT_PATTERNS } from "./markers.js";

export interface BehavioralSignals {
  submitRetries: number;
  noAdvance: boolean;
  textHits: string[];
  ariaHits: string[];
}

/** Last observed pathname per page, used to detect "the page went nowhere". */
const LAST_PATHNAME = new WeakMap<Page, string>();

interface RawSignals {
  submitRetries: number;
  textHits: string[];
  ariaHits: string[];
  pathname: string;
}

export async function collectBehavioral(page: Page): Promise<BehavioralSignals> {
  const empty: BehavioralSignals = {
    submitRetries: 0,
    noAdvance: false,
    textHits: [],
    ariaHits: [],
  };

  let raw: RawSignals;
  try {
    raw = await page.evaluate((textSources: string[]) => {
      const bodyText = (document.body?.innerText ?? "").toLowerCase();
      const textHits: string[] = [];
      for (const source of textSources) {
        const match = new RegExp(source, "i").exec(bodyText);
        if (match) textHits.push(match[0].trim());
      }

      const ariaHits: string[] = [];
      const checkboxes = Array.from(document.querySelectorAll('[role="checkbox"]'));
      for (const element of checkboxes) {
        const label = element.getAttribute("aria-label") ?? "";
        if (/robot|human|verify/i.test(label)) ariaHits.push(label.trim());
      }

      let submitRetries = 0;
      const submits = Array.from(
        document.querySelectorAll<HTMLElement>(
          'button[type="submit"], input[type="submit"]',
        ),
      );
      for (const element of submits) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0
        ) {
          submitRetries += 1;
        }
      }

      return {
        submitRetries,
        textHits: Array.from(new Set(textHits)),
        ariaHits: Array.from(new Set(ariaHits)),
        pathname: location.pathname,
      };
    }, CHALLENGE_TEXT_PATTERNS.map((pattern) => pattern.source));
  } catch {
    // Page navigated away / closed mid-evaluation.
    return empty;
  }

  const previousPath = LAST_PATHNAME.get(page);
  const noAdvance =
    raw.textHits.length > 0 &&
    previousPath !== undefined &&
    previousPath === raw.pathname;
  LAST_PATHNAME.set(page, raw.pathname);

  return {
    submitRetries: raw.submitRetries,
    noAdvance,
    textHits: raw.textHits,
    ariaHits: raw.ariaHits,
  };
}
