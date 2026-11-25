// Automated self-solve module.
//
// Tries to clear a detected CAPTCHA with human-like mouse input. This is
// deliberately best-effort: anything that turns into an image/audio
// challenge is handed back to the human flow. Only called from the
// `solve` tool, never automatically.
import type { Locator, Page } from "playwright-core";

import type { Config } from "../config.js";
import type { Detection, SolveResult } from "../types.js";
import type { HumanizeOptions } from "./human-mouse.js";
import { humanClick, humanDrag, humanMouseMove } from "./human-mouse.js";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

interface Located {
  box: Rect;
  selector: string;
  source: string;
}

interface KindOutcome {
  solved: boolean;
  message: string;
}

type PollOutcome = "solved" | "challenge" | "timeout";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function mouseOptions(cfg: Config): HumanizeOptions {
  return {
    minDelayMs: cfg.solver.stepDelayMs[0],
    maxDelayMs: cfg.solver.stepDelayMs[1],
    overshoot: cfg.solver.overshoot,
  };
}

function centerOf(box: Rect | null): Point | null {
  if (!box) return null;
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y)) return null;
  if (box.width <= 0 || box.height <= 0) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function safeBox(locator: Locator): Promise<Rect | null> {
  try {
    if ((await locator.count()) === 0) return null;
    const box = await locator.first().boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) return null;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  } catch {
    return null;
  }
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  try {
    return await page.locator(selector).first().isVisible();
  } catch {
    return false;
  }
}

async function isTextVisible(page: Page, pattern: RegExp): Promise<boolean> {
  try {
    return await page.getByText(pattern).first().isVisible();
  } catch {
    return false;
  }
}

async function countMatches(page: Page, selector: string): Promise<number> {
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}

async function readToken(
  page: Page,
  selectors: string[],
): Promise<string | null> {
  try {
    return await page.evaluate((sels: string[]): string | null => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const value = (el as HTMLInputElement | HTMLTextAreaElement).value;
        if (typeof value === "string" && value.trim().length > 0) return value;
        const attr = el.getAttribute("value");
        if (attr !== null && attr.trim().length > 0) return attr;
      }
      return null;
    }, selectors);
  } catch {
    return null;
  }
}

async function pollOutcome(
  check: () => Promise<"solved" | "challenge" | null>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<PollOutcome> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    try {
      const result = await check();
      if (result !== null) return result;
    } catch {
      // Transient DOM/navigation errors: keep polling until the deadline.
    }
    if (Date.now() >= deadline) return "timeout";
    await sleep(intervalMs);
  }
}

async function firstLocated(
  page: Page,
  selectors: string[],
): Promise<Located | null> {
  for (const selector of selectors) {
    const box = await safeBox(page.locator(selector));
    if (box) return { box, selector, source: `"${selector}"` };
  }
  return null;
}

async function firstLocatedInFrame(
  page: Page,
  frameSelector: string,
  selectors: string[],
): Promise<Located | null> {
  const frame = page.frameLocator(frameSelector);
  for (const selector of selectors) {
    const box = await safeBox(frame.locator(selector));
    if (box) {
      return {
        box,
        selector,
        source: `iframe "${frameSelector}" -> "${selector}"`,
      };
    }
  }
  return null;
}

/** Widest visible match across the candidate selectors (for slider tracks). */
async function widestLocated(
  page: Page,
  selectors: string[],
): Promise<Located | null> {
  let best: Located | null = null;
  for (const selector of selectors) {
    const locator = page.locator(selector);
    let count = 0;
    try {
      count = await locator.count();
    } catch {
      continue;
    }
    const limit = Math.min(count, 10);
    for (let i = 0; i < limit; i += 1) {
      const box = await safeBox(locator.nth(i));
      if (!box) continue;
      if (!best || box.width > best.box.width) {
        best = { box, selector, source: `"${selector}" [${i}]` };
      }
    }
  }
  return best;
}

async function clickPoint(
  page: Page,
  point: Point,
  cfg: Config,
  actions: string[],
  label: string,
): Promise<void> {
  if (cfg.solver.mouseHumanize) {
    await humanMouseMove(
      page,
      point.x + randomBetween(-8, 8),
      point.y + randomBetween(-8, 8),
      mouseOptions(cfg),
    );
    await humanClick(page, point.x, point.y, mouseOptions(cfg));
  } else {
    await page.mouse.click(point.x, point.y);
  }
  actions.push(
    `clicked ${label} at (${Math.round(point.x)}, ${Math.round(point.y)})`,
  );
}

