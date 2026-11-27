"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createApiKey, deleteApiKey } from "@/lib/api/keys";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";

const PAGE = "/dashboard/integrations";

export type ApiKeyFormState = { status: "idle" } | { status: "made"; id: string; key: string } | { status: "error"; error: "name_missing" | "name_too_long" | "too_many" };

/** Makes a key for the signed-in owner. The key comes back once, in this answer only. */
export async function makeApiKey(_prev: ApiKeyFormState, form: FormData): Promise<ApiKeyFormState> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect(PAGE);
  const r = await createApiKey(getPool(process.env.DATABASE_URL as string), user.id, String(form.get("name") ?? ""));
  revalidatePath(PAGE);
  return r.ok ? { status: "made", id: r.id, key: r.key } : { status: "error", error: r.error };
}

/** Removes one of the owner's keys at once; anyone else's changes nothing. */
export async function removeApiKey(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect(PAGE);
  await deleteApiKey(getPool(process.env.DATABASE_URL as string), user.id, String(form.get("id") ?? ""));
  revalidatePath(PAGE);
  redirect(`${PAGE}?apikey=deleted#api-keys`);
}
