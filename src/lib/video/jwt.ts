import { createHmac, timingSafeEqual } from "node:crypto";
import type { JitsiConfig } from "./config";

// The token Jitsi's prosody token auth checks (lib-jitsi-meet docs/tokens.md). Signed with HS256 and the shared
// JWT_APP_SECRET, so no JWT library is needed. Minted per join, never stored and never put in an email.

/** The audience the Jitsi server accepts (JWT_ACCEPTED_AUDIENCES on docker-jitsi-meet). */
export const JITSI_AUDIENCE = "jitsi";
/** A join opens this long before the start, and the token works from then. */
export const OPENS_BEFORE_MS = 15 * 60_000;
/** A join stays open this long after the end, and the token stops working then. */
export const CLOSES_AFTER_MS = 30 * 60_000;

export interface JitsiClaims {
  iss: string;
  aud: string;
  sub: string;
  room: string;
  iat: number;
  nbf: number;
  exp: number;
  context: {
    /** moderator/affiliation: read by token_affiliation. lobby_bypass: read by token_lobby_bypass (the host skips the lobby). */
    user: { id: string; name: string; email: string; moderator: boolean; affiliation: "owner" | "member"; lobby_bypass: boolean };
    features: { recording: false; livestreaming: false; transcription: false; "outbound-call": false; "sip-outbound-call": false };
  };
}

export interface JoinTokenInput {
  room: string;
  moderator: boolean;
  user: { id: string; name: string; email: string };
  startAt: Date;
  endAt: Date;
  now: Date;
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const seconds = (ms: number) => Math.floor(ms / 1000);

/** The claims for one person joining one room: valid 15 minutes before the start until 30 minutes after the end. */
export function joinClaims(cfg: JitsiConfig, input: JoinTokenInput): JitsiClaims {
  return {
    iss: cfg.appId, aud: JITSI_AUDIENCE, sub: cfg.domain, room: input.room,
    iat: seconds(input.now.getTime()),
    nbf: seconds(input.startAt.getTime() - OPENS_BEFORE_MS),
    exp: seconds(input.endAt.getTime() + CLOSES_AFTER_MS),
    context: {
      user: { id: input.user.id, name: input.user.name, email: input.user.email, moderator: input.moderator, affiliation: input.moderator ? "owner" : "member",
        lobby_bypass: input.moderator },
      // Hourhand video never records: switched off on the server too (no Jibri), this only keeps the buttons hidden.
      features: { recording: false, livestreaming: false, transcription: false, "outbound-call": false, "sip-outbound-call": false },
    },
  };
}

export function signJwt(payload: object, secret: string): string {
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** The signed join token. */
export function mintJoinToken(cfg: JitsiConfig, input: JoinTokenInput): string {
  return signJwt(joinClaims(cfg, input), cfg.secret);
}

/** The payload of a token signed with `secret`, or null when the signature or shape is wrong. For tests and checks. */
export function verifyJwt(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const want = createHmac("sha256", secret).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    if (header.alg !== "HS256") return null;
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
