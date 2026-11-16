"use server";

import { revalidatePath } from "next/cache";
import { requireOwnAccount } from "@/lib/auth/session";
import { store } from "@/lib/data";
import { runImport, runPreview, type ImportResult, type PreviewState } from "@/lib/import";
import { previewKey } from "@/lib/import/sealed-preview";
import { rateLimiter } from "@/lib/rate-limit";

// Owner only: a Duo second person managing this account is sent away by requireOwnAccount. The token is read from the
// form, used for this one fetch and dropped; it is never stored, returned or logged.

export async function fetchImportPreview(_prev: PreviewState, form: FormData): Promise<PreviewState> {
  const user = await requireOwnAccount();
  return runPreview(user.id, { provider: form.get("provider"), token: form.get("token"), username: form.get("username") },
    { limiter: rateLimiter, key: previewKey(), now: Date.now() });
}

export async function importSelected(sealed: string, sourceIds: string[]): Promise<ImportResult> {
  const user = await requireOwnAccount();
  const result = await runImport(store, user.id, sealed, sourceIds, { key: previewKey(), now: Date.now() });
  if (result.ok) {
    revalidatePath("/dashboard/event-types");
    revalidatePath(`/${user.slug}`, "layout");
  }
  return result;
}
