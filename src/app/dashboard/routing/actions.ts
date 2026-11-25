"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { translator } from "@/lib/i18n/host/lib-messages";
import { getHostI18n } from "@/lib/i18n/host/server";
import {
  createRoutingForm, deleteRoutingForm, ROUTING_LIMITS, ROUTING_MESSAGES, updateRoutingForm, type InvalidRoutingFormError, type RoutingFormInput,
} from "@/lib/routing/routing";

// Each action checks the session itself and is for the account owner only; every query takes the owner's id, so
// another host's form is simply not found.

export type RoutingFormState = { status: "idle" } | { status: "error"; message: string };

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const db = () => getPool(process.env.DATABASE_URL as string);

const say = translator(ROUTING_MESSAGES, {
  title: "routing.errTitle",
  question: "routing.errQuestion",
  optionCount: "routing.errOptionCount",
  optionLabel: "routing.errOptionLabel",
  optionTarget: "routing.errOptionTarget",
  optionMessage: "routing.errOptionMessage",
  eventType: "routing.errEventType",
  limit: "routing.errLimit",
});

/** The form's fields: rows label-<n>, target-<n> (a booking type id, or empty for a note) and note-<n>. */
function readForm(form: FormData): RoutingFormInput {
  const options = Array.from({ length: ROUTING_LIMITS.maxOptions }, (_, i) => {
    const target = field(form, `target-${i}`);
    return { label: field(form, `label-${i}`), eventTypeId: target || null, message: target ? null : field(form, `note-${i}`) || null };
  });
  return { title: field(form, "title"), question: field(form, "question"), active: form.get("active") === "on", options };
}

export async function saveRoutingFormAction(_prev: RoutingFormState, form: FormData): Promise<RoutingFormState> {
  const user = await requireOwnAccount();
  const { t } = await getHostI18n();
  if (!authEnabled()) return { status: "error", message: t("routing.noDb") };
  const id = field(form, "id");
  let target: string;
  try {
    if (id) {
      await updateRoutingForm(db(), user.id, id, readForm(form));
      target = `/dashboard/routing/${id}?done=saved`;
    } else {
      const made = await createRoutingForm(db(), user.id, readForm(form));
      target = `/dashboard/routing/${made.id}?done=created`;
    }
  } catch (error) {
    if (isNamedError<InvalidRoutingFormError>(error, "InvalidRoutingFormError")) return { status: "error", message: say(t, error.message) };
    if (isNamedError(error, "NotFoundError")) return { status: "error", message: t("routing.notFound") };
    throw error;
  }
  revalidatePath("/dashboard/routing");
  redirect(target);
}

export async function deleteRoutingFormAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect("/dashboard/routing");
  try {
    await deleteRoutingForm(db(), user.id, field(form, "id"));
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
  }
  revalidatePath("/dashboard/routing");
  redirect("/dashboard/routing?done=deleted");
}
