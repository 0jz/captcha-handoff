import { describe, expect, it } from "vitest";
import { detectFromHtml } from "../src/detector/detect.js";

const RECAPTCHA_V2 = `
<html><body>
  <div class="g-recaptcha" id="g-recaptcha" data-sitekey="fake"></div>
  <iframe src="https://www.google.com/recaptcha/api2/anchor?k=fake"></iframe>
  <p>verify you are human</p>
</body></html>`;

const RECAPTCHA_V3 = `
<html><body>
  <script src="https://www.google.com/recaptcha/api.js?render=fake"></script>
  <script>grecaptcha.execute("fake", {action: "submit"})</script>
</body></html>`;

const TURNSTILE = `
<html><body>
  <div class="cf-turnstile" id="cf-turnstile"></div>
  <iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/fake"></iframe>
  <p>security check</p>
</body></html>`;

const HCAPTCHA = `
<html><body>
  <div class="h-captcha" id="h-captcha"></div>
  <iframe src="https://newassets.hcaptcha.com/captcha/v1/fake/static/hcaptcha.html"></iframe>
  <p>are you a robot</p>
</body></html>`;

const SLIDER = `<html><body><p>press &amp; hold to verify</p></body></html>`;
const CLEAN = `<html><body><h1>welcome</h1></body></html>`;

describe("detector", () => {
  it("detects reCAPTCHA v2 by iframe + class markers", () => {
    const d = detectFromHtml(RECAPTCHA_V2, "https://example.com/login", "tab1");
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("recaptcha_v2");
    expect(d!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(d!.site).toBe("example.com");
    expect(d!.evidence.some((e) => e.includes("recaptcha"))).toBe(true);
  });

  it("detects reCAPTCHA v3 by render script", () => {
    const d = detectFromHtml(RECAPTCHA_V3, "https://example.com/", "tab1");
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("recaptcha_v3");
    expect(d!.confidence).toBeLessThan(0.9);
  });

  it("detects Turnstile", () => {
    const d = detectFromHtml(TURNSTILE, "https://example.com/", "tab1");
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("turnstile");
  });

  it("detects hCaptcha", () => {
    const d = detectFromHtml(HCAPTCHA, "https://example.com/", "tab1");
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("hcaptcha");
  });

  it("detects slider-style challenges from text", () => {
    const d = detectFromHtml(SLIDER, "https://example.com/", "tab1");
    expect(d).not.toBeNull();
    expect(d!.kind).toBe("slider");
  });

  it("returns null for a clean page", () => {
    expect(detectFromHtml(CLEAN, "https://example.com/", "tab1")).toBeNull();
  });
});
