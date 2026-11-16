// Cal.com API v2, read only, with the host's API key (cal_… or cal_live_…) and their own username.
// Docs (checked 2026-11-15): https://cal.com/docs/api-reference/v2/event-types/get-all-event-types
//   GET https://api.cal.com/v2/event-types?username=<username>, header cal-api-version: 2026-06-12 -> { status, data[] }
// The host api.cal.com isn't named in the spec (its servers list is empty); it was confirmed live on 2026-11-15.
import type { LocationKind } from "../data/types";
import { MAX_SEATS } from "../event-types";
import { arr, clampBuffer, clampDuration, durationList, getJson, num, obj, str, text } from "./http";
import { IMPORT_MESSAGES, importMessage } from "./messages";
import { capQuestions, question } from "./questions";
import { ImportError, MAX_IMPORT, type ImportDeps, type ImportedEventType, type ImportedQuestion, type ImportPreview } from "./types";

export const CALCOM_API = "https://api.cal.com";
export const CALCOM_API_VERSION = "2026-06-12";
export const CALCOM_USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const MESSAGES = {
  badToken: IMPORT_MESSAGES.calcomBadToken,
  notFound: IMPORT_MESSAGES.calcomNotFound,
};

export async function fetchCalcom(apiKey: string, username: string, deps: ImportDeps = {}): Promise<ImportPreview> {
  const user = username.trim().replace(/^@/, "");
  if (!CALCOM_USERNAME.test(user)) throw new ImportError("not_found", MESSAGES.notFound);
  const headers = { authorization: `Bearer ${apiKey.trim()}`, "cal-api-version": CALCOM_API_VERSION };
  const body = obj(await getJson("calcom", `${CALCOM_API}/v2/event-types?${new URLSearchParams({ username: user })}`, headers, deps, MESSAGES));
  if (body.status !== undefined && body.status !== "success") throw new ImportError("bad_response", importMessage("unreadableRetry", { label: "Cal.com" }));
  const raw = arr(body.data);
  // An unknown username answers with an empty list rather than a 404.
  if (raw.length === 0) throw new ImportError("not_found", importMessage("calcomNoEventTypes", { user }));

  const preview: ImportPreview = { provider: "calcom", eventTypes: [], skipped: [] };
  for (const item of raw) {
    const r = obj(item);
    const name = text(r.title, 120) || text(r.slug, 60) || "Untitled event";
    if ((r.teamId !== null && r.teamId !== undefined) || (r.schedulingType !== null && r.schedulingType !== undefined)) {
      preview.skipped.push({ name, reason: IMPORT_MESSAGES.teamCalcom });
      continue;
    }
    if (preview.eventTypes.length >= MAX_IMPORT) {
      preview.skipped.push({ name, reason: importMessage("overLimit", { max: MAX_IMPORT }) });
      continue;
    }
    preview.eventTypes.push(mapCalcom(r, name));
  }
  return preview;
}

/** Cal.com's custom booking field types to Hourhand's nearest question kind. Exact matches carry no note. */
const EXACT: Record<string, ImportedQuestion["kind"]> = {
  shortText: "short_text", longText: "long_text", phone: "phone", select: "single_select", multiSelect: "multi_select",
};
const NEAREST: Record<string, ImportedQuestion["kind"]> = {
  radioGroup: "single_select", checkboxGroup: "multi_select", checkbox: "consent",
  email: "short_text", number: "short_text", url: "short_text", address: "short_text", multiEmail: "short_text",
};
/** The booking form's built-in fields, which Hourhand asks for itself (name, email, notes and the like). */
const BUILT_IN = new Set(["name", "email", "location", "title", "notes", "guests", "rescheduleReason", "attendeePhoneNumber", "smsReminderNumber", "aiAgentCallPhoneNumber"]);

const INTEGRATIONS: Record<string, LocationKind> = { "google-meet": "google_meet", zoom: "zoom", "office365-video": "teams" };

function mapCalcom(r: Record<string, unknown>, name: string): ImportedEventType {
  const notes: string[] = [];
  const durationMinutes = clampDuration(num(r.lengthInMinutes), notes);
  const options = durationList(r.lengthInMinutesOptions);
  if (options.filter((d) => d !== durationMinutes).length > 0) notes.push(importMessage("calcomLengths", { options: options.join(", "), n: durationMinutes }));

  const notice = num(r.minimumBookingNotice);
  const seats = obj(r.seats);
  const perSlot = num(seats.seatsPerTimeSlot);
  let seatLimit: number | null = null;
  if (r.seats && seats.disabled !== true && perSlot !== null && perSlot >= 2) {
    seatLimit = Math.min(MAX_SEATS, Math.round(perSlot));
    if (seatLimit !== Math.round(perSlot)) notes.push(importMessage("seatsCapped", { from: Math.round(perSlot), max: MAX_SEATS }));
  }

  const qs: ImportedQuestion[] = [];
  for (const f of arr(r.bookingFields).map(obj)) {
    const type = str(f.type) ?? "";
    const slug = str(f.slug) ?? str(f.name) ?? "";
    if (f.isDefault === true || BUILT_IN.has(slug) || BUILT_IN.has(type) || f.hidden === true) continue;
    if (f.field !== undefined && f.field !== "custom") continue;
    const kind = EXACT[type] ?? NEAREST[type] ?? "short_text";
    const mapped = question(f.label ?? slug, kind, f.required === true, arr(f.options), notes, EXACT[type] ? undefined : (type || "unknown"));
    if (mapped) qs.push(mapped);
  }

  return {
    sourceId: String(num(r.id) ?? (text(r.slug, 60) || name)),
    name,
    slug: text(r.slug, 200),
    description: text(r.description, 5000) || null,
    durationMinutes,
    durationOptions: options,
    minNoticeMinutes: notice === null ? null : Math.max(0, Math.round(notice)),
    startIncrementMinutes: null,
    bufferBeforeMinutes: clampBuffer(num(r.beforeEventBuffer), "before", notes),
    bufferAfterMinutes: clampBuffer(num(r.afterEventBuffer), "after", notes),
    hidden: r.hidden === true,
    seatLimit,
    location: calcomLocation(arr(r.locations), notes),
    questions: capQuestions(qs, notes),
    notes,
  };
}

function calcomLocation(list: unknown[], notes: string[]): ImportedEventType["location"] {
  if (list.length === 0) return null;
  if (list.length > 1) notes.push(IMPORT_MESSAGES.firstLocationOnly);
  const l = obj(list[0]);
  const type = str(l.type) ?? "";
  const integration = str(l.integration) ?? "";
  if (type === "integration" && INTEGRATIONS[integration]) return { kind: INTEGRATIONS[integration], value: null };
  if (type === "address" && text(l.address, 500)) return { kind: "in_person", value: text(l.address, 500) };
  if (type === "link" && text(l.link, 500)) return { kind: "custom", value: text(l.link, 500) };
  if (type === "phone" && text(l.phone, 40)) return { kind: "phone_guest_calls", value: text(l.phone, 40) };
  if (type === "attendeePhone") return { kind: "phone_host_calls", value: null };
  if (type === "attendeeAddress" || type === "attendeeDefined") return { kind: "ask_guest", value: null };
  const kind = text(integration || type, 40);
  notes.push(kind ? importMessage("locationNoMatch", { kind }) : IMPORT_MESSAGES.locationUnknownNoMatch);
  return null;
}
