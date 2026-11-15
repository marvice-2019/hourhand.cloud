// Between "fetch" and "import" the preview rides with the browser, sealed, so the server stores nothing and the token
// is never needed again. Only the mapped event types are sealed (never the token), bound to the host and good for 15
// minutes. Sealing also stops the browser editing what it sends back.
import { randomBytes } from "node:crypto";
import { parseKey, seal, unseal } from "../crypto/seal";
import type { ImportedEventType, ImportPreview } from "./types";

export const PREVIEW_TTL_MS = 15 * 60_000;

interface Sealed { v: 1; userId: string; expiresAt: number; eventTypes: ImportedEventType[] }

let fallback: Buffer | undefined;
/** TOKEN_ENCRYPTION_KEY when set; otherwise (demo mode) a key that lives as long as this process. */
export function previewKey(env: Record<string, string | undefined> = process.env): Buffer {
  if (env.TOKEN_ENCRYPTION_KEY) return parseKey(env.TOKEN_ENCRYPTION_KEY);
  return (fallback ??= randomBytes(32));
}

const aad = (userId: string) => `import-preview:${userId}`;

export function sealPreview(key: Buffer, userId: string, preview: ImportPreview, now: number): string {
  const value: Sealed = { v: 1, userId, expiresAt: now + PREVIEW_TTL_MS, eventTypes: preview.eventTypes };
  return seal(key, value, aad(userId)).toString("base64url");
}

/** The sealed event types, or null when the seal is someone else's, tampered with or older than 15 minutes. */
export function openPreview(key: Buffer, userId: string, sealed: string, now: number): ImportedEventType[] | null {
  if (typeof sealed !== "string" || sealed.length > 4_000_000) return null;
  try {
    const value = unseal<Sealed>(key, Buffer.from(sealed, "base64url"), aad(userId));
    if (value.v !== 1 || value.userId !== userId || !(now < value.expiresAt) || !Array.isArray(value.eventTypes)) return null;
    return value.eventTypes;
  } catch {
    return null;
  }
}
