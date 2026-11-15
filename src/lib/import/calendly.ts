// Calendly API v2, read only, with the host's personal access token (scope event_types:read).
// Docs (checked 2026-11-15): https://developer.calendly.com/openapi/calendly-api.yaml
//   GET https://api.calendly.com/users/me                        -> resource.uri
//   GET https://api.calendly.com/event_types?user=<uri>&count=100 -> collection[], pagination.next_page_token
import type { LocationKind } from "../data/types";
import { arr, clampBuffer, clampDuration, durationList, getJson, nearestIncrement, num, obj, str, text } from "./http";
import { capQuestions, question } from "./questions";
import { ImportError, MAX_IMPORT, type ImportDeps, type ImportedEventType, type ImportedQuestion, type ImportPreview } from "./types";

export const CALENDLY_API = "https://api.calendly.com";
const MAX_PAGES = 10;

const MESSAGES = {
  badToken: "Calendly didn't accept that token. Make a new personal access token in Calendly (Integrations → API and webhooks) with event types read access, and paste it here.",
  notFound: "Calendly couldn't find your account with that token. Check you copied the whole token.",
};

export async function fetchCalendly(token: string, deps: ImportDeps = {}): Promise<ImportPreview> {
  const headers = { authorization: `Bearer ${token.trim()}` };
  const me = obj(await getJson("calendly", `${CALENDLY_API}/users/me`, headers, deps, MESSAGES));
  const userUri = str(obj(me.resource).uri);
  if (!userUri) throw new ImportError("bad_response", "Calendly sent an answer Hourhand couldn't read. Try again in a minute.");

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
      preview.skipped.push({ name, reason: "Team event (round robin or collective). Hourhand books one host per link for now." });
      continue;
    }
    if (preview.eventTypes.length >= MAX_IMPORT) {
      preview.skipped.push({ name, reason: `Only ${MAX_IMPORT} event types come over in one import.` });
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
  if (r.active === false) notes.push("It was switched off in Calendly.");
  if (r.kind === "group") notes.push("It was a group event. Calendly doesn't share the invitee limit, so it comes over as one-on-one: set guests per session before switching it on.");
  const options = durationList(r.duration_options);
  const durationMinutes = clampDuration(num(r.duration), notes);
  if (options.filter((d) => d !== durationMinutes).length > 0) notes.push(`Calendly offered ${options.join(", ")} minutes; only ${durationMinutes} minutes came over.`);

  const qs: ImportedQuestion[] = [];
  const sorted = arr(r.custom_questions).map(obj).filter((q) => q.enabled !== false)
    .sort((a, b) => (num(a.position) ?? 0) - (num(b.position) ?? 0));
  for (const q of sorted) {
    const type = str(q.type) ?? "";
    const kind = QUESTION_KINDS[type] ?? "short_text";
    const mapped = question(q.name, kind, q.required === true, arr(q.answer_choices), notes, QUESTION_KINDS[type] ? undefined : (type || "unknown"));
    if (!mapped) continue;
    if (q.include_other === true && (kind === "single_select" || kind === "multi_select")) notes.push(`"${mapped.label}" had an "Other" write-in choice, which Hourhand doesn't have.`);
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
  if (list.length > 1) notes.push("Only the first location came over.");
  const l = obj(list[0]);
  const kind = LOCATIONS[str(l.kind) ?? ""];
  if (!kind) {
    notes.push(`The location (${text(l.kind, 40) || "unknown"}) has no match in Hourhand; pick one before switching it on.`);
    return null;
  }
  if (kind === "in_person" || kind === "custom") {
    const value = text(l.location, 500);
    return value ? { kind, value } : (notes.push("The location had no address; add one before switching it on."), null);
  }
  if (kind === "phone_guest_calls") {
    const value = text(l.phone_number ?? l.location, 40);
    return value ? { kind, value } : (notes.push("The phone location had no number; add one before switching it on."), null);
  }
  return { kind, value: null };
}
