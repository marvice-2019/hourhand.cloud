import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Client portal links and sessions. A link is "<nonce>.<signature>": the nonce is random, and the signature (HMAC-SHA256)
// binds it to the host, the email and the expiry stored with it, so a row edited or copied in the database, or a nonce
// with a guessed signature, doesn't open anything. Only sha256 hashes of nonces and session ids are stored.

export const LINK_TTL_MS = 15 * 60_000;
export const SESSION_TTL_MS = 30 * 86_400_000;

const B64URL = /^[A-Za-z0-9_-]{43}$/; // 32 bytes

/** The signing key, derived from BETTER_AUTH_SECRET so no new secret has to be deployed. */
export function portalKey(env: Record<string, string | undefined> = process.env): Buffer {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 16) throw new Error("BETTER_AUTH_SECRET must be set (16+ characters) for client portal links");
  return createHash("sha256").update(`hourhand-client-portal-v1:${secret}`).digest();
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomId = () => randomBytes(32).toString("base64url");

export interface LinkClaims { hostId: string; email: string; expiresAt: Date }

const signature = (key: Buffer, nonce: string, c: LinkClaims) =>
  createHmac("sha256", key).update(`portal-link|${nonce}|${c.hostId}|${c.email.trim().toLowerCase()}|${c.expiresAt.getTime()}`).digest("base64url");

/** A new link token for these claims, and the hash of its nonce to store with them. */
export function signLink(key: Buffer, claims: LinkClaims): { token: string; nonceHash: string } {
  const nonce = randomId();
  return { token: `${nonce}.${signature(key, nonce, claims)}`, nonceHash: sha256(nonce) };
}

/** Splits a token into its nonce and signature; null when it isn't shaped like one. */
export function parseLink(token: unknown): { nonce: string; sig: string } | null {
  if (typeof token !== "string") return null;
  const [nonce, sig, extra] = token.split(".");
  if (extra !== undefined || !nonce || !sig || !B64URL.test(nonce) || !B64URL.test(sig)) return null;
  return { nonce, sig };
}

/** True when `sig` is this nonce's signature over the stored claims (constant-time compare). */
export function verifyLink(key: Buffer, nonce: string, sig: string, claims: LinkClaims): boolean {
  const want = Buffer.from(signature(key, nonce, claims));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The cookie that holds a portal session. Its path is the host's portal, so each host's portal has its own. */
export const PORTAL_COOKIE = "hh_portal";
export const portalPath = (slug: string) => `/${slug}/portal`;