async function dragPoint(
  page: Page,
  from: Point,
  to: Point,
  cfg: Config,
  actions: string[],
  label: string,
): Promise<void> {
  if (cfg.solver.mouseHumanize) {
    // No overshoot while holding the button: land cleanly on the drop point.
    await humanDrag(page, from, to, { ...mouseOptions(cfg), overshoot: false });
  } else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 24 });
    await page.mouse.up();
  }
  actions.push(
    `dragged ${label} from (${Math.round(from.x)}, ${Math.round(from.y)}) ` +
      `to (${Math.round(to.x)}, ${Math.round(to.y)})`,
  );
}

async function solveRecaptchaV2(
  page: Page,
  cfg: Config,
  actions: string[],
): Promise<KindOutcome> {
  const anchorFrame = 'iframe[src*="recaptcha/api2/anchor"]';
  const challengeFrame = 'iframe[src*="recaptcha/api2/bframe"]';

  let located = await firstLocatedInFrame(page, anchorFrame, [
    ".recaptcha-checkbox",
    "#recaptcha-anchor",
    '[role="checkbox"]',
    ".recaptcha-checkbox-border",
  ]);
  if (!located) {
    located = await firstLocated(page, [
      '[role="checkbox"][aria-label*="robot" i]',
      '[aria-label*="not a robot" i]',
      "#recaptcha-checkbox",
    ]);
  }
  if (!located) {
    return { solved: false, message: "could not find the reCAPTCHA checkbox" };
  }
  actions.push(`located reCAPTCHA checkbox via ${located.source}`);

  const center = centerOf(located.box);
  if (!center) {
    return { solved: false, message: "reCAPTCHA checkbox has no clickable area" };
  }

  const hadChallenge = await isVisible(page, challengeFrame);
  await clickPoint(page, center, cfg, actions, "reCAPTCHA checkbox");

  const tokens = [
    "#g-recaptcha-response",
    'textarea[name="g-recaptcha-response"]',
  ];
  const outcome = await pollOutcome(async () => {
    const token = await readToken(page, tokens);
    if (token !== null) return "solved";
    if (!hadChallenge && (await isVisible(page, challengeFrame))) {
      return "challenge";
    }
    return null;
  }, cfg.solver.clearWaitMs);

  if (outcome === "solved") {
    actions.push("reCAPTCHA response token detected");
    return { solved: true, message: "reCAPTCHA solved (token received)" };
  }
  if (outcome === "challenge") {
    actions.push("reCAPTCHA image challenge became visible");
    return {
      solved: false,
      message: "reCAPTCHA opened an image challenge; handing off to human",
    };
  }
  return {
    solved: false,
    message: "no reCAPTCHA token appeared after clicking the checkbox",
  };
}

async function solveHcaptcha(
  page: Page,
  cfg: Config,
  actions: string[],
): Promise<KindOutcome> {
  const frameSelector = 'iframe[src*="hcaptcha"]';
  const challengeSelector =
    '[class*="challenge-container"], iframe[src*="hcaptcha"][src*="challenge"]';

  let located = await firstLocatedInFrame(page, frameSelector, [
    "#checkbox",
    '[role="checkbox"]',
    ".check",
    "#anchor-state",
  ]);
  if (!located) {
    located = await firstLocated(page, [
      '[role="checkbox"][aria-label*="robot" i]',
      '[aria-label*="human" i]',
      "#hcaptcha-checkbox",
    ]);
  }
  if (!located) {
    return { solved: false, message: "could not find the hCaptcha checkbox" };
  }
  actions.push(`located hCaptcha checkbox via ${located.source}`);

  const center = centerOf(located.box);
  if (!center) {
    return { solved: false, message: "hCaptcha checkbox has no clickable area" };
  }

  const hadChallenge = await isVisible(page, challengeSelector);
  const framesBefore = await countMatches(page, frameSelector);
  await clickPoint(page, center, cfg, actions, "hCaptcha checkbox");

  const tokens = [
    "#h-captcha-response",
    'textarea[name="h-captcha-response"]',
    "#g-recaptcha-response",
    'textarea[name="g-recaptcha-response"]',
  ];
  const outcome = await pollOutcome(async () => {
    const token = await readToken(page, tokens);
    if (token !== null) return "solved";
    if (!hadChallenge) {
      if (await isVisible(page, challengeSelector)) return "challenge";
      const framesNow = await countMatches(page, frameSelector);
      if (framesNow > framesBefore) return "challenge";
    }
    return null;
  }, cfg.solver.clearWaitMs);

  if (outcome === "solved") {
    actions.push("hCaptcha response token detected");
    return { solved: true, message: "hCaptcha solved (token received)" };
  }
  if (outcome === "challenge") {
    actions.push("hCaptcha challenge appeared");
    return {
      solved: false,
      message: "hCaptcha opened a challenge; handing off to human",
    };
  }
  return {
    solved: false,
    message: "no hCaptcha token appeared after clicking the checkbox",
  };
}

