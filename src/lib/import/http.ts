// One GET to a provider, with a timeout and errors the host can act on. The token travels only in the request header
// given here: it is never put in a URL, an error message or a log line.
import { BUFFER, DURATION, START_INCREMENTS } from "../event-types";
import { importMessage } from "./messages";
import { ImportError, PROVIDER_LABEL, type FetchLike, type ImportDeps, type ImportProvider } from "./types";

export const DEFAULT_TIMEOUT_MS = 10_000;

export async function getJson(provider: ImportProvider, url: string, headers: Record<string, string>, deps: ImportDeps,
  messages: { badToken: string; notFound: string }): Promise<unknown> {
  const doFetch: FetchLike = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const label = PROVIDER_LABEL[provider];
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw timedOut
      ? new ImportError("timeout", importMessage("timeout", { label }))
      : new ImportError("unavailable", importMessage("unreachable", { label }));
  }
  if (res.status === 401 || res.status === 403) throw new ImportError("bad_token", messages.badToken);
  if (res.status === 404) throw new ImportError("not_found", messages.notFound);
  if (res.status === 429) throw new ImportError("rate_limited", importMessage("rateLimited", { label }));
  if (!res.ok) throw new ImportError("unavailable", importMessage("providerError", { label, status: res.status }));
  try {
    return await res.json();
  } catch {
    throw new ImportError("bad_response", importMessage("unreadable", { label }));
  }
}

// Small readers for untrusted JSON: anything of the wrong type reads as missing.
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Plain text, trimmed and capped, with no control characters. */
export function text(v: unknown, max: number): string {
  return (str(v) ?? "").replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
}

/** Lengths outside 5 to 720 minutes are brought to the nearest end, with a note. */
export function clampDuration(raw: number | null, notes: string[]): number {
  if (raw === null) {
    notes.push(importMessage("noLength"));
    return 30;
  }
  const minutes = Math.round(raw);
  const clamped = Math.min(DURATION.max, Math.max(DURATION.min, minutes));
  if (clamped !== minutes) notes.push(importMessage("lengthChanged", { from: minutes, to: clamped, min: DURATION.min, max: DURATION.max }));
  return clamped;
}

export function clampBuffer(raw: number | null, which: "before" | "after", notes: string[]): number {
  const minutes = Math.round(raw ?? 0);
  const clamped = Math.min(BUFFER.max, Math.max(BUFFER.min, minutes));
  if (clamped !== minutes) notes.push(importMessage(which === "before" ? "bufferBeforeChanged" : "bufferAfterChanged", { from: minutes, to: clamped }));
  return clamped;
}

/** The nearest of Hourhand's start times (5, 10, 15, 20, 30, 45, 60); the smaller one on a tie. */
export function nearestIncrement(raw: number | null, notes: string[]): number | null {
  if (raw === null || raw <= 0) return null;
  const best = [...START_INCREMENTS].reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
  if (best !== raw) notes.push(importMessage("incrementChanged", { from: raw, to: best }));
  return best;
}

export function durationList(v: unknown): number[] {
  return [...new Set(arr(v).map(num).filter((n): n is number => n !== null && n > 0).map(Math.round))];
}
