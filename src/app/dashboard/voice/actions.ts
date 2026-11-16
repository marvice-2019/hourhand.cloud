"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { BillingActionError, hostPlan } from "@/lib/billing/account";
import { cancelAddon, getAddon, startAddonCheckout } from "@/lib/billing/addons";
import { addonLive, VOICE_INCLUDED_MINUTES } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { getHostI18n } from "@/lib/i18n/host/server";
import { validateVoiceForm } from "@/lib/voice/settings-form";
import { markMessageHandled, rotateKey, saveVoiceSettings } from "@/lib/voice/store";
import { VOICE_PLANS } from "@/lib/voice/tools";

// Each action checks the session itself and changes only the signed-in host's own receptionist (host_id in every
// query). A Duo second person managing someone else's account is sent away by requireOwnAccount.

const PAGE = "/dashboard/voice";
const pool = () => getPool(process.env.DATABASE_URL as string);

export type VoiceFormState = { status: "idle" } | { status: "error"; errors: Record<string, string> };

export async function saveVoice(_prev: VoiceFormState, form: FormData): Promise<VoiceFormState> {
  const user = await requireOwnAccount();
  const { t } = await getHostI18n();
  if (!authEnabled()) return { status: "error", errors: { form: t("voice.errorDemo") } };
  const v = validateVoiceForm(form);
  if (!v.ok) return { status: "error", errors: Object.fromEntries(Object.entries(v.errors).map(([k, key]) => [k, t(key, { max: VOICE_INCLUDED_MINUTES })])) };
  if (v.value.enabled) {
    const db = pool();
    if (!VOICE_PLANS.includes(await hostPlan(db, user.id))) return { status: "error", errors: { form: t("voice.errorFormNeedsPlan") } };
    if (!addonLive(await getAddon(db, user.id, "voice"))) return { status: "error", errors: { form: t("voice.errorFormNeedsAddon") } };
  }
  try {
    await saveVoiceSettings(pool(), user.id, v.value);
  } catch (error) {
    // agent_id is unique: another host's agent.
    if ((error as { code?: string }).code === "23505") return { status: "error", errors: { agentId: t("voice.errorAgentTaken") } };
    throw error;
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?saved=1`);
}

export async function rotateVoiceKey(): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect(PAGE);
  await rotateKey(pool(), user.id);
  revalidatePath(PAGE);
  redirect(`${PAGE}?rotated=1`);
}

export async function markHandled(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const id = String(form.get("id") ?? "");
  if (authEnabled() && /^[0-9a-f-]{36}$/.test(id)) await markMessageHandled(pool(), user.id, id, new Date());
  revalidatePath(PAGE);
  redirect(PAGE);
}

async function runAddon(change: () => Promise<string | void>, done: string): Promise<never> {
  let target = `${PAGE}?done=${done}`;
  try {
    const url = await change();
    if (url) target = url;
  } catch (error) {
    if (!(error instanceof BillingActionError)) throw error;
    target = `${PAGE}?error=${error.code}`;
  }
  revalidatePath(PAGE);
  redirect(target);
}

export async function buyVoiceAddon(): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect(PAGE);
  if (!VOICE_PLANS.includes(await hostPlan(pool(), user.id))) redirect(`${PAGE}?error=needs_plan`);
  const base = (resolveBaseUrl() ?? "http://localhost:3000").replace(/\/+$/, "");
  await runAddon(() => startAddonCheckout(pool(), user, "voice", base), "checkout");
}

export async function cancelVoiceAddon(): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect(PAGE);
  await runAddon(() => cancelAddon(pool(), user.id, "voice"), "cancelled");
}
