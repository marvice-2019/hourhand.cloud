import { describe, expect, it } from "vitest";
import { ZOOM_SCOPES, ZoomApiError, zoomClient, zoomClientFromEnv } from "./client";
import { verifyZoomSignature } from "./webhook";
import { createHmac } from "node:crypto";

type Call = { url: URL; init: RequestInit };

/** A fetch that answers from a list of [status, body] in order and records each request. */
function fake(responses: [number, unknown][]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: new URL(url), init });
    const [status, body] = responses.shift() ?? [500, {}];
    return new Response(status === 204 ? null : typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, client: zoomClient({ clientId: "cid", clientSecret: "csec", fetchImpl: impl }) };
}
const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.init.body as URLSearchParams));
const header = (c: Call, name: string) => new Headers(c.init.headers).get(name);
const json = (c: Call) => JSON.parse(c.init.body as string);
const meeting = { topic: "Coaching with Meera", start: new Date("2031-01-06T04:00:00.000Z"), durationMinutes: 45, timeZone: "Asia/Kolkata" };

describe("zoom client: OAuth", () => {
  it("builds the authorize URL with PKCE and state", () => {
    const url = new URL(fake([]).client.authUrl({ redirectUri: "https://h.test/cb", state: "st", codeChallenge: "ch" }));
    expect(url.origin + url.pathname).toBe("https://zoom.us/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code", client_id: "cid", redirect_uri: "https://h.test/cb", state: "st", code_challenge: "ch", code_challenge_method: "S256",
    });
  });

  it("exchanges a code with Basic auth and the verifier", async () => {
    const f = fake([[200, { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: ZOOM_SCOPES.join(" ") }]]);
    const t = await f.client.exchangeCode({ code: "c", redirectUri: "https://h.test/cb", codeVerifier: "v" }, new Date("2031-01-01T00:00:00Z"));
    expect(t).toMatchObject({ accessToken: "at", refreshToken: "rt" });
    expect(t.expiresAt.toISOString()).toBe("2031-01-01T01:00:00.000Z");
    expect(f.calls[0].url.toString()).toBe("https://zoom.us/oauth/token");
    expect(header(f.calls[0], "authorization")).toBe(`Basic ${Buffer.from("cid:csec").toString("base64")}`);
    expect(form(f.calls[0])).toEqual({ grant_type: "authorization_code", code: "c", redirect_uri: "https://h.test/cb", code_verifier: "v" });
  });

  it("a refresh returns the rotated refresh token", async () => {
    const f = fake([[200, { access_token: "at2", refresh_token: "rt2", expires_in: 3600 }]]);
    expect(await f.client.refresh("rt1")).toMatchObject({ accessToken: "at2", refreshToken: "rt2" });
    expect(form(f.calls[0])).toEqual({ grant_type: "refresh_token", refresh_token: "rt1" });
  });

  it("a refused refresh token means reconnect; an outage means retry", async () => {
    const revoked = await fake([[401, { reason: "Invalid Token!", error: "invalid_request" }]]).client.refresh("rt").catch((e) => e);
    expect(revoked).toBeInstanceOf(ZoomApiError);
    expect(revoked).toMatchObject({ revoked: true, retryable: false });
    const busy = await fake([[503, {}]]).client.refresh("rt").catch((e) => e);
    expect(busy).toMatchObject({ revoked: false, retryable: true });
  });

  it("accepts granular, classic or admin scopes, and names what's missing", () => {
    const c = fake([]).client;
    expect(c.missingScopes(ZOOM_SCOPES.join(" "))).toEqual([]);
    expect(c.missingScopes("meeting:write user:read")).toEqual([]);
    expect(c.missingScopes("meeting:write:meeting user:read:user")).toEqual(["meeting:update:meeting", "meeting:delete:meeting"]);
  });
});

