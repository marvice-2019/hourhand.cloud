"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError, LOCATION_KINDS, type LocationKind, type NotFoundError } from "@/lib/data/types";
import { formatDate, formatTime } from "@/lib/format";
import { parseLocalTimes } from "@/lib/links-form";
import { cancelPoll, confirmPoll, createPoll, type Clash, type InvalidPollError, type PollLimitError } from "@/lib/polls/polls";

// Each action checks the session itself; every query takes the signed-in host's id, so another host's poll is simply
// not found. Polls live in Postgres only.

export type PollFormState = { status: "idle" } | { status: "error"; message: string };
export type ConfirmState = { status: "idle" } | { status: "error"; messages: string[] };

const field = (form: FormData, name: string) => String(form.get(name) ?? "").trim();
const db = () => getPool(process.env.DATABASE_URL as string);
const NO_DB = "Meeting polls need the database, which this demo copy doesn't have.";

export async function createPollAction(_prev: PollFormState, form: FormData): Promise<PollFormState> {
  const user = await requireHost();
  if (!authEnabled()) return { status: "error", message: NO_DB };
  const kind = field(form, "locationKind") as LocationKind;
  if (!LOCATION_KINDS.includes(kind)) return { status: "error", message: "Pick where you'll meet." };
  const times = parseLocalTimes(form.getAll("times").map(String), user.timezone);
  if (!times.ok) return { status: "error", message: times.error };
  const deadlineRaw = field(form, "deadline");
  const deadline = deadlineRaw ? parseLocalTimes([deadlineRaw], user.timezone) : null;
  if (deadline && !deadline.ok) return { status: "error", message: "The voting deadline isn't a date and time." };
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
    if (isNamedError<InvalidPollError>(error, "InvalidPollError")) return { status: "error", message: error.message };
    if (isNamedError<PollLimitError>(error, "PollLimitError")) {
      return { status: "error", message: "Free includes one open poll at a time. Confirm or cancel your open poll, or move to Solo for as many as you like." };
    }
    throw error;
  }
  revalidatePath("/dashboard/polls");
  redirect(`/dashboard/polls/${id}?done=created`);
}

/** What stands in the way, in the host's words and time zone. */
function clashLine(c: Clash, tz: string): string {
  switch (c.kind) {
    case "past": return "That time has already passed.";
    case "calendar_stale": return "Your calendar hasn't synced recently, so Hourhand can't tell if that time is still free. Check Calendars, then try again.";
    case "calendar": return `Your calendar is busy ${formatTime(c.start, tz)} to ${formatTime(c.end, tz)} on ${formatDate(c.start, tz)}.`;
    case "booking": return c.guestName ? `You're booked with ${c.guestName} at ${formatTime(c.start, tz)} on ${formatDate(c.start, tz)}.` : "Another booking just took that time.";
  }
}

export async function confirmPollAction(_prev: ConfirmState, form: FormData): Promise<ConfirmState> {
  const user = await requireHost();
  if (!authEnabled()) return { status: "error", messages: [NO_DB] };
  const pollId = field(form, "pollId");
  try {
    const result = await confirmPoll(db(), user.id, pollId, field(form, "optionId"), new Date());
    if (result.status === "nobody") return { status: "error", messages: ["Nobody said yes or if needed to that time, so there's no one to book."] };
    if (result.status === "clash") return { status: "error", messages: ["Nothing was booked. That time clashes with:", ...result.clashes.map((c) => clashLine(c, user.timezone))] };
  } catch (error) {
    if (isNamedError<NotFoundError>(error, "NotFoundError")) return { status: "error", messages: ["That poll or time isn't yours, or no longer exists."] };
    if (isNamedError(error, "PollStateError")) return { status: "error", messages: ["This poll is already decided or cancelled."] };
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
    if (!authEnabled()) throw new Error(NO_DB);
    await cancelPoll(db(), user.id, pollId, new Date());
  } catch (error) {
    if (!isNamedError(error, "NotFoundError")) throw error;
    target = `/dashboard/polls/${pollId}?error=not_cancellable`;
  }
  revalidatePath("/dashboard/polls");
  redirect(target);
}
