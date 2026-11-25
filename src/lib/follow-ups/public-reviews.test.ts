import { describe, expect, it } from "vitest";
import { publicName } from "./public-reviews";

describe("the name on a public review", () => {
  it("is the first name and last initial", () => {
    expect(publicName("Meera Iyer")).toBe("Meera I.");
    expect(publicName("  Ravi   Kumar  Sharma ")).toBe("Ravi S.");
  });
  it("is the one name when only one was given, and nothing when none was", () => {
    expect(publicName("Priya")).toBe("Priya");
    expect(publicName("   ")).toBeNull();
  });
  it("keeps a whole letter of non-Latin scripts as the initial", () => {
    expect(publicName("மீரா ஐயர்")).toBe("மீரா ஐ.");
    expect(publicName("प्रिया शर्मा")).toBe("प्रिया श.");
  });
});
