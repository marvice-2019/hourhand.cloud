"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { acceptPracticeInvite, changeMember, createPractice, inviteMember, leavePractice, removeMember, updatePractice, type ClinicActionError, type MemberChange } from "@/lib/clinic/practices";
import type { ClinicAccessError } from "@/lib/clinic/roles";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { kickJobs } from "@/lib/jobs/kick";

// Every action works from the signed-in person's own account (requireOwnAccount: a Duo second person managing someone
// else's account can't act for them here) and every library call re-checks the person's role in the practice.

const db = () => getPool(process.env.DATABASE_URL as string);
const str = (form: FormData, k: string) => String(form.get(k) ?? "");

/** Runs a practice change and comes back to the page with what happened. Role refusals and rule errors become a message. */
async function run(fn: () => Promise<unknown>, done: string): Promise<never> {
  if (!authEnabled()) redirect("/dashboard/practice?error=demo");
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    if (isNamedError<ClinicActionError>(e, "ClinicActionError")) error = e.code;
    else if (isNamedError<ClinicAccessError>(e, "ClinicAccessError")) error = "forbidden";
    else throw e;
  }
  revalidatePath("/dashboard", "layout");
  redirect(`/dashboard/practice?${error ? `error=${error}` : `done=${done}`}`);
}

export async function createPracticeAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const bring = str(form, "bringSeat");
  await run(() => createPractice(db(), user, { name: str(form, "name"), slug: str(form, "slug"), about: str(form, "about") }, {
    ownerPractises: form.get("ownerPractises") === "on",
    bringSeat: bring === "practitioner" || bring === "admin" ? bring : "none",
  }), "created");
}

export async function updatePracticeAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  await run(() => updatePractice(db(), user.id, { name: str(form, "name"), slug: str(form, "slug"), about: str(form, "about") }), "saved");
}

export async function inviteMemberAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const role = str(form, "role") === "admin" ? "admin" : "practitioner";
  await run(async () => {
    await inviteMember(db(), user.id, str(form, "email"), role, new Date());
    kickJobs();
  }, "invited");
}

export async function changeMemberAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  const change: MemberChange = {};
  const role = str(form, "role");
  if (role === "admin" || role === "practitioner") change.role = role;
  const practises = str(form, "practises");
  if (practises === "true" || practises === "false") change.practises = practises === "true";
  const active = str(form, "active");
  if (active === "true" || active === "false") change.active = active === "true";
  await run(() => changeMember(db(), user.id, str(form, "memberId"), change), "saved");
}

export async function removeMemberAction(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  await run(() => removeMember(db(), user.id, str(form, "memberId")), "removed");
}

export async function acceptPracticeAction(): Promise<void> {
  const user = await requireOwnAccount();
  await run(() => acceptPracticeInvite(db(), user), "joined");
}

export async function leavePracticeAction(): Promise<void> {
  const user = await requireOwnAccount();
  await run(() => leavePractice(db(), user), "left");
}
