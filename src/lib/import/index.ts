// The import flow the dashboard calls: fetch a preview (rate-limited, token used once and dropped), then import the
// ticked event types from the sealed preview.
import type { DataStore } from "../data/types";
import type { Limit } from "../rate-limit";
import { fetchCalcom } from "./calcom";
import { fetchCalendly } from "./calendly";
import { IMPORT_MESSAGES } from "./messages";
import { importEventTypes, type ImportOutcome } from "./run";
import { openPreview, sealPreview } from "./sealed-preview";
import { IMPORT_FETCH_LIMIT, ImportError, type ImportDeps, type ImportProvider } from "./types";

export * from "./types";

/** What the preview shows per event type. */
export interface PreviewRow {
  sourceId: string;
  name: string;
  slug: string;
  durationMinutes: number;
  hidden: boolean;
  seatLimit: number | null;
  questionCount: number;
  notes: string[];
}

export type PreviewState =
  | { status: "idle" }
  | { status: "error"; provider: ImportProvider; username: string; error: string }
  | { status: "preview"; provider: ImportProvider; sealed: string; rows: PreviewRow[]; skipped: { name: string; reason: string }[] };

export interface PreviewDeps extends ImportDeps {
  limiter: { take(key: string, limit: Limit): boolean };
  key: Buffer;
  now: number;
  /** Where an unexpected failure is reported; it gets the provider and the error's name only. */
  log?: (message: string, detail: Record<string, string>) => void;
}

const isProvider = (v: unknown): v is ImportProvider => v === "calendly" || v === "calcom";

export async function runPreview(userId: string, input: { provider: unknown; token: unknown; username: unknown }, deps: PreviewDeps): Promise<PreviewState> {
  const provider: ImportProvider = isProvider(input.provider) ? input.provider : "calendly";
  const username = typeof input.username === "string" ? input.username.trim().slice(0, 100) : "";
  const token = typeof input.token === "string" ? input.token.trim() : "";
  const fail = (error: string): PreviewState => ({ status: "error", provider, username, error });

  if (!isProvider(input.provider)) return fail(IMPORT_MESSAGES.pickProvider);
  if (!token || token.length > 4000 || /\s/.test(token)) {
    return fail(provider === "calendly" ? IMPORT_MESSAGES.calendlyTokenMissing : IMPORT_MESSAGES.calcomKeyMissing);
  }
  if (provider === "calcom" && !username) return fail(IMPORT_MESSAGES.calcomUsernameMissing);
  if (!deps.limiter.take(`import:${userId}`, IMPORT_FETCH_LIMIT)) return fail(IMPORT_MESSAGES.tooManyTries);

  try {
    const preview = provider === "calendly" ? await fetchCalendly(token, deps) : await fetchCalcom(token, username, deps);
    const rows: PreviewRow[] = preview.eventTypes.map((et) => ({
      sourceId: et.sourceId, name: et.name, slug: et.slug, durationMinutes: et.durationMinutes, hidden: et.hidden,
      seatLimit: et.seatLimit, questionCount: et.questions.length, notes: et.notes,
    }));
    if (rows.length === 0 && preview.skipped.length === 0) return fail(IMPORT_MESSAGES.noneFound);
    return { status: "preview", provider, sealed: sealPreview(deps.key, userId, preview, deps.now), rows, skipped: preview.skipped };
  } catch (e) {
    if (e instanceof ImportError) return fail(e.message);
    (deps.log ?? console.error)("Event type import failed", { provider, error: e instanceof Error ? e.name : "unknown" });
    return fail(IMPORT_MESSAGES.fetchFailed);
  }
}

export type ImportResult = { ok: true; outcome: ImportOutcome } | { ok: false; error: string };

export async function runImport(store: DataStore, userId: string, sealed: unknown, sourceIds: unknown, deps: { key: Buffer; now: number }): Promise<ImportResult> {
  const items = typeof sealed === "string" ? openPreview(deps.key, userId, sealed, deps.now) : null;
  if (!items) return { ok: false, error: IMPORT_MESSAGES.previewExpired };
  const wanted = new Set(Array.isArray(sourceIds) ? sourceIds.filter((s): s is string => typeof s === "string") : []);
  const chosen = items.filter((et) => wanted.has(et.sourceId));
  if (chosen.length === 0) return { ok: false, error: IMPORT_MESSAGES.tickOne };
  return { ok: true, outcome: await importEventTypes(store, userId, chosen) };
}
