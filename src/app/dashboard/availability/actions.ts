"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { todayIn, validateDateOverride, validateDateRange, validateWeeklyHours, type FieldErrors, type WeeklyHours } from "@/lib/availability";
import { NotFoundError, store, type Interval } from "@/lib/data";
import { isNamedError, type ScheduleInUseError, type ScheduleLimitError } from "@/lib/data/types";
import { requireHost } from "@/lib/auth/session";
import { authEnabled } from "@/lib/auth/auth";
import { scheduleLimit } from "@/lib/billing/account";
import { LIMITS } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { isIanaTimeZone } from "@/lib/booking";
import { pickHolidayDates } from "@/lib/holidays";
import { blockTargets, copyName, validateSchedule } from "@/lib/schedules";

export type FormState = { status: "idle" | "saved" | "error"; errors: FieldErrors; savedAt?: number };

const PATH = "/dashboard/availability";
const pageFor = (scheduleId: string, extra = "") => `${PATH}?schedule=${encodeURIComponent(scheduleId)}${extra}`;

/**
 * The schedule a form is about, from its hidden `schedule` field: it must be one of the signed-in host's, and a form
 * without one means the default. Never trusts the id beyond that lookup.
 */
async function mySchedule(form: FormData) {
  const user = await requireHost();
  const all = await store.listSchedules(user.id);
  const id = String(form.get("schedule") ?? "");
  const schedule = id ? all.find((s) => s.id === id) : all[0];
  if (!schedule) throw new NotFoundError("Schedule");
  return { user, schedule, all };
}

/** Schedules the host's plan keeps: Free 1, Solo and Duo unlimited. The demo (no sign-in, no billing) gets Solo so visitors can try several. */
async function myScheduleLimit(userId: string): Promise<number> {
  if (!authEnabled()) return LIMITS.solo.schedules;
  return scheduleLimit(getPool(process.env.DATABASE_URL as string), userId);
}

/** Reads ranges named `${prefix}-0-from`, `${prefix}-0-to`, `${prefix}-1-from`, … until one is missing. */
function readRanges(form: FormData, prefix: string): Interval[] {
  const out: Interval[] = [];
  for (let i = 0; form.has(`${prefix}-${i}-from`); i++) {
    out.push({ from: String(form.get(`${prefix}-${i}-from`)), to: String(form.get(`${prefix}-${i}-to`) ?? "") });
  }
  return out;
}

const fail = (errors: FieldErrors): FormState => ({ status: "error", errors });
const saved = (): FormState => ({ status: "saved", errors: {}, savedAt: Date.now() });

export async function saveWeeklyHoursAction(_prev: FormState, form: FormData): Promise<FormState> {
  const hours: WeeklyHours = {};
  for (let day = 0; day < 7; day++) hours[day] = form.get(`w${day}-on`) ? readRanges(form, `w${day}`) : [];
  const checked = validateWeeklyHours(hours);
  if (!checked.ok) return fail(checked.errors);
  const { user, schedule } = await mySchedule(form);
  await store.saveWeeklyHours(user.id, schedule.id, checked.value);
  revalidatePath(PATH);
  return saved();
}

export async function saveDateOverrideAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user, schedule } = await mySchedule(form);
  const intervals = form.get("ov-kind") === "hours" ? readRanges(form, "ov") : [];
  if (form.get("ov-kind") === "hours" && intervals.length === 0) return fail({ "ov-0-from": "Add at least one range." });
  const checked = validateDateOverride(String(form.get("ov-date") ?? ""), intervals, todayIn(schedule.timezone, new Date()));
  if (!checked.ok) return fail(checked.errors);
  await store.saveDateOverride(user.id, schedule.id, checked.value.date, checked.value.intervals);
  revalidatePath(PATH);
  return saved();
}

/** Blocks a stretch of days on this schedule, or with scope "all" on every schedule the host has. */
export async function blockDateRangeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user, schedule, all } = await mySchedule(form);
  const checked = validateDateRange(String(form.get("block-from") ?? ""), String(form.get("block-to") ?? ""), todayIn(schedule.timezone, new Date()));
  if (!checked.ok) return fail(checked.errors);
  for (const id of blockTargets(form.get("scope"), schedule.id, all)) await store.blockDateRange(user.id, id, checked.value.from, checked.value.to);
  revalidatePath(PATH);
  return saved();
}