describe("zoom client: meetings", () => {
  it("creates a scheduled meeting with the waiting room on, join before host off and Zoom's passcode", async () => {
    const f = fake([[201, { id: 81234567890, join_url: "https://zoom.us/j/81234567890?pwd=abc", password: "abc" }]]);
    expect(await f.client.createMeeting("at", meeting)).toEqual({ id: "81234567890", joinUrl: "https://zoom.us/j/81234567890?pwd=abc" });
    expect(f.calls[0].url.toString()).toBe("https://api.zoom.us/v2/users/me/meetings");
    expect(header(f.calls[0], "authorization")).toBe("Bearer at");
    expect(json(f.calls[0])).toEqual({
      topic: "Coaching with Meera", type: 2, start_time: "2031-01-06T04:00:00Z", duration: 45, timezone: "Asia/Kolkata",
      default_password: true, settings: { waiting_room: true, join_before_host: false },
    });
  });

  it("moves a meeting, and reports one that's gone", async () => {
    const f = fake([[204, null], [404, { code: 3001, message: "Meeting does not exist: 1." }]]);
    expect(await f.client.updateMeeting("at", "81234567890", meeting)).toBe(true);
    expect(f.calls[0].init.method).toBe("PATCH");
    expect(f.calls[0].url.pathname).toBe("/v2/meetings/81234567890");
    expect(await f.client.updateMeeting("at", "1", meeting)).toBe(false);
  });

  it("deletes without notifying anyone; one already gone counts as deleted", async () => {
    const f = fake([[204, null], [404, { code: 3001 }]]);
    await f.client.deleteMeeting("at", "81234567890");
    await f.client.deleteMeeting("at", "81234567890");
    expect(f.calls[0].init.method).toBe("DELETE");
    expect(f.calls[0].url.searchParams.get("schedule_for_reminder")).toBe("false");
  });

  it("classifies errors: 401 retries with a fresh token, 429/5xx retry, a missing scope needs a reconnect", async () => {
    const e401 = await fake([[401, { code: 124, message: "Invalid access token." }]]).client.createMeeting("at", meeting).catch((e) => e);
    expect(e401).toMatchObject({ status: 401, retryable: true, revoked: false });
    const e429 = await fake([[429, {}]]).client.createMeeting("at", meeting).catch((e) => e);
    expect(e429).toMatchObject({ retryable: true });
    const scope = await fake([[400, { code: 4711, message: "Invalid access token, does not contain scopes" }]]).client.createMeeting("at", meeting).catch((e) => e);
    expect(scope).toMatchObject({ retryable: false, revoked: true });
    const plan = await fake([[400, { code: 3161, message: "Meeting hosting and scheduling capabilities are not allowed" }]]).client.createMeeting("at", meeting).catch((e) => e);
    expect(plan).toMatchObject({ retryable: false, revoked: false });
  });

  it("reads which user connected", async () => {
    const f = fake([[200, { id: "zu1", email: "priya@zoom.test", account_id: "acc" }]]);
    expect(await f.client.me("at")).toEqual({ id: "zu1", email: "priya@zoom.test", accountId: "acc" });
  });
});

describe("zoom client from the environment", () => {
  it("is off without both credentials, and test URLs are ignored in production", () => {
    expect(zoomClientFromEnv({ ZOOM_CLIENT_ID: "a" })).toBeNull();
    const prod = zoomClientFromEnv({ ZOOM_CLIENT_ID: "a", ZOOM_CLIENT_SECRET: "b", NODE_ENV: "production", ZOOM_OAUTH_BASE_URL: "https://evil.test" })!;
    expect(prod.authUrl({ redirectUri: "r", state: "s", codeChallenge: "c" })).toMatch(/^https:\/\/zoom\.us\//);
    const dev = zoomClientFromEnv({ ZOOM_CLIENT_ID: "a", ZOOM_CLIENT_SECRET: "b", NODE_ENV: "test", ZOOM_OAUTH_BASE_URL: "http://fake.test/" })!;
    expect(dev.authUrl({ redirectUri: "r", state: "s", codeChallenge: "c" })).toMatch(/^http:\/\/fake\.test\/oauth\/authorize/);
  });
});

describe("zoom webhook signature", () => {
  const secret = "whsec";
  const body = '{"event":"app_deauthorized"}';
  const now = new Date("2031-01-01T00:00:00Z");
  const ts = String(now.getTime() / 1000);
  const sign = (t: string, b: string, s = secret) => `v0=${createHmac("sha256", s).update(`v0:${t}:${b}`).digest("hex")}`;

  it("accepts Zoom's v0 signature and refuses a wrong secret, a changed body, or an old request", () => {
    expect(verifyZoomSignature(secret, body, ts, sign(ts, body), now)).toBe(true);
    expect(verifyZoomSignature(secret, body, ts, sign(ts, body, "other"), now)).toBe(false);
    expect(verifyZoomSignature(secret, `${body} `, ts, sign(ts, body), now)).toBe(false);
    const old = String(now.getTime() / 1000 - 600);
    expect(verifyZoomSignature(secret, body, old, sign(old, body), now)).toBe(false);
    expect(verifyZoomSignature(secret, body, null, sign(ts, body), now)).toBe(false);
  });
});
