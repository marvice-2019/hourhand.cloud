"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOwnAccount } from "@/lib/auth/session";
import { isNamedError } from "@/lib/data/types";
import { membershipsAllowed } from "@/lib/memberships/handlers";
import { createMembershipPlan, setPlanActive, validatePlanForm } from "@/lib/memberships/memberships";
import { requestMembershipDeps } from "@/lib/memberships/request-deps";

// Each action checks the session itself; every query takes the signed-in host's id, so another host's plan or event type
// is simply not found.

export type MembershipFormState = { status: "idle" } | { status: "created" } | { status: "error"; errors: Record<string, string> };

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

export async function createMembershipPlanAction(_prev: MembershipFormState, form: FormData): Promise<MembershipFormState> {
  const user = await requireOwnAccount();
  const deps = requestMembershipDeps();
  if (!deps) return { status: "error", errors: { form: "Memberships need payments, which this copy of Hourhand doesn't have." } };
  if (!membershipsAllowed(await deps.planFor(user.id))) return { status: "error", errors: { form: "Memberships come with Solo and Duo. Upgrade under Plan to sell them." } };
  const v = validatePlanForm({
    name: field(form, "name"), sessions: field(form, "sessions"), price: field(form, "price"), rollover: field(form, "rollover"),
    rolloverCap: field(form, "rolloverCap"), eventTypeIds: form.getAll("eventTypeIds").map(String),
  });
  if (!v.ok) return { status: "error", errors: v.errors };
  const auth = await deps.authFor(user.id);
  if (!auth) return { status: "error", errors: { form: "Connect your Razorpay account under Integrations first: members pay you directly." } };
  try {
    await createMembershipPlan({ pool: deps.pool, provider: deps.providerFor(auth) }, user.id, v.value);
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return { status: "error", errors: { eventTypeIds: "One of those event types isn't available. Turn it on first, or pick another." } };
    if (isNamedError(error, "MembershipProviderError")) {
      return { status: "error", errors: { form: "Razorpay didn't create the plan. Check that Subscriptions is enabled on your Razorpay account, then try again." } };
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
