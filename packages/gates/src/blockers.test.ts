import { describe, expect, it } from "vitest";
import { classifyBlocker, type PageSnapshot } from "./blockers.ts";

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: "https://soundcloud.com/fixture-artist/fixture-track",
    title: "Stream Fixture Track by Fixture Artist",
    visibleFrameSources: [],
    shortBodyText: "",
    hasVisiblePasswordField: false,
    ...overrides,
  };
}

const allowedHosts = ["soundcloud.com"];

describe("classifyBlocker", () => {
  it("finds nothing on an ordinary page", () => {
    expect(classifyBlocker(snapshot(), { allowedHosts })).toBeNull();
  });

  it.each([
    [
      "a reCAPTCHA frame",
      { visibleFrameSources: ["https://www.google.com/recaptcha/api2/anchor"] },
    ],
    ["an hCaptcha frame", { visibleFrameSources: ["https://newassets.hcaptcha.com/captcha/v1/x"] }],
    [
      "a Turnstile frame",
      { visibleFrameSources: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h"] },
    ],
    ["a DataDome frame", { visibleFrameSources: ["https://geo.captcha-delivery.com/captcha/?x"] }],
    ["an Arkose frame", { visibleFrameSources: ["https://client-api.arkoselabs.com/fc/gc/"] }],
    ["a Cloudflare interstitial title", { title: "Just a moment..." }],
    ["a short human-check page", { shortBodyText: "Please verify you are a human to continue" }],
    ["a press-and-hold page", { shortBodyText: "Press & Hold to confirm you are a human" }],
  ])("reports %s as a captcha", (_label, overrides) => {
    expect(classifyBlocker(snapshot(overrides), { allowedHosts })?.reason).toBe("captcha");
  });

  it("ignores reCAPTCHA's passive corner badge", () => {
    const badge = "https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible";

    expect(
      classifyBlocker(snapshot({ visibleFrameSources: [badge] }), { allowedHosts }),
    ).toBeNull();
  });

  it("does not read a captcha into a track that happens to be titled like one", () => {
    const page = snapshot({ title: "Stream Are You A Robot (Captcha Edit) by Fixture Artist" });

    expect(classifyBlocker(page, { allowedHosts })).toBeNull();
  });

  it.each([
    ["a visible password field", { hasVisiblePasswordField: true }],
    ["the sign-in page", { url: "https://soundcloud.com/signin" }],
    ["a second-factor prompt", { shortBodyText: "Enter the verification code from your app" }],
    ["a confirm-identity prompt", { shortBodyText: "Confirm it’s you" }],
  ])("reports %s as a login challenge", (_label, overrides) => {
    expect(classifyBlocker(snapshot(overrides), { allowedHosts })?.reason).toBe("login_challenge");
  });

  it.each([
    "Check your inbox to finish",
    "Please confirm your email address",
    "Enter the code we sent to your address",
    "We've sent you a link",
  ])("reports %j as an email confirmation", (shortBodyText) => {
    expect(classifyBlocker(snapshot({ shortBodyText }), { allowedHosts })?.reason).toBe(
      "email_confirmation",
    );
  });

  it("reports a host outside the adapter's own as an unexpected page", () => {
    const blocker = classifyBlocker(snapshot({ url: "https://ads.example/landing" }), {
      allowedHosts,
    });

    expect(blocker?.reason).toBe("unexpected_page");
    expect(blocker?.description).toContain("ads.example");
  });

  it.each([
    "https://soundcloud.com/a/b",
    "https://www.soundcloud.com/a/b",
    "https://M.SoundCloud.com/a/b",
    "about:blank",
  ])("accepts %s for an adapter that lives on soundcloud.com", (url) => {
    expect(classifyBlocker(snapshot({ url }), { allowedHosts })).toBeNull();
  });

  it("does not accept a look-alike host", () => {
    expect(
      classifyBlocker(snapshot({ url: "https://evilsoundcloud.com/a/b" }), { allowedHosts })
        ?.reason,
    ).toBe("unexpected_page");
  });

  it("accepts any host when the adapter names none", () => {
    expect(classifyBlocker(snapshot({ url: "https://anywhere.example/x" }))).toBeNull();
  });

  it("prefers the captcha when several things are on the page", () => {
    const page = snapshot({
      url: "https://elsewhere.example/signin",
      hasVisiblePasswordField: true,
      visibleFrameSources: ["https://www.google.com/recaptcha/api2/bframe"],
    });

    expect(classifyBlocker(page, { allowedHosts })?.reason).toBe("captcha");
  });

  it("writes every description as a short instruction", () => {
    const pages = [
      snapshot({ title: "Just a moment..." }),
      snapshot({ hasVisiblePasswordField: true }),
      snapshot({ shortBodyText: "Check your inbox" }),
      snapshot({ url: `https://${"a".repeat(60)}.example/x` }),
    ];

    for (const page of pages) {
      const description = classifyBlocker(page, { allowedHosts })?.description ?? "";
      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(280);
    }
  });
});
