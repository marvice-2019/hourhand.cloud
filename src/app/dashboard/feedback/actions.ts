"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { setReviewShown, setShowReviews } from "@/lib/follow-ups/public-reviews";

const PAGE = "/dashboard/feedback";

/** Turns reviews on the host's public booking page on or off (the host themselves, not an assistant acting for them). */
export async function saveShowReviews(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect(PAGE);
  const on = form.get("showReviews") === "on";
  await setShowReviews(getPool(process.env.DATABASE_URL as string), user.id, on, new Date());
  revalidatePath(PAGE);
  revalidatePath(`/${user.slug}`);
  redirect(`${PAGE}?page=${on ? "on" : "off"}`);
}

/** Shows or hides one review on the page. Only the host's own, and showing only one the guest agreed to. */
export async function toggleReview(form: FormData): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect(PAGE);
  try {
    await setReviewShown(getPool(process.env.DATABASE_URL as string), user.id, String(form.get("bookingId") ?? ""), form.get("show") === "1");
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
  }
  revalidatePath(PAGE);
  revalidatePath(`/${user.slug}`);
  redirect(PAGE);
}
