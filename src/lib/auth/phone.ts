// Sign-in by phone: a six-digit code by SMS, India only (MSG91 on the DLT system, like booking texts). Every text must
// match a DLT-registered template, so the code goes on its own OTP template (MSG91_TEMPLATE_OTP). Without that setting,
// or without the MSG91 account settings, phone sign-in is off and the sign-in page doesn't offer it.

import { postFlow } from "../sms/msg91";
import { smsNumber } from "../sms/config";

/**
 * A host who signs up by phone has no email yet, but users.email is required and unique. They get an address on the
 * reserved .invalid domain (RFC 2606), which can never be delivered: the mailer refuses it instead of sending a bounce.
 */
export const PHONE_EMAIL_DOMAIN = "phone.invalid";

/** The one stored form of a phone number: +91 and ten digits. Other spellings are turned into this before any lookup. */
const CANONICAL = /^\+91[6-9]\d{9}$/;

export const isCanonicalPhone = (phone: string): boolean => CANONICAL.test(phone);

/** "98765 43210", "+91 98765-43210", "09876543210" → "+919876543210"; anything but an Indian mobile → null. */
export function normalizePhone(input: string): string | null {
  const digits = smsNumber(input);
  return digits ? `+${digits}` : null;
}

export const phoneEmail = (phone: string): string => `${phone.replace(/\D/g, "")}@${PHONE_EMAIL_DOMAIN}`;

export const isPhonePlaceholderEmail = (email: string): boolean => email.toLowerCase().endsWith(`@${PHONE_EMAIL_DOMAIN}`);

/** "+919876543210" → "+91 98765 43210", for showing back to the person. */
export const formatPhone = (phone: string): string => (isCanonicalPhone(phone) ? `+91 ${phone.slice(3, 8)} ${phone.slice(8)}` : phone);

export interface OtpSmsConfig { authKey: string; templateId: string; baseUrl: string }

/** Null unless MSG91 is the SMS provider and both its auth key and the OTP template id are set. */
export function otpSmsConfig(env: Record<string, string | undefined> = process.env): OtpSmsConfig | null {
  if (env.SMS_PROVIDER !== "msg91" || !env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_OTP) return null;
  // Same rule as booking texts: only tests and the e2e run may point at a fake MSG91.
  const fake = env.NODE_ENV !== "production" || env.HOURHAND_E2E === "1" ? env.MSG91_API_BASE_URL : undefined;
  return { authKey: env.MSG91_AUTH_KEY, templateId: env.MSG91_TEMPLATE_OTP, baseUrl: fake || "https://control.msg91.com" };
}

/** The registered OTP template, word for word. ##VAR1## is the code. docs/deploy.md lists it for the DLT portal. */
export const OTP_TEMPLATE = "##VAR1## is your Hourhand sign-in code. It expires in 5 minutes. Do not share it with anyone.";

/** Texts one sign-in code. `phone` is canonical (+91…). Throws SmsError. */
export async function sendOtpSms(cfg: OtpSmsConfig, phone: string, code: string, fetchFn: typeof fetch = fetch): Promise<{ id: string }> {
  const body = { template_id: cfg.templateId, short_url: "0", recipients: [{ mobiles: phone.replace(/\D/g, ""), VAR1: code }] };
  return postFlow(cfg, body, fetchFn);
}
