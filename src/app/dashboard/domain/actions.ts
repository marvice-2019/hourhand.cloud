"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { systemResolver } from "@/lib/domains/dns";
import { addDomain, checkHostDomain, deleteDomain } from "@/lib/domains/service";
import { hostOf } from "@/lib/domains/validate";

// Each action checks the session itself and changes only the signed-in host's own domain (user_id in every query).
// A Duo second person managing someone else's account is sent away by requireOwnAccount: the domain is the owner's.

const pool = () => getPool(process.env.DATABASE_URL as string);
const appHosts = () => [hostOf(process.env.BETTER_AUTH_URL)].filter((h): h is string => Boolean(h));

export type DomainFormState = { status: "idle" } | { status: "error"; error: string };

export async function saveDomain(_prev: DomainFormState, form: FormData): Promise<DomainFormState> {
  const user = await requireOwnAccount();
  if (!authEnabled()) return { status: "error", error: "The demo data can't use a custom domain. Sign in with the database set up." };
  const result = await addDomain(pool(), user.id, form.get("domain"), { resolver: systemResolver(), appHosts: appHosts() });
  if (!result.ok) return { status: "error", error: result.message };
  revalidatePath("/dashboard/domain");
  redirect("/dashboard/domain?saved=1");
}

export async function checkDomainNow(): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect("/dashboard/domain");
  await checkHostDomain(pool(), user.id, systemResolver());
  revalidatePath("/dashboard/domain");
  redirect("/dashboard/domain?checked=1");
}

export async function removeDomainAction(): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect("/dashboard/domain");
  await deleteDomain(pool(), user.id);
  revalidatePath("/dashboard/domain");
  redirect("/dashboard/domain?removed=1");
}
