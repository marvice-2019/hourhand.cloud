"use server";

import { revalidatePath } from "next/cache";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { getHostI18n } from "@/lib/i18n/host/server";
import { translator } from "@/lib/i18n/host/lib-messages";
import { removePhoto, saveProfile, savePhoto, validateProfile, PROFILE_MESSAGES, type PhotoRejectedError } from "@/lib/profile";

// Each action checks the session itself and writes only the signed-in host's own row.

export type ProfileFormState = { status: "idle" } | { status: "saved" } | { status: "error"; errors: Record<string, string> };

// validateProfile (src/lib/profile.ts) words its errors in English; each is shown as the same line in the host's language.
const say = translator(PROFILE_MESSAGES, {
  headline: "profile.errHeadline",
  bio: "profile.errBio",
  area: "profile.errArea",
  whatsapp: "profile.errWhatsapp",
  instagram: "profile.errInstagram",
  reviewsUrl: "profile.errReviewsUrl",
});
const field = (form: FormData, name: string) => String(form.get(name) ?? "");

export async function saveProfileAction(_prev: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const user = await requireHost();
  const { t } = await getHostI18n();
  if (!authEnabled()) return { status: "error", errors: { form: t("profile.errDemo") } };
  const v = validateProfile(Object.fromEntries(["headline", "bio", "area", "whatsapp", "instagram", "reviewsUrl"].map((k) => [k, field(form, k)])));
  if (!v.ok) return { status: "error", errors: Object.fromEntries(Object.entries(v.errors).map(([name, english]) => [name, say(t, english)])) };
  await saveProfile(getPool(process.env.DATABASE_URL as string), user.id, v.value);
  revalidatePath("/dashboard/profile");
  revalidatePath(`/${user.slug}`);
  return { status: "saved" };
}

export async function savePhotoAction(_prev: ProfileFormState, form: FormData): Promise<ProfileFormState> {
  const user = await requireHost();
  const { t } = await getHostI18n();
  if (!authEnabled()) return { status: "error", errors: { photo: t("profile.errDemo") } };
  const file = form.get("photo");
  if (!(file instanceof File) || file.size === 0) return { status: "error", errors: { photo: t("profile.errNoPhoto") } };
  try {
    await savePhoto(getPool(process.env.DATABASE_URL as string), user.id, new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    if (isNamedError<PhotoRejectedError>(error, "PhotoRejectedError")) {
      return { status: "error", errors: { photo: error.reason === "too_big" ? t("profile.errPhotoTooBig") : t("profile.errPhotoType") } };
    }
    throw error;
  }
  revalidatePath("/dashboard/profile");
  revalidatePath(`/${user.slug}`);
  return { status: "saved" };
}

export async function removePhotoAction(): Promise<void> {
  const user = await requireHost();
  if (!authEnabled()) return;
  await removePhoto(getPool(process.env.DATABASE_URL as string), user.id);
  revalidatePath("/dashboard/profile");
  revalidatePath(`/${user.slug}`);
}
