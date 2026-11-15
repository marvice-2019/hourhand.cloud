import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JoinRefused } from "@/components/VideoJoinRefused";

const opensAt = new Date("2026-12-01T04:15:00Z");
const render = (locale: "en" | "ta" | "hi", reason: "too_early" | "cancelled" = "too_early") =>
  renderToStaticMarkup(createElement(JoinRefused, { reason, opensAt, tz: "Asia/Kolkata", locale, back: { href: "/b/tok" }, switcherPath: "/b/tok/video" }));

describe("the video join refusal page", () => {
  it("renders in the guest's language with the opening time filled in", () => {
    const html = render("ta");
    expect(html).toContain('lang="ta"');
    expect(html).toContain("கால் இன்னும் திறக்கவில்லை");
    expect(html).toContain("உங்கள் புக்கிங்கைப் பாருங்கள்");
    expect(html).toMatch(/9:45/);
    expect(html).not.toMatch(/\{(date|time|zone)\}/);
  });

  it("shows no opening time for other reasons, and English stays English", () => {
    expect(render("hi", "cancelled")).toContain("यह बुकिंग कैंसल हो गई");
    expect(render("hi", "cancelled")).not.toContain("खुलेगा");
    expect(render("en")).toContain("The call hasn&#x27;t opened yet");
  });
});
