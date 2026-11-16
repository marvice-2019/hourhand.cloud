// Zoom meetings for a host's own Zoom account: a user-managed OAuth app (authorization code + PKCE), and the three
// meeting calls Hourhand makes (create, update, delete). Endpoints are injectable so tests can point at a fake Zoom.
//
// Docs (checked 2026-11-15):
//   OAuth:    https://developers.zoom.us/docs/integrations/oauth/
//   Meetings: https://developers.zoom.us/docs/api/meetings/ (POST /users/{userId}/meetings, PATCH and DELETE /meetings/{meetingId})

/**
 * Granular scopes, as a General app lists them. `user:read:user` resolves which Zoom user connected (GET /users/me).
 * Apps created before granular scopes use the classic `meeting:write` / `user:read`, which cover the same calls.
 */
export const ZOOM_SCOPES = ["meeting:write:meeting", "meeting:update:meeting", "meeting:delete:meeting", "user:read:user"] as const;

/** Each needed scope, with the classic and admin scopes that also grant it. */
const SCOPE_EQUIVALENTS: Record<(typeof ZOOM_SCOPES)[number], string[]> = {
  "meeting:write:meeting": ["meeting:write:meeting", "meeting:write:meeting:admin", "meeting:write", "meeting:write:admin"],
  "meeting:update:meeting": ["meeting:update:meeting", "meeting:update:meeting:admin", "meeting:write", "meeting:write:admin"],
  "meeting:delete:meeting": ["meeting:delete:meeting", "meeting:delete:meeting:admin", "meeting:write", "meeting:write:admin"],
  "user:read:user": ["user:read:user", "user:read:user:admin", "user:read", "user:read:admin"],
};

export interface ZoomEndpoints { authorize: string; token: string; revoke: string; api: string }

export const ZOOM_ENDPOINTS: ZoomEndpoints = {
  authorize: "https://zoom.us/oauth/authorize",
  token: "https://zoom.us/oauth/token",
  revoke: "https://zoom.us/oauth/revoke",
  api: "https://api.zoom.us/v2",
};

/** A failed Zoom call. `retryable`: try again later. `revoked`: only reconnecting Zoom fixes it. */
export class ZoomApiError extends Error {
  readonly status: number | null;
  readonly code: number | string | null;
  readonly retryable: boolean;
  readonly revoked: boolean;
  constructor(message: string, opts: { status?: number | null; code?: number | string | null; retryable?: boolean; revoked?: boolean } = {}) {
    super(message);
    this.name = "ZoomApiError";
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.retryable = opts.retryable ?? false;
    this.revoked = opts.revoked ?? false;
  }
}

export interface ZoomTokens { accessToken: string; refreshToken: string; expiresAt: Date; scope: string }
export interface ZoomUser { id: string; email: string; accountId: string | null }
export interface ZoomMeetingInput { topic: string; start: Date; durationMinutes: number; timeZone: string; agenda?: string }
export interface ZoomMeeting { id: string; joinUrl: string }

type Fetch = typeof fetch;

/** Zoom error codes that mean the grant no longer allows the call: the token lacks a scope, or the user is gone. */
const REVOKED_API_CODES = new Set([4700, 4711, 1001, 124]);

