"use server";

import { revalidatePath } from "next/cache";
import { store, type EventTypeInUseError, type QuestionDraft } from "@/lib/data";
import { isNamedError } from "@/lib/data/types";
import { checkEventType, checkQuestions, priceGateError, type CodedError, type EventTypeErrors, type EventTypeForm, type QuestionErrors } from "@/lib/event-types";
import type { HostKey } from "@/lib/i18n/host";
import { requireHost } from "@/lib/auth/session";
import { authEnabled } from "@/lib/auth/auth";
import { hostPlan } from "@/lib/billing/account";
import { getPool } from "@/lib/data/pg-store";
import { paymentAccount, priceCurrency } from "@/lib/payments/host-payments";
import { getHostI18n } from "@/lib/i18n/host/server";
import { formatAmount } from "@/lib/money";
import { videoGateError } from "@/lib/video/gate";
import { videoAvailabilityFor } from "@/lib/video/server";

export type SaveResult =
  | { ok: true; id: string; slug: string }
  | { ok: false; errors: EventTypeErrors; questionErrors: QuestionErrors };

function refresh(userSlug: string, id?: string) {
  revalidatePath("/dashboard/event-types");
  if (id) revalidatePath(`/dashboard/event-types/${id}`);
  revalidatePath(`/${userSlug}`, "layout");
}

/** Why the host can't charge this price, checked here on the server whatever the editor showed. Null when they can. */
async function priceError(userId: string, priceMinor: number | null): Promise<string | null> {
  if (priceMinor === null) return null;
  let gate: Parameters<typeof priceGateError>[0] = { priceMinor, demo: true, plan: "free", paymentsReady: false };
  if (authEnabled()) {
    const pool = getPool(process.env.DATABASE_URL as string);
    const [plan, account] = await Promise.all([hostPlan(pool, userId), paymentAccount(pool, userId)]);
    gate = { priceMinor, demo: false, plan, paymentsReady: account?.ready === true };
  }
  if (priceGateError(gate) === null) return null;
  // priceGateError decides; the host reads the same reason in their own language, checked in the same order.
  const { t } = await getHostI18n();
  return t(gate.demo ? "eventTypes.priceDemo" : gate.plan === "free" ? "eventTypes.pricePlan" : "eventTypes.pricePayments");
}

/** Prices are saved in the currency the host's payment provider settles in (INR on Razorpay, the Stripe account's otherwise). */
async function hostCurrency(userId: string): Promise<string> {
  if (!authEnabled()) return "INR";
  return priceCurrency(await paymentAccount(getPool(process.env.DATABASE_URL as string), userId));
}

/** Creates the event type when `id` is null, otherwise updates it. Saves details, rules and questions together. */
export async function saveEventType(id: string | null, form: EventTypeForm, questions: QuestionDraft[]): Promise<SaveResult> {
  const user = await requireHost();
  const others = (await store.listEventTypes(user.id)).filter((e) => e.id !== id).map((e) => e.slug);
  const details = checkEventType(form, others);
  const checked = checkQuestions(questions);
  if (!details.ok || !checked.ok) {
    // The validators word their errors in English; each code is shown in the host's language instead.
    const { t } = await getHostI18n();
    // A Stripe host prices in their Stripe account's currency, so the bad-price hint names that currency, not rupees.
    const badPrice = !details.ok && Object.values(details.codes).some((e) => e?.code === "priceInvalid");
    const currency = badPrice ? await hostCurrency(user.id) : "INR";
    const say = (e: CodedError) => e.code === "priceInvalid" && currency !== "INR"
      ? t("common.errPriceOther", { currency, min: formatAmount(100, currency) })
      : t(`eventTypes.err${e.code[0].toUpperCase()}${e.code.slice(1)}` as HostKey, e.vars);
    const errors: EventTypeErrors = {};
    if (!details.ok) for (const [field, e] of Object.entries(details.codes)) if (e) errors[field as keyof EventTypeErrors] = say(e);
    const questionErrors: QuestionErrors = checked.ok ? [] : checked.codes.map((c) => Object.fromEntries(
      (["label", "choices", "condition", "range"] as const).filter((k) => c[k]).map((k) => [k, say(c[k]!)])));
    return { ok: false, errors, questionErrors };
  }
  const gate = await priceError(user.id, details.value.priceMinor);
  if (gate) return { ok: false, errors: { price: gate }, questionErrors: [] };
  // A deposit is a payment too: same plan and payment-account requirement.
  const depositGate = await priceError(user.id, details.value.depositMinor);
  if (depositGate) return { ok: false, errors: { deposit: depositGate }, questionErrors: [] };
  // Hourhand video needs the Jitsi settings on this server and a Solo or Duo plan.
  if (details.value.location?.kind === "hourhand_video") {
    const before = id ? await store.listEventLocations(user.id, id) : [];
    const videoGate = videoGateError({ chosen: true, alreadyChosen: before[0]?.kind === "hourhand_video", availability: await videoAvailabilityFor(user.id) });
    if (videoGate) {
      const { t } = await getHostI18n();
      return { ok: false, errors: { locationKind: t(videoGate === "plan" ? "eventTypes.videoNeedsPlan" : "eventTypes.videoNotSetUp") }, questionErrors: [] };
    }
  }
  if (details.value.priceMinor !== null || details.value.depositMinor !== null) details.value.currency = await hostCurrency(user.id);
  try {
    const saved = id ? await store.updateEventType(user.id, id, details.value) : await store.createEventType(user.id, details.value);
    await store.saveQuestions(user.id, saved.id, checked.value);
    refresh(user.slug, saved.id);
    return { ok: true, id: saved.id, slug: saved.slug };
  } catch (e) {
    if (isNamedError(e, "SlugTakenError")) return { ok: false, errors: { slug: (await getHostI18n()).t("eventTypes.slugTaken") }, questionErrors: [] };
    throw e;
  }
}

export async function setEventTypeActive(id: string, active: boolean): Promise<void> {
  const user = await requireHost();
  await store.setEventTypeActive(user.id, id, active === true);
  refresh(user.slug, id);
}

/** Returns the reason when the event type can't be deleted. */
export async function deleteEventType(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireHost();
  try {
    await store.deleteEventType(user.id, id);
  } catch (e) {
    if (isNamedError<EventTypeInUseError>(e, "EventTypeInUseError")) {
      const { t } = await getHostI18n();
      if (e.reason === "history") return { ok: false, error: t("eventTypes.inUseHistory") };
      return { ok: false, error: t(e.upcomingCount === 1 ? "eventTypes.inUseUpcomingOne" : "eventTypes.inUseUpcoming", { n: e.upcomingCount }) };
    }
    throw e;
  }
  refresh(user.slug);
  return { ok: true };
}
