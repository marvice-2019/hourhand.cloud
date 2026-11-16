"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError, LOCATION_KINDS, type LocationKind, type NotFoundError } from "@/lib/data/types";
import type { HostI18n } from "@/lib/i18n/host/format";
import { translator } from "@/lib/i18n/host/lib-messages";
import { getHostI18n } from "@/lib/i18n/host/server";
import { LINK_MESSAGES, parseLocalTimes } from "@/lib/links-form";
import { cancelPoll, confirmPoll, createPoll, POLL_MESSAGES, type Clash, type InvalidPollError, type PollLimitError } from "@/lib/polls/polls";

// Each action checks the session itself; every query takes the signed-in host's id, so another host's poll is simply
// not found. Polls live in Postgres only.

export type PollFormState = { status: "idle" } | { status: "error"; message: string };
export type ConfirmState = { status: "idle" } | { status: "error"; messages: string[] };

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const db = () => getPool(process.env.DATABASE_URL as string);

// src/lib/links-form.ts and src/lib/polls/polls.ts word their errors in English; each is shown as the same line in the
// host's language.
const sayTimes = translator(LINK_MESSAGES, {
  timeNotDateTime: "links.errTimeNotDateTime",
  timeNotRealDate: "links.errTimeNotRealDate",
  timeClockChange: "links.errTimeClockChange",
});
const sayPoll = translator(POLL_MESSAGES, {
  title: "polls.errTitle",
  description: "polls.errDescription",
  duration: "polls.errDuration",
  location: "polls.errLocation",
  locationAddress: "polls.errLocationAddress",
  locationPhone: "polls.errLocationPhone",
  locationDetails: "polls.errLocationDetails",
  timesAhead: "polls.errTimesAhead",
  timesCount: "polls.errTimesCount",
  timesFuture: "polls.errTimesFuture",
  timesOnce: "polls.errTimesOnce",
  deadlineFuture: "polls.errDeadlineFuture",
  deadlineFirst: "polls.errDeadlineFirst",
  deadlineMax: "polls.errDeadlineMax",
});

export async function createPollAction(_prev: PollFormState, form: FormData): Promise<PollFormState> {
  const user = await requireHost();
  const { t } = await getHostI18n();
  if (!authEnabled()) return { status: "error", message: t("polls.noDb") };
  const kind = field(form, "locationKind") as LocationKind;
  if (!LOCATION_KINDS.includes(kind)) return { status: "error", message: t("polls.errLocation") };
  const times = parseLocalTimes(form.getAll("times").map(String), user.timezone);
  if (!times.ok) return { status: "error", message: sayTimes(t, times.error) };
  const deadlineRaw = field(form, "deadline");
  const deadline = deadlineRaw ? parseLocalTimes([deadlineRaw], user.timezone) : null;
  if (deadline && !deadline.ok) return { status: "error", message: t("polls.errDeadlineFormat") };
  const duration = Number(field(form, "durationMinutes"));
  let id: string;
  try {
    const pool = db();
    const poll = await createPoll(pool, user.id, {
      title: field(form, "title"), description: field(form, "description") || null, durationMinutes: Number.isInteger(duration) ? duration : 0,
      location: { kind, value: field(form, "locationValue") || null }, times: times.times, holdTimes: form.get("holdTimes") === "on",
      deadline: deadline && deadline.ok ? deadline.times[0] : null,
    }, await hostPlan(pool, user.id), new Date());
    id = poll.id;
  } catch (error) {
    if (isNamedError<InvalidPollError>(error, "InvalidPollError")) return { status: "error", message: sayPoll(t, error.message) };
    if (isNamedError<PollLimitError>(error, "PollLimitError")) {
      return { status: "error", message: t("polls.errFreeLimit") };
    }
    throw error;
  }
  revalidatePath("/dashboard/polls");
  redirect(`/dashboard/polls/${id}?done=created`);
}

/** What stands in the way, in the host's words and time zone. */
function clashLine(c: Clash, tz: string, { t, date, time }: HostI18n): string {
  switch (c.kind) {
    case "past": return t("polls.clashPast");
    case "calendar_stale": return t("polls.clashStale");
    case "calendar": return t("polls.clashCalendar", { start: time(c.start, tz), end: time(c.end, tz), date: date(c.start, tz) });
    case "booking": return c.guestName ? t("polls.clashBooking", { name: c.guestName, time: time(c.start, tz), date: date(c.start, tz) }) : t("polls.clashBookingAnon");
  }
}

export async function confirmPollAction(_prev: ConfirmState, form: FormData): Promise<ConfirmState> {
  const user = await requireHost();
  const i18n = await getHostI18n();
  const { t } = i18n;
  if (!authEnabled()) return { status: "error", messages: [t("polls.noDb")] };
  const pollId = field(form, "pollId");
  try {
    const result = await confirmPoll(db(), user.id, pollId, field(form, "optionId"), new Date());
    if (result.status === "nobody") return { status: "error", messages: [t("polls.errNobody")] };
    if (result.status === "clash") return { status: "error", messages: [t("polls.errClashes"), ...result.clashes.map((c) => clashLine(c, user.timezone, i18n))] };
  } catch (error) {
    if (isNamedError<NotFoundError>(error, "NotFoundError")) return { status: "error", messages: [t("polls.errNotFound")] };
    if (isNamedError(error, "PollStateError")) return { status: "error", messages: [t("polls.errDecided")] };
    throw error;
  }
  revalidatePath("/dashboard/polls");
  revalidatePath("/dashboard/bookings");
  redirect(`/dashboard/polls/${pollId}?done=confirmed`);
}

export async function cancelPollAction(form: FormData): Promise<void> {
  const user = await requireHost();
  const pollId = field(form, "pollId");
  let target = `/dashboard/polls/${pollId}?done=cancelled`;
  try {
    if (!authEnabled()) throw new Error((await getHostI18n()).t("polls.noDb"));
    await cancelPoll(db(), user.id, pollId, new Date());
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
    target = `/dashboard/polls/${pollId}?error=not_cancellable`;
  }
  revalidatePath("/dashboard/polls");
  redirect(target);
}
