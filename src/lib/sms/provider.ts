import type { SmsConfig, SmsKind } from "./config";
import { sendMsg91 } from "./msg91";
import type { FilledSms } from "./templates";

/** One text to one number: the provider's template for this message and language, and the slot values in order. */
export interface SmsMessage { to: string; kind: SmsKind; filled: FilledSms }

/** What every SMS provider does. MSG91 is the first; Twilio (or another DLT-registered gateway) can be added beside it. */
export interface SmsProvider {
  readonly name: SmsConfig["provider"];
  /** Sends one text; returns the provider's id for it, which delivery reports refer to. Throws SmsError. */
  send(message: SmsMessage): Promise<{ id: string }>;
}

/** A send that failed. `retryable`: the provider or the network may recover (5xx, 429, timeouts); a 4xx won't fix itself. */
export class SmsError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "SmsError";
  }
}

export function smsProvider(cfg: SmsConfig, fetchFn: typeof fetch = fetch): SmsProvider {
  return { name: cfg.provider, send: (m) => sendMsg91(cfg, m, fetchFn) };
}
