import { randomBytes } from "node:crypto";
import { fillTemplate } from "../i18n/host/lib-messages";
import { InvalidOneOffError, type OneOffInput } from "./types";

export const MAX_ONE_OFF_TIMES = 20;

/** Every error checkOneOff gives, as code -> English template. The dashboard shows each in the host's language. */
export const ONE_OFF_MESSAGES = {
  name: "Enter a name (up to 100 characters).",
  duration: "Duration must be 5 to 720 minutes.",
  timesCount: "Offer 1 to {n} times.",
  timesFuture: "Every time must be in the future.",
  timesOnce: "Each time can be offered once.",
} as const;
const M = ONE_OFF_MESSAGES;

/** The rules both stores apply to a new one-off meeting. Returns its times earliest first. */
export function checkOneOff(input: OneOffInput, now: Date): Date[] {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 100) throw new InvalidOneOffError("name", M.name);
  if (!Number.isInteger(input.durationMinutes) || input.durationMinutes < 5 || input.durationMinutes > 720) {
    throw new InvalidOneOffError("durationMinutes", M.duration);
  }
  const times = input.times;
  if (times.length < 1 || times.length > MAX_ONE_OFF_TIMES) throw new InvalidOneOffError("times", fillTemplate(M.timesCount, { n: MAX_ONE_OFF_TIMES }));
  if (times.some((t) => Number.isNaN(t.getTime()) || t.getTime() <= now.getTime())) throw new InvalidOneOffError("times", M.timesFuture);
  if (new Set(times.map((t) => t.getTime())).size !== times.length) throw new InvalidOneOffError("times", M.timesOnce);
  return [...times].sort((a, b) => a.getTime() - b.getTime());
}

/** `one-off-` and 8 random lowercase letters or digits. */
export function oneOffSlug(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return `one-off-${Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join("")}`;
}