export function zoomClient(opts: { clientId: string; clientSecret: string; endpoints?: ZoomEndpoints; fetchImpl?: Fetch }) {
  const ep = opts.endpoints ?? ZOOM_ENDPOINTS;
  const f = opts.fetchImpl ?? fetch;
  const basic = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64")}`;

  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await f(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      throw new ZoomApiError(`Could not reach Zoom: ${(error as Error).message}`, { retryable: true });
    }
  }

  async function tokenRequest(params: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await call(ep.token, {
      method: "POST", headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const reason = typeof body.error === "string" ? body.error : typeof body.reason === "string" ? body.reason : "";
      // A refresh token that was revoked, expired (90 days unused) or already rotated comes back as 400/401.
      throw new ZoomApiError(`Zoom token endpoint ${res.status} ${reason}`.trim(), {
        status: res.status, code: reason || null, retryable: res.status === 429 || res.status >= 500, revoked: res.status === 400 || res.status === 401,
      });
    }
    if (typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
      throw new ZoomApiError("Zoom token endpoint returned no tokens", { retryable: true });
    }
    return body;
  }

  const tokensFrom = (body: Record<string, unknown>, now: Date): ZoomTokens => ({
    accessToken: body.access_token as string, refreshToken: body.refresh_token as string,
    expiresAt: new Date(now.getTime() + Number(body.expires_in ?? 3600) * 1000), scope: typeof body.scope === "string" ? body.scope : "",
  });

  async function api<T>(accessToken: string, method: string, path: string, o: { body?: unknown; okStatuses?: number[] } = {}): Promise<{ status: number; body: T }> {
    const res = await call(`${ep.api}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, ...(o.body ? { "content-type": "application/json" } : {}) },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = {};
    try { parsed = text ? JSON.parse(text) : {}; } catch { /* a proxy's HTML error page: classify by status alone */ }
    const body = parsed as T & { code?: number; message?: string };
    if (res.ok || o.okStatuses?.includes(res.status)) return { status: res.status, body };
    const code = typeof body.code === "number" ? body.code : null;
    // 401 may be an access token that just expired or was replaced; the caller refreshes once and tries again.
    throw new ZoomApiError(`Zoom ${method} ${path.replace(/\/\d+/g, "/:id")} ${res.status}${code !== null ? ` (${code})` : ""}: ${body.message ?? ""}`.trim(), {
      status: res.status, code,
      retryable: res.status === 401 || res.status === 429 || res.status >= 500,
      revoked: res.status !== 401 && code !== null && REVOKED_API_CODES.has(code),
    });
  }

  const meetingBody = (m: ZoomMeetingInput) => ({
    topic: m.topic.slice(0, 200),
    // Zoom reads "...Z" as GMT; `timezone` is only how Zoom displays it to the host.
    start_time: m.start.toISOString().replace(/\.\d{3}Z$/, "Z"),
    duration: m.durationMinutes,
    timezone: m.timeZone,
    ...(m.agenda ? { agenda: m.agenda.slice(0, 2000) } : {}),
  });

  return {
    authUrl(p: { redirectUri: string; state: string; codeChallenge: string }): string {
      const url = new URL(ep.authorize);
      url.search = new URLSearchParams({
        response_type: "code", client_id: opts.clientId, redirect_uri: p.redirectUri, state: p.state,
        code_challenge: p.codeChallenge, code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },

    async exchangeCode(p: { code: string; redirectUri: string; codeVerifier: string }, now = new Date()): Promise<ZoomTokens> {
      return tokensFrom(await tokenRequest({ grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier }), now);
    },

    /** Zoom rotates refresh tokens: the old one stops working, so the new one must be stored before anything else. */
    async refresh(refreshToken: string, now = new Date()): Promise<ZoomTokens> {
      return tokensFrom(await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }), now);
    },

    /** Best effort: ends the grant on Zoom's side. */
    async revoke(token: string): Promise<void> {
      const res = await call(ep.revoke, {
        method: "POST", headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }),
      });
      if (!res.ok && res.status !== 400) throw new ZoomApiError(`Zoom revoke ${res.status}`, { status: res.status, retryable: res.status >= 500 });
    },

    /** Needed scopes the grant is missing (empty when all are there). */
    missingScopes(granted: string): string[] {
      const have = new Set(granted.split(/[\s,]+/).filter(Boolean).map((s) => s.toLowerCase()));
      return ZOOM_SCOPES.filter((s) => !SCOPE_EQUIVALENTS[s].some((e) => have.has(e)));
    },

    async me(accessToken: string): Promise<ZoomUser> {
      const { body } = await api<{ id?: string; email?: string; account_id?: string }>(accessToken, "GET", "/users/me");
      if (!body.id || !body.email) throw new ZoomApiError("Zoom did not say which user connected", { retryable: false });
      return { id: body.id, email: body.email, accountId: body.account_id ?? null };
    },

    /**
     * A scheduled meeting (type 2) with the waiting room on and join-before-host off. `default_password: true` keeps
     * Zoom's own passcode rule: a passcode is generated (and carried in the join link) unless the host turned that off.
     */
    async createMeeting(accessToken: string, m: ZoomMeetingInput): Promise<ZoomMeeting> {
      const { body } = await api<{ id?: number | string; join_url?: string }>(accessToken, "POST", "/users/me/meetings", {
        body: { ...meetingBody(m), type: 2, default_password: true, settings: { waiting_room: true, join_before_host: false } },
      });
      if (body.id === undefined || !body.join_url) throw new ZoomApiError("Zoom created a meeting without an id or join link", { retryable: true });
      return { id: String(body.id), joinUrl: body.join_url };
    },

    /** Moves a meeting; its id and join link stay the same. Returns false when the meeting no longer exists. */
    async updateMeeting(accessToken: string, meetingId: string, m: ZoomMeetingInput): Promise<boolean> {
      const { status } = await api(accessToken, "PATCH", `/meetings/${encodeURIComponent(meetingId)}`, { body: meetingBody(m), okStatuses: [404] });
      return status !== 404;
    },

    /** Deletes a meeting without emailing anyone; one that is already gone counts as deleted. */
    async deleteMeeting(accessToken: string, meetingId: string): Promise<void> {
      await api(accessToken, "DELETE", `/meetings/${encodeURIComponent(meetingId)}?schedule_for_reminder=false`, { okStatuses: [404] });
    },
  };
}

export type ZoomClient = ReturnType<typeof zoomClient>;

/**
 * The client from the environment, or null when ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET aren't set. ZOOM_OAUTH_BASE_URL and
 * ZOOM_API_BASE_URL point at a fake Zoom for tests, and are ignored in production unless HOURHAND_E2E=1.
 */
export function zoomClientFromEnv(env: Record<string, string | undefined> = process.env): ZoomClient | null {
  if (!env.ZOOM_CLIENT_ID || !env.ZOOM_CLIENT_SECRET) return null;
  const fakeAllowed = env.NODE_ENV !== "production" || env.HOURHAND_E2E === "1";
  const oauth = fakeAllowed ? env.ZOOM_OAUTH_BASE_URL?.replace(/\/+$/, "") : undefined;
  const api = fakeAllowed ? env.ZOOM_API_BASE_URL?.replace(/\/+$/, "") : undefined;
  return zoomClient({
    clientId: env.ZOOM_CLIENT_ID, clientSecret: env.ZOOM_CLIENT_SECRET,
    endpoints: {
      authorize: oauth ? `${oauth}/oauth/authorize` : ZOOM_ENDPOINTS.authorize,
      token: oauth ? `${oauth}/oauth/token` : ZOOM_ENDPOINTS.token,
      revoke: oauth ? `${oauth}/oauth/revoke` : ZOOM_ENDPOINTS.revoke,
      api: api ? `${api}/v2` : ZOOM_ENDPOINTS.api,
    },
  });
}
