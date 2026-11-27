// B14: personal API keys. Only a SHA-256 hash is stored: a key is shown once, when made.
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

type Db = Pick<pg.Pool, "query">;

export const MAX_API_KEYS = 5;
const KEY_PATTERN = /^hh_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** last_used_at is written at most this often per key, so a busy key doesn't write on every request. */
const TOUCH_EVERY_MS = 60_000;

export interface ApiKey { id: string; name: string; prefix: string; createdAt: Date; lastUsedAt: Date | null }

/** A new key: "hh_" and 32 random bytes in base64url (43 characters). */
export function newApiKey(): string {
  return `hh_${randomBytes(32).toString("base64url")}`;
}

/** The whole key's SHA-256. Keys are random and long, so a fast hash is enough. */
export function hashApiKey(key: string): Buffer {
  return createHash("sha256").update(key).digest();
}

export type CreateKeyResult = { ok: true; id: string; key: string } | { ok: false; error: "name_missing" | "name_too_long" | "too_many" };

/** Makes a key for the host. The key itself is in the result only; nothing can show it again. */
export async function createApiKey(db: Db, userId: string, rawName: string): Promise<CreateKeyResult> {
  const name = rawName.trim();
  if (!name) return { ok: false, error: "name_missing" };
  if (name.length > 60) return { ok: false, error: "name_too_long" };
  const key = newApiKey();
  // The count and the insert are one statement, so two forms sent at once can't make a sixth key.
  const { rows } = await db.query(
    `insert into api_keys (user_id, name, prefix, key_hash)
     select $1, $2, $3, $4 where (select count(*) from api_keys where user_id = $1) < $5
     returning id`, [userId, name, key.slice(0, 7), hashApiKey(key), MAX_API_KEYS]);
  if (!rows[0]) return { ok: false, error: "too_many" };
  return { ok: true, id: rows[0].id as string, key };
}

export async function listApiKeys(db: Db, userId: string): Promise<ApiKey[]> {
  const { rows } = await db.query(
    "select id, name, prefix, created_at, last_used_at from api_keys where user_id = $1 order by created_at, id", [userId]);
  return rows.map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
}

/** Removes one of the host's keys. Someone else's key, or none, changes nothing. */
export async function deleteApiKey(db: Db, userId: string, keyId: string): Promise<boolean> {
  if (!UUID.test(keyId)) return false;
  const { rowCount } = await db.query("delete from api_keys where id = $1 and user_id = $2", [keyId, userId]);
  return (rowCount ?? 0) > 0;
}

/** The key's id and owner for an `Authorization: Bearer <key>` header, or null for anything else. */
export async function authenticateApiKey(db: Db, header: string | null, now: Date): Promise<{ keyId: string; userId: string } | null> {
  const key = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!key || !KEY_PATTERN.test(key)) return null;
  const { rows: [row] } = await db.query(
    `select k.id, k.user_id, k.last_used_at from api_keys k join users u on u.id = k.user_id
     where k.key_hash = $1 and u.deleted_at is null`, [hashApiKey(key)]);
  if (!row) return null;
  if (!row.last_used_at || now.getTime() - (row.last_used_at as Date).getTime() >= TOUCH_EVERY_MS) {
    await db.query("update api_keys set last_used_at = $2 where id = $1", [row.id, now]);
  }
  return { keyId: row.id as string, userId: row.user_id as string };
}
