import { describe, expect, it, vi } from "vitest";
import { refusePlaceholderAddresses, MailError } from "../mail/mailer";
import { slugSource } from "./auth";
import { formatPhone, isCanonicalPhone, isPhonePlaceholderEmail, normalizePhone, otpSmsConfig, phoneEmail, sendOtpSms } from "./phone";
import { baseSlug } from "./slug";

describe("phone numbers", () => {
  it("turns every spelling of an Indian mobile into one stored form", () => {
    for (const input of ["9876543210", "98765 43210", "+91 98765-43210", "09876543210", "919876543210", "0091 9876543210"]) {
      expect(normalizePhone(input)).toBe("+919876543210");
    }
  });

  it("refuses landlines, short numbers and other countries", () => {
    for (const input of ["", "12345", "5876543210", "+44 7700 900123", "+1 415 555 0100", "abc"]) expect(normalizePhone(input)).toBeNull();
  });

  it("accepts only the stored form at the API, so a direct call can't open a second account under another spelling", () => {
    expect(isCanonicalPhone("+919876543210")).toBe(true);
    expect(isCanonicalPhone("919876543210")).toBe(false);
    expect(isCanonicalPhone("+91 98765 43210")).toBe(false);
  });

  it("formats a number for showing back", () => {
    expect(formatPhone("+919876543210")).toBe("+91 98765 43210");
  });
});

describe("phone sign-up placeholders", () => {
  it("gives a phone sign-up an undeliverable placeholder email", () => {
    const email = phoneEmail("+919876543210");
    expect(email).toBe("919876543210@phone.invalid");
    expect(isPhonePlaceholderEmail(email)).toBe(true);
    expect(isPhonePlaceholderEmail("someone@example.com")).toBe(false);
  });

  it("never puts the phone number in the booking-link slug", () => {
    const source = slugSource({ email: phoneEmail("+919876543210"), name: "" });
    expect(source).toMatch(/^host-[0-9a-f]{6}$/);
    expect(baseSlug(phoneEmail("+919876543210"), source)).not.toContain("9876543210");
    expect(slugSource({ email: "asha@example.com", name: "Asha Rao" })).toBe("Asha Rao");
  });

  it("refuses to email a placeholder address and passes real ones through", async () => {
    const inner = { send: vi.fn(async () => ({ id: "m1" })) };
    const mailer = refusePlaceholderAddresses(inner);
    const mail = { subject: "s", html: "h", text: "t", idempotencyKey: "k" };
    await expect(mailer.send({ ...mail, to: "919876543210@phone.invalid" })).rejects.toMatchObject({ retryable: false });
    await expect(mailer.send({ ...mail, to: "919876543210@PHONE.INVALID" })).rejects.toBeInstanceOf(MailError);
    expect(inner.send).not.toHaveBeenCalled();
    await expect(mailer.send({ ...mail, to: "asha@example.com" })).resolves.toEqual({ id: "m1" });
  });
});

describe("sign-in codes by SMS", () => {
  const env = { SMS_PROVIDER: "msg91", MSG91_AUTH_KEY: "key", MSG91_TEMPLATE_OTP: "otp-template" };

  it("is off unless MSG91, its key and the OTP template are all set", () => {
    expect(otpSmsConfig({})).toBeNull();
    expect(otpSmsConfig({ ...env, MSG91_TEMPLATE_OTP: undefined })).toBeNull();
    expect(otpSmsConfig({ ...env, SMS_PROVIDER: "twilio" })).toBeNull();
    expect(otpSmsConfig({ ...env, NODE_ENV: "production" })).toEqual({ authKey: "key", templateId: "otp-template", baseUrl: "https://control.msg91.com" });
  });

  it("never lets production point at a fake MSG91", () => {
    expect(otpSmsConfig({ ...env, NODE_ENV: "production", MSG91_API_BASE_URL: "http://evil" })?.baseUrl).toBe("https://control.msg91.com");
    expect(otpSmsConfig({ ...env, NODE_ENV: "test", MSG91_API_BASE_URL: "http://fake" })?.baseUrl).toBe("http://fake");
  });

  it("sends the code as VAR1 on the OTP template to the number's digits", async () => {
    const fetchFn = vi.fn(async () => Response.json({ type: "success", message: "req-1" }));
    const cfg = otpSmsConfig({ ...env, NODE_ENV: "production" })!;
    await expect(sendOtpSms(cfg, "+919876543210", "123456", fetchFn as unknown as typeof fetch)).resolves.toEqual({ id: "req-1" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://control.msg91.com/api/v5/flow");
    expect((init.headers as Record<string, string>).authkey).toBe("key");
    expect(JSON.parse(init.body as string)).toEqual({ template_id: "otp-template", short_url: "0", recipients: [{ mobiles: "919876543210", VAR1: "123456" }] });
  });

  it("fails loudly when MSG91 refuses", async () => {
    const fetchFn = vi.fn(async () => Response.json({ type: "error", message: "bad" }, { status: 400 }));
    await expect(sendOtpSms(otpSmsConfig(env)!, "+919876543210", "123456", fetchFn as unknown as typeof fetch)).rejects.toMatchObject({ retryable: false });
  });
});
