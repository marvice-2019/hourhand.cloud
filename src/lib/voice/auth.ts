import { createHmac, timingSafeEqual } from "node:crypto";

// Each host's voice agent calls Hourhand's tools with its own key, sent as `Authorization: Bearer <key>`. The key names
// the host and is an HMAC of (host, key version) under VOICE_TOOLS_KEY, so nothing secret is stored per host and one
// host's key can never act for another. Bumping voice_settings.key_version revokes every key issued before.
//
// Layout: hhv1.<host uuid>.<version>.<43 chars base64url HMAC-SHA256>

const PREFIX = "hhv1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Env = Record<string, string | undefined>;

/** VOICE_TOOLS_KEY as 64 hex characters (`openssl rand -hex 32`). Null when the voice add-on isn't set up here. */
export function voiceToolsKey(env: Env = process.env): Buffer | null {
  const raw = env.VOICE_TOOLS_KEY;
  if (!raw) return null;
  if (!/^[0-9a-f]{64}$/i.test(raw)) throw new Error("VOICE_TOOLS_KEY must be 64 hex characters (openssl rand -hex 32)");
  return Buffer.from(raw, "hex");
}

const mac = (key: Buffer, hostId: string, version: number) =>
  createHmac("sha256", key).update(`voice-tools:${hostId}:${version}`).digest("base64url");

/** The key a host's agent sends. Shown to the host once in setup and pasted into the agent's tool headers. */
export function mintToolKey(key: Buffer, hostId: string, version: number): string {
  if (!UUID.test(hostId) || !Number.isInteger(version) || version < 1) throw new Error("Bad host id or key version");
  return `${PREFIX}.${hostId}.${version}.${mac(key, hostId, version)}`;
}

/**
 * The host and key version a presented key was made for, or null when it is malformed or its MAC doesn't match.
 * Callers must still check that the version is the host's current one and that voice is switched on.
 */
export function readToolKey(key: Buffer, presented: string | null | undefined): { hostId: string; version: number } | null {
  if (!presented || presented.length > 200) return null;
  const parts = presented.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, hostId, v, given] = parts;
  const version = Number(v);
  if (!UUID.test(hostId) || !/^[1-9][0-9]{0,8}$/.test(v)) return null;
  const expected = Buffer.from(mac(key, hostId, version));
  const got = Buffer.from(given);
  return got.length === expected.length && timingSafeEqual(got, expected) ? { hostId, version } : null;
}

/** The key from an Authorization: Bearer header. */
export function bearer(header: string | null): string | null {
  const m = header ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  return m ? m[1] : null;
}

/**
 * ElevenLabs signs each post-call webhook: `ElevenLabs-Signature: t=<unix seconds>,v0=<hex HMAC-SHA256 of "t.body">`
 * with the webhook's shared secret. Rejected when older than `toleranceSecs` (replays).
 */
export function verifyElevenLabsSignature(secret: string, rawBody: string, header: string | null, now: Date, toleranceSecs = 30 * 60): boolean {
  if (!header) return false;
  const fields = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(fields.t);
  const v0 = fields.v0;
  if (!Number.isInteger(t) || !v0 || !/^[0-9a-f]{64}$/i.test(v0)) return false;
  if (Math.abs(now.getTime() / 1000 - t) > toleranceSecs) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"));
  const given = Buffer.from(v0.toLowerCase());
  return given.length === expected.length && timingSafeEqual(given, expected);
}
