import { describe, expect, it } from "vitest";
import { parseHostAlertForm } from "./host-alerts";

describe("parseHostAlertForm", () => {
  it("stores an Indian mobile with +91, and a number with country code as digits", () => {
    expect(parseHostAlertForm("98765 43210", true)).toEqual({ phone: "919876543210", alerts: true });
    expect(parseHostAlertForm("+44 7700 900123", true)).toEqual({ phone: "447700900123", alerts: true });
  });

  it("keeps the number with alerts off", () => {
    expect(parseHostAlertForm("+91 98765 43210", false)).toEqual({ phone: "919876543210", alerts: false });
  });

  it("asks for a number before turning alerts on, and clearing it turns them off", () => {
    expect(parseHostAlertForm("  ", true)).toEqual({ error: "phone_needed" });
    expect(parseHostAlertForm("", false)).toEqual({ phone: null, alerts: false });
  });

  it("refuses a number without a country it can trust", () => {
    expect(parseHostAlertForm("12345", true)).toEqual({ error: "bad_phone" });
    expect(parseHostAlertForm("2025550123", true)).toEqual({ error: "bad_phone" });
  });
});
