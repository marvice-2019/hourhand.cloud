import type pg from "pg";
import { parseKey, seal, unseal } from "../crypto/seal";
import { resolveBaseUrl } from "../auth/auth";
import { ZoomApiError, zoomClientFromEnv, type ZoomClient, type ZoomTokens, type ZoomUser } from "./client";

// A host's Zoom connection: one `integrations` row (provider 'zoom') per host. Tokens are sealed with
// TOKEN_ENCRYPTION_KEY and bound to the host and Zoom user, like calendar tokens. A revoked grant or a
// deauthorization from Zoom marks it disconnected and emails the host once; bookings already made keep their link.

type Db = Pick<pg.Pool, "query">;
interface Credentials { refreshToken: string; accessToken: string | null; expiresAt: string | null }

export interface ZoomDeps { client: ZoomClient; key: Buffer }

const aadFor = (userId: string, zoomUserId: string) => `zoom:${userId}:${zoomUserId}`;
const LOCK = "zoom-refresh:";

/** Zoom with its key, or null when ZOOM_CLIENT_ID/SECRET or TOKEN_ENCRYPTION_KEY are missing. */
export function zoomDeps(env: Record<string, string | undefined> = process.env): ZoomDeps | null {
  if (env.HOURHAND_DATA !== "postgres") return null;
  const client = zoomClientFromEnv(env);
  if (!client) return null;
  try {
    return { client, key: parseKey(env.TOKEN_ENCRYPTION_KEY) };
  } catch {
    return null; // zoomConfigError says why
  }
}

/** Why Zoom is configured but can't run, or null. The job runner refuses to start on this, as it does for calendars. */
export function zoomConfigError(env: Record<string, string | undefined> = process.env): string | null {
  if (env.HOURHAND_DATA !== "postgres" || !zoomClientFromEnv(env)) return null;
  try {
    parseKey(env.TOKEN_ENCRYPTION_KEY);
    return null;
  } catch (error) {
    return `Zoom is configured but ${(error as Error).message}`;
  }
}

/** Where Zoom sends the host back. Add exactly this URL to the Zoom app's OAuth redirect URLs and allow list. */
export function zoomRedirectUri(fallbackOrigin: string, env: Record<string, string | undefined> = process.env): string {
  return `${(resolveBaseUrl(env) ?? fallbackOrigin).replace(/\/+$/, "")}/api/integrations/zoom/callback`;
}

/** Saves a new or renewed connection. Reconnecting clears the outage and its alert. */
export async function saveZoomConnection(db: Db, key: Buffer, userId: string, user: ZoomUser, tokens: ZoomTokens): Promise<string> {
  const creds: Credentials = { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt.toISOString() };
  const { rows: [row] } = await db.query(
    `insert into integrations (user_id, provider, credentials_encrypted, public_id, account_email, granted_scopes, status, last_error, alert_sent_at)
     values ($1, 'zoom', $2, $3, $4, $5, 'ok', null, null)
     on conflict (user_id, provider) do update set credentials_encrypted = excluded.credentials_encrypted, public_id = excluded.public_id,
       account_email = excluded.account_email, granted_scopes = excluded.granted_scopes, status = 'ok', last_error = null, alert_sent_at = null, updated_at = now()
     returning id`,
    [userId, seal(key, creds, aadFor(userId, user.id)), user.id, user.email, tokens.scope]);
  return row.id as string;
}

export type ZoomStatus = { state: "connected"; email: string } | { state: "disconnected"; email: string; lastError: string | null } | { state: "none" };

/** What the dashboard shows. Never the tokens. */
export async function zoomStatus(db: Db, userId: string): Promise<ZoomStatus> {
  const { rows: [r] } = await db.query("select status, account_email, last_error from integrations where user_id = $1 and provider = 'zoom'", [userId]);
  if (!r) return { state: "none" };
  return r.status === "ok" ? { state: "connected", email: r.account_email } : { state: "disconnected", email: r.account_email, lastError: r.last_error };
}

/**
 * Marks the connection disconnected (tokens wiped: they no longer work and Zoom asks apps to drop the user's data)
 * and queues one email to the host per outage.
 */
export async function markZoomDisconnected(db: Db, integrationId: string, reason: string, now: Date): Promise<void> {
  const { rows: [c] } = await db.query(
    `update integrations set status = 'disconnected', credentials_encrypted = ''::bytea, last_error = $2, updated_at = $3
     where id = $1 and provider = 'zoom' returning user_id`, [integrationId, reason.slice(0, 500), now]);
  if (!c) return;
  // One alert per outage, claimed in one statement so a webhook and a failing job together send one email.
  const claimed = await db.query("update integrations set alert_sent_at = $2 where id = $1 and alert_sent_at is null", [integrationId, now]);
  if (!claimed.rowCount) return;
  const { rows: [host] } = await db.query("select email from users where id = $1 and deleted_at is null", [c.user_id]);
  if (!host) return;
  await db.query(
    `insert into notifications (booking_id, user_id, channel, kind, recipient, send_at, dedupe_key)
     values (null, $1, 'email', 'zoom_alert_host', $2, $3, $4) on conflict (dedupe_key) do nothing`,
    [c.user_id, host.email, now, `zoom:${integrationId}:alert:${now.toISOString()}`]);
}

