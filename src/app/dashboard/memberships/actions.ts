"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwnAccount } from "@/lib/auth/session";
import { isNamedError } from "@/lib/data/types";
import { getHostI18n } from "@/lib/i18n/host/server";
import { translator } from "@/lib/i18n/host/lib-messages";
import { membershipsAllowed } from "@/lib/memberships/handlers";
import { createMembershipPlan, MEMBERSHIP_PLAN_MESSAGES, setPlanActive, validatePlanForm } from "@/lib/memberships/memberships";
import { requestMembershipDeps } from "@/lib/memberships/request-deps";

// Each action checks the session itself; every query takes the signed-in host's id, so another host's plan or event type
// is simply not found.

export type MembershipFormState = { status: "idle" } | { status: "created" } | { status: "error"; errors: Record<string, string> };

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

const sayPlan = translator(MEMBERSHIP_PLAN_MESSAGES, {
  name: "memberships.errName",
  sessionsRange: "memberships.errSessionsRange",
  priceInvalid: "memberships.errPrice",
  rollover: "memberships.errRollover",
  capRange: "memberships.errCapRange",
  eventTypesNone: "memberships.errEventTypesNone",
  eventTypesMax: "memberships.errEventTypesMax",
});

export async function createMembershipPlanAction(_prev: MembershipFormState, form: FormData): Promise<MembershipFormState> {
  const user = await requireOwnAccount();
  const { t } = await getHostI18n();
  const deps = requestMembershipDeps();
  if (!deps) return { status: "error", errors: { form: t("memberships.needsPayments") } };
  if (!membershipsAllowed(await deps.planFor(user.id))) return { status: "error", errors: { form: t("memberships.errNeedsPlan") } };
  const v = validatePlanForm({
    name: field(form, "name"), sessions: field(form, "sessions"), price: field(form, "price"), rollover: field(form, "rollover"),
    rolloverCap: field(form, "rolloverCap"), eventTypeIds: form.getAll("eventTypeIds").map(String),
  });
  if (!v.ok) return { status: "error", errors: Object.fromEntries(Object.entries(v.errors).map(([k, m]) => [k, sayPlan(t, m)])) };
  const auth = await deps.authFor(user.id);
  if (!auth) return { status: "error", errors: { form: t("memberships.errConnectRazorpay") } };
  try {
    await createMembershipPlan({ pool: deps.pool, provider: deps.providerFor(auth) }, user.id, v.value);
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return { status: "error", errors: { eventTypeIds: t("memberships.errEventTypeUnavailable") } };
    if (isNamedError(error, "MembershipProviderError")) {
      return { status: "error", errors: { form: t("memberships.errProvider") } };
    }
    throw error;
  }
  revalidatePath("/dashboard/memberships");
  return { status: "created" };
}

export async function toggleMembershipPlan(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const deps = requestMembershipDeps();
  let target = "/dashboard/memberships";
  try {
    if (!deps) throw new Error("Memberships need payments");
    await setPlanActive(deps.pool, user.id, field(form, "planId"), field(form, "active") === "on");
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
    target = "/dashboard/memberships?error=not_found";
  }
  revalidatePath("/dashboard/memberships");
  redirect(target);
}
