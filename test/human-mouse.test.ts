import { describe, expect, it } from "vitest";
import type { Page } from "playwright-core";
import {
  humanClick,
  humanDrag,
  humanMouseMove,
} from "../src/solver/human-mouse.js";

interface MoveCall {
  x: number;
  y: number;
}

function makeMockPage() {
  const moves: MoveCall[] = [];
  let downs = 0;
  let ups = 0;

  const page = {
    mouse: {
      move: async (x: number, y: number) => {
        moves.push({ x, y });
      },
      down: async () => {
        downs += 1;
      },
      up: async () => {
        ups += 1;
      },
    },
    viewportSize: () => ({ width: 1280, height: 720 }),
  };

  return { page: page as unknown as Page, moves: () => moves, counts: () => ({ downs, ups }) };
}

describe("human-like mouse movement", () => {
  it("moves through multiple interpolated points and ends on target", async () => {
    const { page, moves } = makeMockPage();
    await humanMouseMove(page, 600, 400, { steps: 40, minDelayMs: 0, maxDelayMs: 0, overshoot: false });

    const calls = moves();
    expect(calls.length).toBeGreaterThan(10); // plenty of interpolation steps
    const last = calls[calls.length - 1];
    expect(last.x).toBe(600);
    expect(last.y).toBe(400);
  });

  it("keeps every point inside the viewport", async () => {
    const { page, moves } = makeMockPage();
    await humanMouseMove(page, 1279, 719, { steps: 60, minDelayMs: 0, maxDelayMs: 0 });
    for (const call of moves()) {
      expect(call.x).toBeGreaterThanOrEqual(0);
      expect(call.x).toBeLessThanOrEqual(1279);
      expect(call.y).toBeGreaterThanOrEqual(0);
      expect(call.y).toBeLessThanOrEqual(719);
    }
  });

  it("produces a balanced press/release for a click", async () => {
    const { page, counts } = makeMockPage();
    await humanClick(page, 300, 300, { minDelayMs: 0, maxDelayMs: 0 });
    expect(counts()).toEqual({ downs: 1, ups: 1 });
  });

  it("produces a balanced press/release for a drag", async () => {
    const { page, counts } = makeMockPage();
    await humanDrag(page, { x: 100, y: 100 }, { x: 500, y: 100 }, { minDelayMs: 0, maxDelayMs: 0 });
    expect(counts()).toEqual({ downs: 1, ups: 1 });
  });
});
