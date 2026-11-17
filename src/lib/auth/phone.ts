// Sign-in by phone: a six-digit code on WhatsApp or by SMS, Indian mobiles only for now.
// - WhatsApp: an approved Authentication template with a copy-code button (WHATSAPP_OTP_TEMPLATE), sent from Hourhand's
//   WhatsApp number through the same Cloud API setup as booking messages.
// - SMS: MSG91 on the DLT system, on its own OTP template (MSG91_TEMPLATE_OTP).
// Each channel is on only when fully set up. With neither, phone sign-in is off and the sign-in page doesn't offer it.

import { sendWhatsApp, whatsappConfig, type WhatsAppConfig } from "../whatsapp-cloud";
import { postFlow } from "../sms/msg91";
import { smsNumber } from "../sms/config";

export type OtpChannel = "whatsapp" | "sms";

/** The header the sign-in page uses to tell sendOTP which channel the person picked. Either value is safe to accept. */
export const OTP_CHANNEL_HEADER = "x-hourhand-otp-channel";

/** The channels set up on this server, WhatsApp first: it is what most Indian users open first, and it costs less per code. */
export function otpChannels(env: Record<string, string | undefined> = process.env): OtpChannel[] {
  return [...(whatsappOtpConfig(env) ? ["whatsapp" as const] : []), ...(otpSmsConfig(env) ? ["sms" as const] : [])];
}

/** The channel to send on: the one asked for if it is set up, otherwise the first one set up; null when none is. */
export function pickOtpChannel(requested: string | null | undefined, available: readonly OtpChannel[]): OtpChannel | null {
  return available.find((c) => c === requested) ?? available[0] ?? null;
}

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

export interface WhatsAppOtpConfig { cloud: WhatsAppConfig; template: string; language: string }

/** Null unless WhatsApp is set up and the name of the approved Authentication template is given. */
export function whatsappOtpConfig(env: Record<string, string | undefined> = process.env): WhatsAppOtpConfig | null {
  const cloud = whatsappConfig(env);
  if (!cloud || !env.WHATSAPP_OTP_TEMPLATE) return null;
  return { cloud, template: env.WHATSAPP_OTP_TEMPLATE, language: env.WHATSAPP_OTP_TEMPLATE_LANG || "en" };
}

/**
 * The Cloud API body for one sign-in code on a copy-code Authentication template. Meta requires the code twice: once
 * for the body's {{1}} and once for the copy-code button (which Meta stores as a URL button at index 0).
 * Source: developers.facebook.com/docs/whatsapp/business-management-api/authentication-templates/copy-code-button-authentication-templates (read 2026-11-16).
 */
export function whatsappOtpBody(cfg: Pick<WhatsAppOtpConfig, "template" | "language">, phone: string, code: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: phone.replace(/\D/g, ""),
    type: "template",
    template: {
      name: cfg.template,
      language: { code: cfg.language },
      components: [
        { type: "body", parameters: [{ type: "text", text: code }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] },
      ],
    },
  };
}

/** Sends one sign-in code on WhatsApp. Throws WhatsAppError. Meta accepting it doesn't mean it arrived: the page offers SMS too. */
export async function sendOtpWhatsApp(cfg: WhatsAppOtpConfig, phone: string, code: string, fetchFn: typeof fetch = fetch): Promise<{ id: string }> {
  return sendWhatsApp(cfg.cloud, whatsappOtpBody(cfg, phone, code), fetchFn);
}