async function solveTurnstile(
  page: Page,
  cfg: Config,
  actions: string[],
): Promise<KindOutcome> {
  const frameSelector = 'iframe[src*="challenges.cloudflare.com"]';

  let located = await firstLocatedInFrame(page, frameSelector, [
    "#checkbox",
    'input[type="checkbox"]',
    '[role="checkbox"]',
    ".cb-c",
  ]);
  if (!located) {
    const box = await safeBox(page.locator(frameSelector));
    if (box) {
      located = {
        box,
        selector: frameSelector,
        source: `turnstile iframe "${frameSelector}"`,
      };
    }
  }
  if (!located) {
    return { solved: false, message: "could not find the Turnstile widget" };
  }
  actions.push(`located Turnstile widget via ${located.source}`);

  const center = centerOf(located.box);
  if (!center) {
    return { solved: false, message: "Turnstile widget has no clickable area" };
  }

  await clickPoint(page, center, cfg, actions, "Turnstile widget");

  const tokens = [
    '[name="cf-turnstile-response"]',
    "input#cf-turnstile-response",
    'textarea[name="cf-turnstile-response"]',
  ];
  const outcome = await pollOutcome(async () => {
    const token = await readToken(page, tokens);
    return token !== null ? "solved" : null;
  }, cfg.solver.clearWaitMs);

  if (outcome === "solved") {
    actions.push("Turnstile response token detected");
    return { solved: true, message: "Turnstile solved (token received)" };
  }
  return {
    solved: false,
    message:
      "no Turnstile token appeared after the click; interactive verification needed",
  };
}

async function solveArkose(
  page: Page,
  cfg: Config,
  actions: string[],
): Promise<KindOutcome> {
  const frameSelector = 'iframe[src*="funcaptcha"]';

  let located = await firstLocatedInFrame(page, frameSelector, [
    "#home_children_button",
    "button",
    '[role="button"]',
    ".Button",
  ]);
  if (!located) {
    const box = await safeBox(page.locator(frameSelector));
    if (box) {
      located = {
        box,
        selector: frameSelector,
        source: `arkose iframe "${frameSelector}"`,
      };
    }
  }
  if (!located) {
    return { solved: false, message: "could not find the Arkose widget" };
  }
  actions.push(`located Arkose control via ${located.source}`);

  const center = centerOf(located.box);
  if (!center) {
    return { solved: false, message: "Arkose control has no clickable area" };
  }

  await clickPoint(page, center, cfg, actions, "Arkose primary button");

  const tokens = [
    "#FunCaptcha-Token",
    'input[name="fc-token"]',
    "#fc-token",
    'textarea[name="fc-token"]',
  ];
  const outcome = await pollOutcome(async () => {
    const token = await readToken(page, tokens);
    return token !== null ? "solved" : null;
  }, cfg.solver.clearWaitMs);

  if (outcome === "solved") {
    actions.push("Arkose response token detected");
    return { solved: true, message: "Arkose solved (token received)" };
  }
  return {
    solved: false,
    message: "Arkose challenge could not be completed without human input",
  };
}

async function solveSlider(
  page: Page,
  cfg: Config,
  actions: string[],
): Promise<KindOutcome> {
  const trackSelectors = [
    '[class*="slider-track"]',
    '[class*="slide-track"]',
    '[class*="slider"]',
    '[class*="slide"]',
    '[class*="track"]',
    '[role="slider"]',
  ];
  const handleSelectors = [
    '[role="slider"]',
    '[class*="slider"] [class*="handle"]',
    '[class*="slider"] [class*="btn"]',
    '[class*="slide"] [class*="handle"]',
    '[class*="handle"]',
    '[class*="thumb"]',
  ];
  const promptPattern =
    /press\s*&\s*hold|press\s+and\s+hold|slide\s+to\s+verify|slide\s+right|drag\s+the\s+slider/i;

  const track = await widestLocated(page, trackSelectors);
  if (!track) {
    return { solved: false, message: "could not locate a slider track" };
  }
  actions.push(
    `located slider track via ${track.source} ` +
      `(${Math.round(track.box.width)}x${Math.round(track.box.height)})`,
  );

  const handle = await firstLocated(page, handleSelectors);
  const trackCenter = centerOf(track.box);
  if (!trackCenter) {
    return { solved: false, message: "slider track has no draggable area" };
  }

  const handleCenter = handle ? centerOf(handle.box) : null;
  const start: Point = handleCenter
    ? { x: handleCenter.x, y: handleCenter.y }
    : {
        x: track.box.x + Math.min(18, track.box.width * 0.06),
        y: trackCenter.y,
      };
  // Drop just inside the right edge of the track.
  const end: Point = {
    x: track.box.x + track.box.width - 3,
    y: start.y,
  };
  if (handle) {
    actions.push(`located slider handle via ${handle.source}`);
  } else {
    actions.push("slider handle not found; assuming it rests at the left edge");
  }

  const hadPrompt = await isTextVisible(page, promptPattern);
  const trackSelector = track.selector;
  await dragPoint(page, start, end, cfg, actions, "slider handle");

  const outcome = await pollOutcome(async () => {
    if (hadPrompt) {
      if (!(await isTextVisible(page, promptPattern))) return "solved";
      return null;
    }
    if (!(await isVisible(page, trackSelector))) return "solved";
    if (
      await isVisible(
        page,
        '[class*="slider-success"], [class*="success-icon"], [class*="verified"]',
      )
    ) {
      return "solved";
    }
    return null;
  }, cfg.solver.clearWaitMs);

  if (outcome === "solved") {
    actions.push("slider challenge cleared");
    return { solved: true, message: "slider CAPTCHA cleared" };
  }
  return {
    solved: false,
    message: "slider challenge did not clear after the drag",
  };
}

