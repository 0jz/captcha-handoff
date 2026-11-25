// Human-like mouse movement: cubic bezier paths + hand-tremor jitter +
// variable speed + optional overshoot. Used by the self-solve module so
// synthetic input looks less robotic to CAPTCHA heuristics.
import type { Page } from "playwright-core";

export interface HumanizeOptions {
  /** Number of interpolation points (default derived from distance). */
  steps?: number;
  /** Minimum delay between mouse steps, in ms. Default 3. */
  minDelayMs?: number;
  /** Maximum delay between mouse steps, in ms. Default 14. */
  maxDelayMs?: number;
  /** Perpendicular hand-tremor noise in px. Default 1.5. */
  jitter?: number;
  /** Whether to overshoot slightly past the target before settling. Default true. */
  overshoot?: boolean;
}

interface Point {
  x: number;
  y: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Last known cursor position, shared across calls (unknown until first move). */
let lastPos: Point | null = null;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomInt(min: number, max: number): number {
  return Math.floor(randomBetween(min, max + 1));
}

function cubicBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number,
): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

export async function humanMouseMove(
  page: Page,
  toX: number,
  toY: number,
  opts: HumanizeOptions = {},
): Promise<void> {
  const minDelayMs = Math.max(0, opts.minDelayMs ?? 3);
  const maxDelayMs = Math.max(minDelayMs, opts.maxDelayMs ?? 14);
  const jitter = Math.max(0, opts.jitter ?? 1.5);
  const useOvershoot = opts.overshoot ?? true;

  const start: Point = lastPos ?? {
    x: randomBetween(20, 220),
    y: randomBetween(20, 140),
  };
  const target: Point = { x: toX, y: toY };

  const viewport = page.viewportSize();
  const maxX = viewport ? Math.max(0, viewport.width - 1) : Number.POSITIVE_INFINITY;
  const maxY = viewport ? Math.max(0, viewport.height - 1) : Number.POSITIVE_INFINITY;
  const fit = (p: Point): Point => ({
    x: clamp(p.x, 0, maxX),
    y: clamp(p.y, 0, maxY),
  });

  const dx = toX - start.x;
  const dy = toY - start.y;
  const distance = Math.hypot(dx, dy);

  if (distance < 2) {
    const p = fit(target);
    await page.mouse.move(p.x, p.y);
    lastPos = target;
    return;
  }

  // Cubic bezier: bow the straight line sideways by a random amount.
  const sampleCount = Math.max(
    2,
    Math.trunc(opts.steps ?? clamp(Math.round(distance / 8), 12, 60)),
  );
  const perpX = -dy / distance;
  const perpY = dx / distance;
  const bend = distance * 0.25;
  const t1 = randomBetween(0.3, 0.5);
  const t2 = randomBetween(0.55, 0.75);
  const bow1 = randomBetween(-bend, bend);
  const bow2 = randomBetween(-bend, bend);

  const p0: Point = start;
  const p1: Point = {
    x: p0.x + dx * t1 + perpX * bow1,
    y: p0.y + dy * t1 + perpY * bow1,
  };
  const p2: Point = {
    x: p0.x + dx * t2 + perpX * bow2,
    y: p0.y + dy * t2 + perpY * bow2,
  };
  const p3: Point = target;

  // Ease-in-out sampling: slow at the ends, fast in the middle.
  const points: Point[] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const raw = i / (sampleCount - 1);
    const t = 0.5 - 0.5 * Math.cos(Math.PI * raw);
    const point = cubicBezier(p0, p1, p2, p3, t);
    const isLast = i === sampleCount - 1;
    if (jitter > 0 && !isLast) {
      const tremor = (Math.random() - 0.5) * 2 * jitter;
      point.x += perpX * tremor;
      point.y += perpY * tremor;
    }
    points.push(fit(point));
  }

  // Overshoot past the target, then settle back exactly on it.
  if (useOvershoot) {
    const last = points[points.length - 1];
    const vx = toX - last.x;
    const vy = toY - last.y;
    const length = Math.hypot(vx, vy);
    if (length > 0.5) {
      const ux = vx / length;
      const uy = vy / length;
      const beyond = randomBetween(4, 9);
      const count = randomInt(1, 2);
      for (let k = 1; k <= count; k += 1) {
        const step = beyond * (1 - (k - 1) * 0.35);
        points.push(fit({ x: toX + ux * step, y: toY + uy * step }));
      }
    }
  }

  points.push(fit(target));

  for (const point of points) {
    await page.mouse.move(Math.round(point.x), Math.round(point.y));
    await sleep(randomBetween(minDelayMs, maxDelayMs));
  }

  lastPos = target;
}

export async function humanClick(
  page: Page,
  x: number,
  y: number,
  opts: HumanizeOptions = {},
): Promise<void> {
  await humanMouseMove(page, x, y, opts);
  await sleep(randomBetween(40, 120));
  await page.mouse.down();
  await sleep(randomBetween(40, 110));
  await page.mouse.up();
  await sleep(randomBetween(30, 80));
}

export async function humanDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: HumanizeOptions = {},
): Promise<void> {
  await humanMouseMove(page, from.x, from.y, opts);
  await sleep(randomBetween(60, 160));
  await page.mouse.down();
  await sleep(randomBetween(40, 120));
  // humanMouseMove reads the module-level cursor position, so the drag
  // path is a bezier from the grab point to the drop point.
  await humanMouseMove(page, to.x, to.y, opts);
  await sleep(randomBetween(50, 130));
  await page.mouse.up();
  await sleep(randomBetween(30, 90));
}
