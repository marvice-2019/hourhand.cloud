import type { Checked, FieldErrors } from "./availability";

// Pure checks for named availability schedules. Error keys match the input ids on the availability page.

export const MAX_SCHEDULE_NAME = 60;

/** A schedule's name and time zone as typed: the name trimmed, 1 to 60 characters; the zone a real IANA zone. */
export function validateSchedule(input: { name: unknown; timezone: unknown }, isZone: (tz: unknown) => tz is string): Checked<{ name: string; timezone: string }> {
  const errors: FieldErrors = {};
  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (!name) errors["schedule-name"] = "Give this schedule a name, like “Clinic” or “Evenings”.";
  else if (name.length > MAX_SCHEDULE_NAME) errors["schedule-name"] = `Keep the name to ${MAX_SCHEDULE_NAME} characters.`;
  if (!isZone(input.timezone)) errors["schedule-timezone"] = "Pick a time zone from the list.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: { name, timezone: input.timezone as string } };
}

/** "Copy of Clinic", then "Copy of Clinic (2)" and so on, skipping names the host already uses (any case). */
export function copyName(source: string, taken: readonly string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const base = `Copy of ${source}`.slice(0, MAX_SCHEDULE_NAME);
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const name = base.slice(0, MAX_SCHEDULE_NAME - suffix.length) + suffix;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/**
 * Which schedules a day off (holidays, a blocked stretch) goes on: `scope` "all" means every schedule the host has,
 * anything else just the one being edited. Ids only ever come from the host's own list.
 */
export function blockTargets(scope: unknown, currentId: string, schedules: readonly { id: string }[]): string[] {
  if (scope === "all") return schedules.map((s) => s.id);
  return schedules.some((s) => s.id === currentId) ? [currentId] : [];
}

/**
 * The time zones to offer, keeping each of `keep` even when this runtime's list lacks it: Node lists India as the old
 * "Asia/Calcutta", while hosts and schedules are stored as "Asia/Kolkata".
 */
export function zoneOptions(...keep: string[]): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  const missing = [...new Set(keep)].filter((z) => !zones.includes(z));
  return [...missing, ...zones];
}
