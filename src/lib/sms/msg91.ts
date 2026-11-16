import type { SmsConfig } from "./config";
import { SmsError, type SmsMessage } from "./provider";

// MSG91's Flow API (docs.msg91.com/sms/send-sms.openapi.yml, read 2026-11-15): POST /api/v5/flow with the account's
// authkey header. `template_id` is MSG91's id for the template, which MSG91 links to the DLT template id and header
// when the template is added there. Slots go as VAR1, VAR2, VAR3: the MSG91 template must name them ##VAR1## etc.

/** The Flow API request body for one text. */
export function msg91Body(cfg: SmsConfig, m: SmsMessage) {
  const ids = cfg.templates[m.kind];
  // A Hindi text only goes on a Hindi template; with no Hindi template set up the caller fills the English text.
  const templateId = m.filled.lang === "hi" && ids.hi ? ids.hi : ids.en;
  const recipient: Record<string, string> = { mobiles: m.to };
  m.filled.vars.forEach((v, i) => { recipient[`VAR${i + 1}`] = v; });
  // short_url off: the link is our own whitelisted address; MSG91's shortener would swap in a domain DLT hasn't seen.
  return { template_id: templateId, short_url: "0", recipients: [recipient] };
}

/** Sends one text; returns MSG91's request id, which its delivery reports carry as requestId. */
export async function sendMsg91(cfg: SmsConfig, m: SmsMessage, fetchFn: typeof fetch = fetch): Promise<{ id: string }> {
  let res: Response;
  try {
    res = await fetchFn(`${cfg.baseUrl}/api/v5/flow`, {
      method: "POST",
      headers: { authkey: cfg.authKey, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(msg91Body(cfg, m)),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new SmsError(`MSG91 request failed: ${(error as Error).name}`, true);
  }
  const json = (await res.json().catch(() => ({}))) as { type?: string; message?: unknown };
  if (res.ok && json.type === "success" && typeof json.message === "string" && json.message) return { id: json.message };
  // MSG91 answers some refusals with 200 and type "error"; its message can echo the request, so only the status is kept.
  throw new SmsError(`MSG91 ${res.status}${json.type === "error" ? " (error)" : ""}`, res.status >= 500 || res.status === 429);
}