async function solveUnknown(
  page: Page,
  cfg: Config,
  actions: string[],
): Promise<KindOutcome> {
  const selectors = [
    '[role="checkbox"][aria-label*="robot" i]',
    '[aria-label*="human" i]',
    'button:has-text("Verify")',
    'button:has-text("I am human")',
    'button:has-text("Continue")',
  ];
  const challengePattern =
    /not a robot|verify (?:you are|that you are) human|are you a robot|captcha|challenge/i;

  const located = await firstLocated(page, selectors);
  if (!located) {
    return {
      solved: false,
      message: "no known challenge control found on the page",
    };
  }
  actions.push(`located challenge control via ${located.source}`);

  const center = centerOf(located.box);
  if (!center) {
    return { solved: false, message: "challenge control has no clickable area" };
  }

  const hadText = await isTextVisible(page, challengePattern);
  await clickPoint(page, center, cfg, actions, "challenge control");
  const clickedSelector = located.selector;

  const outcome = await pollOutcome(async () => {
    if (!(await isVisible(page, clickedSelector))) return "solved";
    if (hadText && !(await isTextVisible(page, challengePattern))) {
      return "solved";
    }
    return null;
  }, cfg.solver.clearWaitMs);

  if (outcome === "solved") {
    actions.push("challenge control disappeared");
    return { solved: true, message: "challenge appears to be cleared" };
  }
  return {
    solved: false,
    message: "challenge did not clear after the click; handing off to human",
  };
}

export async function attemptSolve(
  page: Page,
  detection: Detection,
  cfg: Config,
): Promise<SolveResult> {
  const actions: string[] = [];

  if (!cfg.solver.enabled) {
    return {
      attempted: false,
      solved: false,
      kind: detection.kind,
      actions,
      message: "solver disabled",
      fallback: "human",
    };
  }

  try {
    actions.push(`attempting self-solve for ${detection.kind}`);
    let outcome: KindOutcome;

    switch (detection.kind) {
      case "recaptcha_v2":
        outcome = await solveRecaptchaV2(page, cfg, actions);
        break;
      case "recaptcha_v3":
        outcome = {
          solved: false,
          message:
            "reCAPTCHA v3 is invisible and score-based; it cannot be clicked through",
        };
        break;
      case "hcaptcha":
        outcome = await solveHcaptcha(page, cfg, actions);
        break;
      case "turnstile":
        outcome = await solveTurnstile(page, cfg, actions);
        break;
      case "arkose":
        outcome = await solveArkose(page, cfg, actions);
        break;
      case "slider":
        outcome = await solveSlider(page, cfg, actions);
        break;
      default:
        outcome = await solveUnknown(page, cfg, actions);
        break;
    }

    if (outcome.solved) {
      actions.push("verification token/clearance found");
      return {
        attempted: true,
        solved: true,
        kind: detection.kind,
        actions,
        message: outcome.message,
        fallback: "none",
      };
    }

    actions.push("no verification token/clearance found");
    return {
      attempted: true,
      solved: false,
      kind: detection.kind,
      actions,
      message: outcome.message,
      fallback: "human",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    actions.push(`error: ${message}`);
    return {
      attempted: true,
      solved: false,
      kind: detection.kind,
      actions,
      message: `solver failed: ${message}`,
      fallback: "human",
    };
  }
}
