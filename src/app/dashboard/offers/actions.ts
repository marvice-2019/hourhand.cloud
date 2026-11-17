"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { LIMITS } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError, type User } from "@/lib/data/types";
import { dayKey } from "@/lib/format";
import type { HostI18n } from "@/lib/i18n/host/format";
import { translator } from "@/lib/i18n/host/lib-messages";
import { getHostI18n } from "@/lib/i18n/host/server";
import {
  createCampaign, createCoupon, parseDiscount, removeSlidingScale, saveFirstSession, saveSlidingScale, setCampaignActive, setCouponActive,
  OFFER_FORM_MESSAGES, validateCampaignForm, validateCouponForm, validateSlidingForm,
} from "@/lib/offers/manage";

// Each action checks the session itself and the host's plan (offers are a Solo and Duo feature); every query takes the
// signed-in host's id, so another host's coupon, campaign or event type is simply not found.

export type OfferFormState = { status: "idle" } | { status: "saved"; message: string } | { status: "error"; errors: Record<string, string> };

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const list = (form: FormData, name: string) => form.getAll(name).map(String);
const PATH = "/dashboard/offers";

const sayFormError = translator(OFFER_FORM_MESSAGES, {
  percent: "offers.errPercent",
  fixed: "offers.errFixed",
  kind: "offers.errKind",
  maxUses: "offers.errMaxUses",
  maxUsesPerEmail: "offers.errMaxUsesPerEmail",
  code: "offers.errCode",
  expiresOn: "offers.errExpiresOn",
  rupees: "offers.errRupees",
  suggested: "offers.errSuggested",
  note: "offers.errNote",
  name: "offers.errName",
  banner: "offers.errBanner",
  startsOn: "offers.errStartsOn",
  endsOn: "offers.errEndsOn",
  endsPassed: "offers.errEndsPassed",
  endsBeforeStart: "offers.errEndsBeforeStart",
});

/** The validators' English errors in the host's language. */
const inHostLanguage = (t: HostI18n["t"], errors: Record<string, string>) =>
  Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, sayFormError(t, v)]));

/** The host and pool, or the error a form shows when offers aren't available to them. */
async function context(t: HostI18n["t"]): Promise<{ user: User; db: ReturnType<typeof getPool> } | { error: string }> {
  const user = await requireHost();
  if (!authEnabled()) return { error: t("offers.needsPayments") };
  const db = getPool(process.env.DATABASE_URL as string);
  if (!LIMITS[await hostPlan(db, user.id)].offers) return { error: t("offers.needsPlanShort") };
  return { user, db };
}

export async function createCouponAction(_prev: OfferFormState, form: FormData): Promise<OfferFormState> {
  const { t } = await getHostI18n();
  const ctx = await context(t);
  if ("error" in ctx) return { status: "error", errors: { form: ctx.error } };
  const v = validateCouponForm({
    code: field(form, "code"), kind: field(form, "kind"), value: field(form, "value"), expiresOn: field(form, "expiresOn"), maxUses: field(form, "maxUses"),
    maxUsesPerEmail: field(form, "maxUsesPerEmail"), eventTypeIds: list(form, "eventTypeIds"), packageIds: list(form, "packageIds"), membershipPlanIds: list(form, "membershipPlanIds"),
  }, dayKey(new Date(), ctx.user.timezone));
  if (!v.ok) return { status: "error", errors: inHostLanguage(t, v.errors) };
  try {
    await createCoupon(ctx.db, ctx.user.id, ctx.user.timezone, v.value);
  } catch (error) {
    if (isNamedError(error, "DuplicateCodeError")) return { status: "error", errors: { code: t("offers.errDuplicateCode") } };
    if (isNamedError(error, "NotFoundError")) return { status: "error", errors: { form: t("offers.errItemNotFound") } };
    throw error;
  }
  revalidatePath(PATH);
  return { status: "saved", message: t("offers.savedCoupon", { code: v.value.code }) };
}

export async function createCampaignAction(_prev: OfferFormState, form: FormData): Promise<OfferFormState> {
  const { t } = await getHostI18n();
  const ctx = await context(t);
  if ("error" in ctx) return { status: "error", errors: { form: ctx.error } };
  const v = validateCampaignForm({
    name: field(form, "name"), banner: field(form, "banner"), kind: field(form, "kind"), value: field(form, "value"), startsOn: field(form, "startsOn"),
    endsOn: field(form, "endsOn"), eventTypeIds: list(form, "eventTypeIds"), packageIds: list(form, "packageIds"), membershipPlanIds: list(form, "membershipPlanIds"),
  }, dayKey(new Date(), ctx.user.timezone));
  if (!v.ok) return { status: "error", errors: inHostLanguage(t, v.errors) };
  try {
    await createCampaign(ctx.db, ctx.user.id, v.value);
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return { status: "error", errors: { form: t("offers.errItemNotFound") } };
    throw error;
  }
  revalidatePath(PATH);
  return { status: "saved", message: t("offers.savedCampaign", { name: v.value.name, start: v.value.startsOn, end: v.value.endsOn }) };
}

export async function saveFirstSessionAction(_prev: OfferFormState, form: FormData): Promise<OfferFormState> {
  const { t } = await getHostI18n();
  const ctx = await context(t);
  if ("error" in ctx) return { status: "error", errors: { form: ctx.error } };
  const errors: Record<string, string> = {};
  const discount = parseDiscount(field(form, "kind"), field(form, "value"), errors);
  if (!discount) return { status: "error", errors: inHostLanguage(t, errors) };
  const active = field(form, "active") === "on";
  await saveFirstSession(ctx.db, ctx.user.id, discount, active);
  revalidatePath(PATH);
  return { status: "saved", message: active ? t("offers.savedFirstOn") : t("offers.savedFirstOff") };
}

export async function saveSlidingAction(_prev: OfferFormState, form: FormData): Promise<OfferFormState> {
  const { t } = await getHostI18n();
  const ctx = await context(t);
  if ("error" in ctx) return { status: "error", errors: { form: ctx.error } };
  const v = validateSlidingForm({ min: field(form, "min"), suggested: field(form, "suggested"), max: field(form, "max"), note: field(form, "note") });
  if (!v.ok) return { status: "error", errors: inHostLanguage(t, v.errors) };
  try {
    await saveSlidingScale(ctx.db, ctx.user.id, field(form, "eventTypeId"), v.value);
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return { status: "error", errors: { form: t("offers.errSlidingNotFound") } };
    throw error;
  }
  revalidatePath(PATH);
  return { status: "saved", message: t("offers.savedSliding") };
}

export async function removeSlidingAction(form: FormData): Promise<void> {
  const user = await requireHost();
  if (authEnabled()) await removeSlidingScale(getPool(process.env.DATABASE_URL as string), user.id, field(form, "eventTypeId"));
  revalidatePath(PATH);
  redirect(PATH);
}

/** Switching off keeps the record (and uses already counted); switching on again is allowed. */
export async function toggleOffer(form: FormData): Promise<void> {
  const user = await requireHost();
  let target = PATH;
  try {
    const db = getPool(process.env.DATABASE_URL as string);
    const active = field(form, "active") === "on";
    if (field(form, "what") === "campaign") await setCampaignActive(db, user.id, field(form, "id"), active);
    else await setCouponActive(db, user.id, field(form, "id"), active);
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
    target = `${PATH}?error=not_found`;
  }
  revalidatePath(PATH);
  redirect(target);
}