interface Loaded { id: string; aad: string; sealed: Buffer; creds: Credentials; valid: boolean }

async function load(db: Db, key: Buffer, userId: string, now: Date): Promise<Loaded> {
  const { rows: [r] } = await db.query(
    "select id, user_id, public_id, status, credentials_encrypted from integrations where user_id = $1 and provider = 'zoom'", [userId]);
  if (!r || r.status !== "ok" || r.credentials_encrypted.length === 0) throw new ZoomApiError("Zoom is not connected", { retryable: false, revoked: true });
  const aad = aadFor(r.user_id, r.public_id);
  const creds = unseal<Credentials>(key, r.credentials_encrypted, aad);
  const valid = Boolean(creds.accessToken && creds.expiresAt && new Date(creds.expiresAt).getTime() - now.getTime() > 60_000);
  return { id: r.id, aad, sealed: r.credentials_encrypted, creds, valid };
}

/**
 * An access token for the host's Zoom, refreshed when it has under a minute left (or `force`, after Zoom refused it).
 * Zoom rotates refresh tokens and the old one stops working at once, so refreshes take turns per connection under a
 * session-level advisory lock, and the new refresh token is stored before the access token is used. A refused refresh
 * marks the connection disconnected and tells the host.
 */
export async function zoomAccessToken(pool: pg.Pool, deps: ZoomDeps, userId: string, now = new Date(), force = false): Promise<string> {
  const first = await load(pool, deps.key, userId, now);
  if (first.valid && !force) return first.creds.accessToken as string;
  const client = await pool.connect();
  let unlockError: Error | undefined;
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [LOCK + first.id]);
    try {
      const cur = await load(client, deps.key, userId, now);
      // Someone refreshed while this call waited for the lock: use theirs.
      if (cur.valid && (!force || !cur.sealed.equals(first.sealed))) return cur.creds.accessToken as string;
      let fresh: ZoomTokens;
      try {
        fresh = await deps.client.refresh(cur.creds.refreshToken, now);
      } catch (error) {
        if (error instanceof ZoomApiError && error.revoked) await markZoomDisconnected(client, cur.id, `Zoom refused the stored grant: ${error.message}`, now);
        throw error;
      }
      const next: Credentials = { refreshToken: fresh.refreshToken, accessToken: fresh.accessToken, expiresAt: fresh.expiresAt.toISOString() };
      // A reconnect that saved new credentials meanwhile wins; this token still works for this call.
      await client.query("update integrations set credentials_encrypted = $2, updated_at = $3 where id = $1 and credentials_encrypted = $4",
        [cur.id, seal(deps.key, next, cur.aad), now, cur.sealed]);
      return fresh.accessToken;
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1))", [LOCK + first.id]).catch((e: Error) => { unlockError = e; });
    }
  } finally {
    client.release(unlockError);
  }
}

/**
 * Runs `fn` with the host's token. When Zoom answers 401 (a token replaced or ended early), it refreshes once and tries
 * again. A grant Zoom no longer honours disconnects the connection and emails the host.
 */
export async function withZoomToken<T>(pool: pg.Pool, deps: ZoomDeps, userId: string, now: Date, fn: (token: string) => Promise<T>): Promise<T> {
  try {
    const token = await zoomAccessToken(pool, deps, userId, now);
    try {
      return await fn(token);
    } catch (error) {
      // Only the meeting call's 401 means "this access token": a refused refresh is final and was handled above.
      if (!(error instanceof ZoomApiError) || error.status !== 401) throw error;
      return await fn(await zoomAccessToken(pool, deps, userId, now, true));
    }
  } catch (error) {
    if (error instanceof ZoomApiError && error.revoked && error.message !== "Zoom is not connected") {
      const { rows: [r] } = await pool.query("select id from integrations where user_id = $1 and provider = 'zoom' and status = 'ok'", [userId]);
      if (r) await markZoomDisconnected(pool, r.id, error.message, now);
    }
    throw error;
  }
}

/** The host disconnects Zoom: revoke the grant (best effort), then delete the row. Bookings keep their links. */
export async function disconnectZoom(db: Db, deps: ZoomDeps | null, userId: string): Promise<void> {
  const { rows: [r] } = await db.query(
    "select id, user_id, public_id, credentials_encrypted from integrations where user_id = $1 and provider = 'zoom'", [userId]);
  if (!r) return;
  if (deps && r.credentials_encrypted.length > 0) {
    try {
      const creds = unseal<Credentials>(deps.key, r.credentials_encrypted, aadFor(r.user_id, r.public_id));
      await deps.client.revoke(creds.accessToken ?? creds.refreshToken);
    } catch {
      // A token that can't be opened or revoked can't be used either; deleting the row is what matters.
    }
  }
  await db.query("delete from integrations where id = $1", [r.id]);
}

/** For the location pickers: whether choosing Zoom will get bookings a link. */
export type ZoomSetup = "connected" | "not_connected" | "not_configured";

export async function zoomSetupFor(pool: () => Db, userId: string, env: Record<string, string | undefined> = process.env): Promise<ZoomSetup> {
  if (!zoomDeps(env) || !env.DATABASE_URL) return "not_configured";
  return (await zoomStatus(pool(), userId)).state === "connected" ? "connected" : "not_connected";
}