export async function deleteDateOverrideAction(form: FormData): Promise<void> {
  const { user, schedule } = await mySchedule(form);
  await store.deleteDateOverride(user.id, schedule.id, String(form.get("date") ?? ""));
  revalidatePath(PATH);
}

/** Blocks the ticked gazetted holidays as days off, on this schedule or all of them. Only real upcoming holiday dates are accepted. */
export async function blockHolidaysAction(form: FormData): Promise<void> {
  const { user, schedule, all } = await mySchedule(form);
  const dates = pickHolidayDates(form.getAll("holiday").map(String), todayIn(schedule.timezone, new Date()));
  for (const id of blockTargets(form.get("scope"), schedule.id, all)) {
    for (const date of dates) await store.saveDateOverride(user.id, id, date, []);
  }
  revalidatePath(PATH);
}

export async function createScheduleAction(_prev: FormState, form: FormData): Promise<FormState> {
  const user = await requireHost();
  const checked = validateSchedule({ name: form.get("schedule-name"), timezone: form.get("schedule-timezone") }, isIanaTimeZone);
  if (!checked.ok) return fail(checked.errors);
  let id: string;
  try {
    id = (await store.createSchedule(user.id, checked.value, await myScheduleLimit(user.id))).id;
  } catch (e) {
    if (isNamedError(e, "ScheduleNameTakenError")) return fail({ "schedule-name": e.message });
    if (isNamedError<ScheduleLimitError>(e, "ScheduleLimitError")) return fail({ schedule: e.message });
    throw e;
  }
  revalidatePath(PATH);
  redirect(pageFor(id));
}

export async function updateScheduleAction(_prev: FormState, form: FormData): Promise<FormState> {
  const { user, schedule } = await mySchedule(form);
  const checked = validateSchedule({ name: form.get("schedule-name"), timezone: form.get("schedule-timezone") }, isIanaTimeZone);
  if (!checked.ok) return fail(checked.errors);
  try {
    await store.updateSchedule(user.id, schedule.id, checked.value);
  } catch (e) {
    if (isNamedError(e, "ScheduleNameTakenError")) return fail({ "schedule-name": e.message });
    throw e;
  }
  revalidatePath(PATH);
  revalidatePath("/dashboard/event-types", "layout");
  return saved();
}

/** A copy of the schedule (hours, overrides and zone) named "Copy of …", then opens it. */
export async function duplicateScheduleAction(form: FormData): Promise<void> {
  const { user, schedule, all } = await mySchedule(form);
  let id: string;
  try {
    id = (await store.createSchedule(user.id, { name: copyName(schedule.name, all.map((s) => s.name)), copyFrom: schedule.id }, await myScheduleLimit(user.id))).id;
  } catch (e) {
    if (isNamedError(e, "ScheduleLimitError")) redirect(pageFor(schedule.id, "&error=limit"));
    throw e;
  }
  revalidatePath(PATH);
  redirect(pageFor(id, "&notice=duplicated"));
}

export async function makeDefaultScheduleAction(form: FormData): Promise<void> {
  const { user, schedule } = await mySchedule(form);
  await store.setDefaultSchedule(user.id, schedule.id);
  revalidatePath(PATH);
  revalidatePath("/dashboard/event-types", "layout");
  redirect(pageFor(schedule.id, "&notice=default"));
}

/** Deletes the schedule; event types on it move to `move-to` in the same write, or the delete is refused. */
export async function deleteScheduleAction(form: FormData): Promise<void> {
  const { user, schedule, all } = await mySchedule(form);
  const moveTo = String(form.get("move-to") ?? "");
  const target = all.find((s) => s.id === moveTo && s.id !== schedule.id);
  try {
    await store.deleteSchedule(user.id, schedule.id, target ? { moveTo: target.id } : {});
  } catch (e) {
    if (isNamedError(e, "DefaultScheduleError")) redirect(pageFor(schedule.id, "&error=default"));
    if (isNamedError<ScheduleInUseError>(e, "ScheduleInUseError")) redirect(pageFor(schedule.id, "&error=in_use"));
    throw e;
  }
  revalidatePath(PATH);
  revalidatePath("/dashboard/event-types", "layout");
  redirect(`${PATH}?notice=deleted`);
}
