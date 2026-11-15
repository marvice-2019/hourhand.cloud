import { authEnabled, resolveBaseUrl } from "../auth/auth";
import { hostPlan } from "../billing/account";
import { getAddon } from "../billing/addons";
import { addonLive } from "../billing/plans";
import { store } from "../data";
import { getPool } from "../data/pg-store";
import { getMailer } from "../mail/mailer";
import { requestPaymentDeps } from "../payments/request-deps";
import { rateLimiter } from "../rate-limit";
import { whatsappConfig } from "../whatsapp-cloud";
import { voiceToolsKey } from "./auth";
import { voiceRates } from "./cost";
import type { VoiceDeps } from "./tools";
import type { WebhookDeps } from "./webhooks";

// What the voice routes run with on this server. Null when the receptionist isn't set up here: it needs Postgres and
// VOICE_TOOLS_KEY (tools), or the webhook secrets (webhooks).

type Pool = ReturnType<typeof getPool>;
const addonFor = (pool: Pool) => async (hostId: string) => addonLive(await getAddon(pool, hostId, "voice"));

const base = () => (resolveBaseUrl() ?? "http://localhost:3000").replace(/\/+$/, "");

export function voiceToolDeps(): VoiceDeps | null {
  const key = authEnabled() ? voiceToolsKey() : null;
  if (!key) return null;
  const pool = getPool(process.env.DATABASE_URL!);
  return {
    pool, store, key, planFor: (id) => hostPlan(pool, id), hasAddon: addonFor(pool), payments: requestPaymentDeps(), mailer: getMailer(), whatsapp: whatsappConfig(),
    limiter: rateLimiter, baseUrl: base(),
  };
}

export function voiceWebhookDeps(): WebhookDeps | null {
  if (!authEnabled()) return null;
  const pool = getPool(process.env.DATABASE_URL!);
  return { pool, store, planFor: (id) => hostPlan(pool, id), hasAddon: addonFor(pool), mailer: getMailer(), rates: voiceRates(), baseUrl: base() };
}
