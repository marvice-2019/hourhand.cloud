// B14: what every /api/v1 route does around its answer: the bearer key, the per-key limit, and JSON out.
import type pg from "pg";
import { createRateLimiter, rateLimiter } from "../rate-limit";
import { authenticateApiKey } from "./keys";
import type { ApiAnswer, ApiContext } from "./v1";

export const API_LIMIT = { max: 120, windowMs: 60_000 };

export interface ApiDeps {
  db: Pick<pg.Pool, "query"> | null;
  base: string;
  limiter?: Pick<ReturnType<typeof createRateLimiter>, "take">;
  now?: () => Date;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
}

export async function handleApiRequest(request: Request, deps: ApiDeps, answer: (ctx: ApiContext) => Promise<ApiAnswer>): Promise<Response> {
  if (!deps.db) return json(503, { error: "not_available", message: "The API isn't switched on for this server." });
  const now = (deps.now ?? (() => new Date()))();
  const auth = await authenticateApiKey(deps.db, request.headers.get("authorization"), now);
  if (!auth) return json(401, { error: "invalid_key", message: "Send a valid key as Authorization: Bearer <key>." }, { "www-authenticate": "Bearer" });
  if (!(deps.limiter ?? rateLimiter).take(`api:${auth.keyId}`, API_LIMIT)) {
    return json(429, { error: "rate_limited", message: `Up to ${API_LIMIT.max} requests a minute per key.` }, { "retry-after": "60" });
  }
  const a = await answer({ db: deps.db, userId: auth.userId, base: deps.base, now });
  return json(a.status, a.body);
}
