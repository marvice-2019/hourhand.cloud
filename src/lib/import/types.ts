// The common shape every provider importer returns. Provider modules only translate; src/lib/import/plan.ts turns these
// into validated drafts and src/lib/import/run.ts saves them.
import type { CustomQuestion, LocationKind } from "../data/types";

export type ImportProvider = "calendly" | "calcom";

export const PROVIDER_LABEL: Record<ImportProvider, string> = { calendly: "Calendly", calcom: "Cal.com" };

export interface ImportedQuestion {
  label: string;
  kind: CustomQuestion["kind"];
  required: boolean;
  choices: string[];
}

export interface ImportedEventType {
  /** The provider's own id for it, used to tick it in the preview. */
  sourceId: string;
  name: string;
  /** The provider's slug; made unique among the host's links when imported. */
  slug: string;
  description: string | null;
  /** Already clamped to Hourhand's 5 to 720 minutes. */
  durationMinutes: number;
  /** Every length the provider offered, as given. Kept for multiple durations; only durationMinutes is saved today. */
  durationOptions: number[];
  /** null when the provider doesn't share it (Calendly): Hourhand's default applies. */
  minNoticeMinutes: number | null;
  /** One of Hourhand's start increments, or null for the default. */
  startIncrementMinutes: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  hidden: boolean;
  /** Guests per session for a group class (2 to 500); null = one-on-one. */
  seatLimit: number | null;
  location: { kind: LocationKind; value: string | null } | null;
  questions: ImportedQuestion[];
  /** What didn't carry over exactly, in plain words, shown in the preview. */
  notes: string[];
}

/** What the preview lists: the types that can come over, and the ones left behind with why. */
export interface ImportPreview {
  provider: ImportProvider;
  eventTypes: ImportedEventType[];
  skipped: { name: string; reason: string }[];
}

export type ImportErrorCode = "bad_token" | "not_found" | "rate_limited" | "timeout" | "unavailable" | "bad_response";

/** A failed fetch from the provider. The message is safe to show the host and never contains the token. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  constructor(code: ImportErrorCode, message: string) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface ImportDeps {
  fetch?: FetchLike;
  /** Milliseconds per request; 10 seconds unless a test shortens it. */
  timeoutMs?: number;
}

/** At most this many event types come over in one import, which keeps the preview well under the action body limit. */
export const MAX_IMPORT = 200;

/** Fetches from a provider per host: enough for a few retries with a corrected token, not for hammering the provider. */
export const IMPORT_FETCH_LIMIT = { max: 10, windowMs: 10 * 60_000 } as const;
