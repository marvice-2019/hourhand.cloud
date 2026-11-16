"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireHost } from "@/lib/auth/session";
import { store } from "@/lib/data";
import { isNamedError, LOCATION_KINDS, type InvalidOneOffError, type LocationKind } from "@/lib/data/types";
import { ONE_OFF_MESSAGES } from "@/lib/data/one-off";
import type { HostKey } from "@/lib/i18n/host";
import { translator } from "@/lib/i18n/host/lib-messages";
import { getHostI18n } from "@/lib/i18n/host/server";
import { LINK_MESSAGES, parseLocalTimes } from "@/lib/links-form";
import { videoGateError } from "@/lib/video/gate";
import { videoAvailabilityFor } from "@/lib/video/server";

// Each action checks the session itself; every store call takes the signed-in host's id, so another host's link or
// event type is simply not found. The raw link is returned once, here, and never stored.

export type LinkFormState =
  | { status: "idle" }
  | { status: "created"; path: string }
  | { status: "error"; message: string };

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const MAX_LABEL = 100;

/** Locations whose value the host must fill in, with the error when it is missing. */
const MISSING_VALUE: Partial<Record<LocationKind, HostKey>> = {
  in_person: "links.errAddAddress",
  phone_guest_calls: "links.errAddPhone",
  custom: "links.errAddDetails",
};

// src/lib/links-form.ts and the store word their errors in English; each is shown as the same line in the host's language.
const sayTimes = translator(LINK_MESSAGES, {
  timeNotDateTime: "links.errTimeNotDateTime",
  timeNotRealDate: "links.errTimeNotRealDate",
  timeClockChange: "links.errTimeClockChange",
});
const sayOneOff = translator(ONE_OFF_MESSAGES, {
  name: "links.errName",
  duration: "links.errDuration",
  timesCount: "links.errTimesCount",
  timesFuture: "links.errTimesFuture",
  timesOnce: "links.errTimesOnce",
});

export async function createSingleUseLink(_prev: LinkFormState, form: FormData): Promise<LinkFormState> {
  const user = await requireHost();
  const { t } = await getHostI18n();
  const eventTypeId = field(form, "eventTypeId");
  const label = field(form, "label");
  if (!eventTypeId) return { status: "error", message: t("links.errPickEventType") };
  if (label.length > MAX_LABEL) return { status: "error", message: t("links.errNoteTooLong", { n: MAX_LABEL }) };
  try {
    const { token } = await store.createBookingLink(user.id, eventTypeId, { label: label || undefined }, new Date());
    revalidatePath("/dashboard/links");
    return { status: "created", path: `/l/${token}` };
  } catch (error) {
    if (isNamedError(error, "NotFoundError")) return { status: "error", message: t("links.errEventTypeUnavailable") };
    throw error;
  }
}

export async function createOneOff(_prev: LinkFormState, form: FormData): Promise<LinkFormState> {
  const user = await requireHost();
  const { t } = await getHostI18n();
  const name = field(form, "name");
  const duration = Number(field(form, "durationMinutes"));
  const kind = field(form, "locationKind") as LocationKind;
  const value = field(form, "locationValue");
  const description = field(form, "description");
  if (!LOCATION_KINDS.includes(kind)) return { status: "error", message: t("links.errPickLocation") };
  const missing = MISSING_VALUE[kind];
  if (missing && !value) return { status: "error", message: t(missing) };
  if (description.length > 2000) return { status: "error", message: t("links.errDescriptionTooLong") };
  // Hourhand video needs the Jitsi settings on this server and a Solo or Duo plan (a one-off is always a new choice).
  if (kind === "hourhand_video") {
    const gate = videoGateError({ chosen: true, alreadyChosen: false, availability: await videoAvailabilityFor(user.id) });
    if (gate) return { status: "error", message: t(gate === "plan" ? "links.videoNeedsPlan" : "links.videoNotSetUp") };
  }
  const rawTimes = form.getAll("times").map(String);
  const parsed = parseLocalTimes(rawTimes, user.timezone);
  if (!parsed.ok) return { status: "error", message: sayTimes(t, parsed.error) };
  try {
    const { token } = await store.createOneOffMeeting(user.id, {
      name, durationMinutes: Number.isInteger(duration) ? duration : 0, description: description || null,
      location: { kind, value: missing ? value : null }, times: parsed.times,
    }, new Date());
    revalidatePath("/dashboard/links");
    return { status: "created", path: `/l/${token}` };
  } catch (error) {
    if (isNamedError<InvalidOneOffError>(error, "InvalidOneOffError")) return { status: "error", message: sayOneOff(t, error.message) };
    throw error;
  }
}

export async function revokeLink(form: FormData): Promise<void> {
  const user = await requireHost();
  let target = "/dashboard/links?done=revoked";
  try {
    await store.revokeBookingLink(user.id, field(form, "linkId"), new Date());
  } catch (error) {
    if (!(isNamedError(error, "NotFoundError"))) throw error;
    target = "/dashboard/links?error=not_revocable";
  }
  revalidatePath("/dashboard/links");
  redirect(target);
}
