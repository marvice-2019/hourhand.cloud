import { describe, expect, it } from "vitest";
import { LOCALES, type Locale } from "../i18n/guest";
import { refusalLines, splitTemplate, type RefusalReason } from "./messages";

const REASONS: RefusalReason[] = ["not_video", "not_set_up", "plan", "cancelled", "not_confirmed", "too_early", "ended"];

describe("the video join refusal page in each guest language", () => {
  it.each(LOCALES.filter((l) => l !== "en"))("%s has its own line for every reason, and keeps the 15 and 30 minutes", (locale) => {
    const lines = refusalLines(locale);
    const en = refusalLines("en");
    for (const r of REASONS) {
      expect(lines[r].title.trim()).not.toBe("");
      expect(lines[r].body.trim()).not.toBe("");
      expect(lines[r].title).not.toBe(en[r].title);
      expect(lines[r].body).not.toBe(en[r].body);
    }
    expect(lines.too_early.body).toContain("15");
    expect(lines.ended.body).toContain("30");
    expect(lines.seeBooking).not.toBe(en.seeBooking);
  });

  it.each([...LOCALES])("%s keeps the date, time and zone slots in the opening line", (locale) => {
    const slots = splitTemplate(refusalLines(locale).opensAt).map((p) => p.slot).filter(Boolean).sort();
    expect(slots).toEqual(["date", "time", "zone"]);
  });

  it("falls back to English for a language without lines yet", () => {
    expect(refusalLines("xx" as Locale)).toEqual(refusalLines("en"));
  });

  it("splits a template into text and slots in order", () => {
    expect(splitTemplate("Opens {date} at {time} ({zone}).")).toEqual([
      { text: "Opens ", slot: null }, { text: "", slot: "date" }, { text: " at ", slot: null }, { text: "", slot: "time" },
      { text: " (", slot: null }, { text: "", slot: "zone" }, { text: ").", slot: null },
    ]);
  });
});
