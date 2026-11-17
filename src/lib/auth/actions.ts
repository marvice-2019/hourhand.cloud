"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { authEnabled, getAuth } from "./auth";
import { store } from "@/lib/data";
import { DELETE_ACCOUNT_MESSAGES } from "./delete-account-messages";
import { isPhonePlaceholderEmail, normalizePhone } from "./phone";
import { requireUser } from "./session";

export async function signOut(): Promise<void> {
  if (authEnabled()) await getAuth().api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

export type DeleteAccountState = { error?: string };

/**
 * Closes the signed-in host's account after they type their email to confirm. Their links stop working at once,
 * upcoming bookings are cancelled, every session ends, and the data is purged 30 days later.
 */
export async function deleteMyAccount(_prev: DeleteAccountState, form: FormData): Promise<DeleteAccountState> {
  const user = await requireUser();
  if (!authEnabled()) return { error: DELETE_ACCOUNT_MESSAGES.demo };
  const typed = String(form.get("confirm-email") ?? "").trim().toLowerCase();
  if (isPhonePlaceholderEmail(user.email)) {
    // A phone sign-up's email is a placeholder made from the number's digits: they confirm with the number instead.
    if (normalizePhone(typed) !== `+${user.email.split("@")[0]}`) return { error: DELETE_ACCOUNT_MESSAGES.phone };
  } else if (typed !== user.email.toLowerCase()) return { error: DELETE_ACCOUNT_MESSAGES.email };
  await store.deleteAccount(user.id);
  redirect("/sign-in?closed=1");
}

/** Ends every session this host has, on every device, including this one. */
export async function signOutEverywhere(): Promise<void> {
  await requireUser();
  if (authEnabled()) await getAuth().api.revokeSessions({ headers: await headers() });
  redirect("/sign-in");
}

export type AddEmailState = { status: "idle" | "sent" | "invalid" | "failed"; email?: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sends a confirmation link to the email a phone sign-up wants to add. The address is saved only when that link is
 * opened. An address another account already uses gets no link, and the answer is the same either way so this can't
 * be used to find out who has an account.
 */
export async function addEmail(_prev: AddEmailState, form: FormData): Promise<AddEmailState> {
  await requireUser();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email) || email.length > 254 || isPhonePlaceholderEmail(email)) return { status: "invalid", email };
  if (!authEnabled()) return { status: "failed", email };
  try {
    await getAuth().api.changeEmail({ body: { newEmail: email, callbackURL: "/dashboard/settings?saved=email" }, headers: await headers() });
  } catch (error) {
    console.error("add email failed", error instanceof Error ? error.message : error);
    return { status: "failed", email };
  }
  return { status: "sent", email };
}
