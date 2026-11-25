"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { addEndpoint, deleteEndpoint, queuePing, WEBHOOK_EVENTS } from "@/lib/webhooks/webhooks";
import { kickJobs } from "@/lib/jobs/kick";

const PAGE = "/dashboard/integrations";
const done = (q: string) => { revalidatePath(PAGE); redirect(`${PAGE}?webhook=${q}#webhooks`); };

/** Adds a webhook for the signed-in host (their own account, not an assistant acting for them). */
export async function addWebhook(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect(PAGE);
  const events = WEBHOOK_EVENTS.filter((e) => form.get(e) === "on");
  const r = await addEndpoint(getPool(process.env.DATABASE_URL as string), user.id, String(form.get("url") ?? ""), events);
  done(r.ok ? "added" : r.error);
}

/** Removes one of the host's own webhooks; anyone else's is "not found". */
export async function deleteWebhook(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect(PAGE);
  try {
    await deleteEndpoint(getPool(process.env.DATABASE_URL as string), user.id, String(form.get("id") ?? ""));
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
  }
  done("deleted");
}

/** Sends a test delivery to one of the host's own webhooks now. */
export async function pingWebhook(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect(PAGE);
  try {
    await queuePing(getPool(process.env.DATABASE_URL as string), user.id, String(form.get("id") ?? ""), new Date());
    kickJobs();
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
  }
  done("ping");
}
