import { describe, expect, it } from "vitest";
import { keyToShow } from "./show-key";

describe("showing a new API key", () => {
  const made = { status: "made" as const, id: "k1", key: "hh_example" };
  it("shows the key right after it's made", () => {
    expect(keyToShow(made, ["k0", "k1"])).toBe("hh_example");
  });
  it("hides it once that key is removed", () => {
    expect(keyToShow(made, ["k0"])).toBeNull();
    expect(keyToShow(made, [])).toBeNull();
  });
  it("shows nothing before a key is made or after an error", () => {
    expect(keyToShow({ status: "idle" }, ["k1"])).toBeNull();
    expect(keyToShow({ status: "error", error: "too_many" }, ["k1"])).toBeNull();
  });
});
