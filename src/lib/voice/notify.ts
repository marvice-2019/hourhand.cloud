import { formatDate, formatTime, zoneName } from "../format";
import type { Mailer } from "../mail/mailer";
import { sendWhatsApp, type WhatsAppConfig } from "../whatsapp-cloud";
import type { MessageReason } from "./store";

// Messages the receptionist sends straight away (not through the booking outbox): the host hears about a message or a
// handoff, the host is warned at 80% of their minutes, and a caller gets the link to pay for a held time.

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const html = (lines: string[]) => lines.map((l) => `<p>${esc(l)}</p>`).join("\n");

const REASON_TEXT: Record<MessageReason, string> = {
  requested: "The caller asked to leave a message.",
  handoff: "The assistant couldn't finish what the caller wanted and handed the call to you.",
  out_of_scope: "The caller asked something the assistant doesn't answer (for example clinical advice).",
  payment_issue: "The caller couldn't pay for their booking.",
  low_confidence: "The assistant wasn't sure it understood the caller.",
  other: "The caller left a message.",
};

export async function emailHostMessage(
  mailer: Mailer, to: string, m: { id: string; callerName: string; callerPhone: string; body: string; reason: MessageReason; urgent: boolean; dashboardUrl: string },
): Promise<void> {
  const subject = `${m.urgent ? "URGENT: " : ""}Phone message from ${m.callerName} (${m.callerPhone})`;
  const lines = [
    ...(m.urgent ? ["The caller may be at risk. The assistant gave them 112 and Tele-MANAS 14416. Please call them back now."] : []),
    REASON_TEXT[m.reason], `From: ${m.callerName}, ${m.callerPhone}`, `Message: ${m.body}`, `All calls and messages: ${m.dashboardUrl}`,
  ];
  await mailer.send({ to, subject, text: lines.join("\n\n"), html: html(lines), idempotencyKey: `voice-message-${m.id}` });
}

export async function emailCapWarning(mailer: Mailer, to: string, w: { hostId: string; month: string; usedMinutes: number; capMinutes: number; dashboardUrl: string }): Promise<void> {
  const lines = [
    `Your phone assistant has used ${w.usedMinutes} of its ${w.capMinutes} minutes this month.`,
    "When it reaches the limit it stops answering: callers hear one line asking them to book online, and the call ends.",
    `Raise the limit or add minutes here: ${w.dashboardUrl}`,
  ];
  await mailer.send({ to, subject: "Your phone assistant has used 80% of this month's minutes", text: lines.join("\n\n"), html: html(lines), idempotencyKey: `voice-cap80-${w.hostId}-${w.month}` });
}

export interface PayLinkContext {
  bookingId: string;
  guestName: string;
  hostName: string;
  eventName: string;
  startAt: Date;
  timezone: string;
  holdExpiresAt: Date;
  amountMinor: number;
  url: string;
  locale: "en" | "hi";
}

const rupees = (minor: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);

export async function emailPayLink(mailer: Mailer, to: string, c: PayLinkContext): Promise<void> {
  const when = `${formatDate(c.startAt, c.timezone)}, ${formatTime(c.startAt, c.timezone)} ${zoneName(c.timezone)}`;
  const until = `${formatTime(c.holdExpiresAt, c.timezone)} ${zoneName(c.timezone)}`;
  const lines = [
    `Hi ${c.guestName},`, `Your ${c.eventName} with ${c.hostName} on ${when} is held for you until ${until}.`,
    `Pay ${rupees(c.amountMinor)} to confirm it: ${c.url}`, "If it isn't paid by then, the time is released and nothing is charged.",
  ];
  await mailer.send({ to, subject: `Pay to confirm your ${c.eventName} with ${c.hostName}`, text: lines.join("\n\n"), html: html(lines), idempotencyKey: `voice-pay-${c.bookingId}` });
}

/**
 * The pay link on WhatsApp: utility template hh_voice_pay_link (en, hi), which must be approved in Meta before use.
 * Body: {{1}} first name, {{2}} event, {{3}} host, {{4}} amount, {{5}} held-until time; the URL button opens /v/pay/{{1}}.
 */
export const PAY_LINK_TEMPLATE = {
  name: "hh_voice_pay_link",
  en: { body: "Hi {{1}}, your {{2}} with {{3}} is held for you. Pay {{4}} by {{5}} to confirm it, or the time is released.", button: "Pay now" },
  hi: { body: "नमस्ते {{1}}, {{3}} के साथ आपका {{2}} आपके लिए रोका गया है। पक्का करने के लिए {{5}} तक {{4}} का भुगतान करें, वरना समय छोड़ दिया जाएगा।", button: "भुगतान करें" },
} as const;

export function payLinkTemplate(to: string, c: PayLinkContext, token: string) {
  const first = c.guestName.trim().split(/\s+/)[0] || c.guestName;
  const until = `${formatTime(c.holdExpiresAt, c.timezone, "12h", c.locale)} ${zoneName(c.timezone)}`;
  const text = (s: string) => ({ type: "text", text: s.replace(/\s+/g, " ").trim().slice(0, 80) || "-" });
  return {
    messaging_product: "whatsapp", recipient_type: "individual", to, type: "template",
    template: {
      name: PAY_LINK_TEMPLATE.name, language: { code: c.locale },
      components: [
        { type: "body", parameters: [first, c.eventName, c.hostName, rupees(c.amountMinor), until].map(text) },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: token }] },
      ],
    },
  };
}

export async function whatsappPayLink(cfg: WhatsAppConfig, to: string, c: PayLinkContext, token: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await sendWhatsApp(cfg, payLinkTemplate(to, c, token), fetchFn);
}
