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
import {
  createCampaign, createCoupon, parseDiscount, removeSlidingScale, saveFirstSession, saveSlidingScale, setCampaignActive, setCouponActive,
  validateCampaignForm, validateCouponForm, validateSlidingForm,
} from "@/lib/offers/manage";

// Each action checks the session itself and the host's plan (offers are a Solo and Duo feature); every query takes the
// signed-in host's id, so another host's coupon, campaign or event type is simply not found.

export type OfferFormState = { status: "idle" } | { status: "saved"; message: string } | { status: "error"; errors: Record<string, string> };

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const list = (form: FormData, name: string) => form.getAll(name).map(String);
const PATH = "/dashboard/offers";

/** The host and pool, or the error a form shows when offers aren't available to them. */
async function context(): Promise<{ user: User; db: ReturnType<typeof getPool> } | { error: string }> {
  const user = await requireHost();
  if (!authEnabled()) return { error: "Offers need payments, which this demo copy doesn't have." };
  const db = getPool(process.env.DATABASE_URL as string);
  if (!LIMITS[await hostPlan(db, user.id)].offers) return { error: "Offers come with the Solo and Duo plans. Choose one under Plan." };
  return { user, db };
}

export async function createCouponAction(_prev: OfferFormState, form: FormData): Promise<OfferFormState> {
  const ctx = await context();
  if ("error" in ctx) return { status: "error", errors: { form: ctx.error } };
  const v = validateCouponForm({
    code: field(form, "code"), kind: field(form, "kind"), value: field(form, "value"), expiresOn: field(form, "expiresOn"), maxUses: field(form, "maxUses"),
    maxUsesPerEmail: field(form, "maxUsesPerEmail"), eventTypeIds: list(form, "eventTypeIds"), packageIds: list(form, "packageIds"), membershipPlanIds: list(form, "membershipPlanIds"),
  }, dayKey(new Date(), ctx.user.timezone));
  if (!v.ok) return { status: "error", errors: v.errors };
  try {
    await createCoupon(ctx.db, ctx.user.id, ctx.user.timezone, v.value);
  } catch (error) {
    if (isNamedError(error, "DuplicateCodeError")) return { status: "error", errors: { code: "You already have that code. Pick another, or switch the old one back on." } };
    if (isNamedError(error, "NotFoundError")) return { status: "error", errors: { form: "One of the event types, packages or memberships isn't yours or no longer exists." } };
    throw error;
  }
  revalidatePath(PATH);
  return { status: "saved", message: `Code ${v.value.code} is live. Share it with your clients.` };
}

export async function createCampaignAction(_prev: OfferFormState, form: FormData): Promise<OfferFormState> {
  const ctx = await context();
  if ("error" in ctx) return { status: "error", errors: { form: ctx.error } };
  const v = validateCampaignForm({
    name: field(form, "name"), banner: field(form, "banner"), kind: field(form, "kind"), value: field(form, "value"), startsOn: field(form, "startsOn"),
    endsOn: field(form, "endsOn"), eventTypeIds: list(form, "eventTypeIds"), packageIds: list(form, "packageIds"), membershipPlanIds: list(form, "membershipPlanIds"),
  }, dayKey(new Date(), ctx.user.timezone));
  if (!v.ok) return { status: "error", errors: v.errors };
  try {
    await createCampaign(ctx.db, ctx.user.id, v.value);
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return { status: "error", errors: { form: "One of the event types, packages or memberships isn't yours or no longer exists." } };
    throw error;
  }
  revalidatePath(PATH);
  return { status: "saved", message: `${v.value.name} runs ${v.value.startsOn} to ${v.value.endsOn} (your time zone).` };
}

export async function saveFirstSessionAction(_prev: OfferFormState, form: FormData): Promise<OfferFormState> {
  const ctx = await context();
  if ("error" in ctx) return { status: "error", errors: { form: ctx.error } };
  const errors: Record<string, string> = {};
  const discount = parseDiscount(field(form, "kind"), field(form, "value"), errors);
  if (!discount) return { status: "error", errors };
  const active = field(form, "active") === "on";
  await saveFirstSession(ctx.db, ctx.user.id, discount, active);
  revalidatePath(PATH);
  return { status: "saved", message: active ? "New clients now get this off their first paid session." : "Saved, and switched off." };
}

export async function saveSlidingAction(_prev: OfferFormState, form: FormData): Promise<OfferFormState> {
  const ctx = await context();
  if ("error" in ctx) return { status: "error", errors: { form: ctx.error } };
  const v = validateSlidingForm({ min: field(form, "min"), suggested: field(form, "suggested"), max: field(form, "max"), note: field(form, "note") });
  if (!v.ok) return { status: "error", errors: v.errors };
  try {
    await saveSlidingScale(ctx.db, ctx.user.id, field(form, "eventTypeId"), v.value);
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return { status: "error", errors: { form: "Pay what you can works on your own priced event types. Set a price on it first." } };
    throw error;
  }
  revalidatePath(PATH);
  return { status: "saved", message: "Saved. Clients now pick their amount on the booking page." };
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
