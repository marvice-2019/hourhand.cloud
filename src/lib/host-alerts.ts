import { waNumber } from "./whatsapp";

export type HostAlertSettings = { phone: string | null; alerts: boolean };
export type HostAlertError = "phone_needed" | "bad_phone";

/**
 * Reads the "WhatsApp me if a calendar stops syncing" form. The number is stored as WhatsApp sees it (country code and
 * digits); a 10-digit Indian mobile gets +91. Turning alerts on needs a usable number; clearing the number turns them off.
 */
export function parseHostAlertForm(phoneInput: string, alertsTicked: boolean): HostAlertSettings | { error: HostAlertError } {
  const raw = phoneInput.trim();
  if (!raw) return alertsTicked ? { error: "phone_needed" } : { phone: null, alerts: false };
  const phone = waNumber(raw);
  if (!phone) return { error: "bad_phone" };
  return { phone, alerts: alertsTicked };
}

export const HOST_ALERT_ERRORS: Record<HostAlertError, string> = {
  phone_needed: "Add your WhatsApp number to get sync alerts there.",
  bad_phone: "Enter your WhatsApp number with country code, like +91 98765 43210.",
};
