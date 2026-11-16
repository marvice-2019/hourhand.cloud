import { describe, expect, it } from "vitest";
import { hostDisplayName } from "./display-name";

describe("hostDisplayName", () => {
  it("keeps a name the host set", () => {
    expect(hostDisplayName("Priya Raman", "priya@example.com")).toBe("Priya Raman");
    expect(hostDisplayName("  Priya  ", "priya@example.com")).toBe("Priya");
  });

  it("falls back to the email's local part, without the domain or a +tag", () => {
    expect(hostDisplayName("", "priya.raman@example.com")).toBe("Priya Raman");
    expect(hostDisplayName(null, "dr_kumar-clinic@example.com")).toBe("Dr Kumar Clinic");
    expect(hostDisplayName(undefined, "marvice2019+hhtest@gmail.com")).toBe("Marvice2019");
    expect(hostDisplayName("   ", "coach@example.com")).toBe("Coach");
  });

  it("never returns the email address or an empty string", () => {
    expect(hostDisplayName("", "@example.com")).toBe("Your host");
    expect(hostDisplayName("", "+tag@example.com")).toBe("Your host");
    expect(hostDisplayName("", "a@b.co")).not.toContain("@");
  });
});
