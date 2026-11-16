// Calendly API v2, read only, with the host's personal access token (scope event_types:read).
// Docs (checked 2026-11-15): https://developer.calendly.com/openapi/calendly-api.yaml
//   GET https://api.calendly.com/users/me                        -> resource.uri
//   GET https://api.calendly.com/event_types?user=<uri>&count=100 -> collection[], pagination.next_page_token
import type { LocationKind } from "../data/types";
import { arr, clampBuffer, clampDuration, durationList, getJson, nearestIncrement, num, obj, str, text } from "./http";
import { IMPORT_MESSAGES, importMessage } from "./messages";
import { capQuestions, question } from "./questions";
import { ImportError, MAX_IMPORT, type ImportDeps, type ImportedEventType, type ImportedQuestion, type ImportPreview } from "./types";

export const CALENDLY_API = "https://api.calendly.com";
const MAX_PAGES = 10;

const MESSAGES = {
  badToken: IMPORT_MESSAGES.calendlyBadToken,
  notFound: IMPORT_MESSAGES.calendlyNotFound,
};

export async function fetchCalendly(token: string, deps: ImportDeps = {}): Promise<ImportPreview> {
  const headers = { authorization: `Bearer ${token.trim()}` };
  const me = obj(await getJson("calendly", `${CALENDLY_API}/users/me`, headers, deps, MESSAGES));
  const userUri = str(obj(me.resource).uri);
  if (!userUri) throw new ImportError("bad_response", importMessage("unreadableRetry", { label: "Calendly" }));

  const raw: unknown[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ user: userUri, count: "100" });
    if (pageToken) q.set("page_token", pageToken);
    const body = obj(await getJson("calendly", `${CALENDLY_API}/event_types?${q}`, headers, deps, MESSAGES));
    raw.push(...arr(body.collection));
    pageToken = str(obj(body.pagination).next_page_token);
    if (!pageToken || raw.length >= MAX_IMPORT * 2) break;
  }

  const preview: ImportPreview = { provider: "calendly", eventTypes: [], skipped: [] };
  for (const item of raw) {
    const r = obj(item);
    const name = text(r.name, 120) || text(r.slug, 60) || "Untitled event";
    if (r.pooling_type !== null && r.pooling_type !== undefined) {
      preview.skipped.push({ name, reason: IMPORT_MESSAGES.teamCalendly });
      continue;
    }
    if (preview.eventTypes.length >= MAX_IMPORT) {
      preview.skipped.push({ name, reason: importMessage("overLimit", { max: MAX_IMPORT }) });
      continue;
    }
    preview.eventTypes.push(mapCalendly(r, name));
  }
  return preview;
}

const QUESTION_KINDS: Record<string, ImportedQuestion["kind"]> = {
  string: "short_text", text: "long_text", phone_number: "phone", single_select: "single_select", multi_select: "multi_select",
};

const LOCATIONS: Record<string, LocationKind> = {
  google_conference: "google_meet", zoom_conference: "zoom", microsoft_teams_conference: "teams", outbound_call: "phone_host_calls",
  inbound_call: "phone_guest_calls", physical: "in_person", custom: "custom", ask_invitee: "ask_guest",
};

function mapCalendly(r: Record<string, unknown>, name: string): ImportedEventType {
  const notes: string[] = [];
  if (r.active === false) notes.push(IMPORT_MESSAGES.calendlySwitchedOff);
  if (r.kind === "group") notes.push(IMPORT_MESSAGES.calendlyGroup);
  const options = durationList(r.duration_options);
  const durationMinutes = clampDuration(num(r.duration), notes);
  if (options.filter((d) => d !== durationMinutes).length > 0) notes.push(importMessage("calendlyLengths", { options: options.join(", "), n: durationMinutes }));

  const qs: ImportedQuestion[] = [];
  const sorted = arr(r.custom_questions).map(obj).filter((q) => q.enabled !== false)
    .sort((a, b) => (num(a.position) ?? 0) - (num(b.position) ?? 0));
  for (const q of sorted) {
    const type = str(q.type) ?? "";
    const kind = QUESTION_KINDS[type] ?? "short_text";
    const mapped = question(q.name, kind, q.required === true, arr(q.answer_choices), notes, QUESTION_KINDS[type] ? undefined : (type || "unknown"));
    if (!mapped) continue;
    if (q.include_other === true && (kind === "single_select" || kind === "multi_select")) notes.push(importMessage("otherChoice", { label: mapped.label }));
    qs.push(mapped);
  }

  return {
    sourceId: text(r.uri, 300) || text(r.slug, 60) || name,
    name,
    slug: text(r.slug, 200),
    description: text(r.description_plain, 5000) || null,
    durationMinutes,
    durationOptions: options,
    minNoticeMinutes: null,
    startIncrementMinutes: nearestIncrement(num(r.start_time_increment), notes),
    bufferBeforeMinutes: clampBuffer(num(r.before_buffer), "before", notes),
    bufferAfterMinutes: clampBuffer(num(r.after_buffer), "after", notes),
    hidden: r.secret === true,
    seatLimit: null,
    location: calendlyLocation(arr(r.locations), notes),
    questions: capQuestions(qs, notes),
    notes,
  };
}

function calendlyLocation(list: unknown[], notes: string[]): ImportedEventType["location"] {
  if (list.length === 0) return null;
  if (list.length > 1) notes.push(IMPORT_MESSAGES.firstLocationOnly);
  const l = obj(list[0]);
  const kind = LOCATIONS[str(l.kind) ?? ""];
  if (!kind) {
    const raw = text(l.kind, 40);
    notes.push(raw ? importMessage("locationNoMatch", { kind: raw }) : IMPORT_MESSAGES.locationUnknownNoMatch);
    return null;
  }
  if (kind === "in_person" || kind === "custom") {
    const value = text(l.location, 500);
    return value ? { kind, value } : (notes.push(IMPORT_MESSAGES.locationNoAddress), null);
  }
  if (kind === "phone_guest_calls") {
    const value = text(l.phone_number ?? l.location, 40);
    return value ? { kind, value } : (notes.push(IMPORT_MESSAGES.locationNoNumber), null);
  }
  return { kind, value: null };
}
