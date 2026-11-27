import { after, NextResponse, type NextRequest } from "next/server";
import { sourceFromBody } from "@/lib/analytics/source";
import { track } from "@/lib/analytics/store";
import { authEnabled } from "@/lib/auth/auth";
import { getHostContext } from "@/lib/auth/session";
import { handleCreateBooking, type FunnelReporter } from "@/lib/booking";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { requestPaymentDeps } from "@/lib/payments/request-deps";
import { clientIp, rateLimiter } from "@/lib/rate-limit";
import { getMailer } from "@/lib/mail/mailer";
import { guestEmailCodeSecret } from "@/lib/guest-email-code";
import type { EmailCodeDeps } from "@/lib/booking";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request", fields: { body: "Send a JSON body." } }, { status: 400 });
  }
  const clientKey = clientIp(request.headers);
  // "Book for them" from the host's dashboard: the account is taken from the session, never from the body.
  const onBehalf = typeof input === "object" && input !== null && (input as { onBehalf?: unknown }).onBehalf === true;
  const ctx = onBehalf ? await getHostContext() : null;
  // Only bookings made from a public booking page carry `src`; those steps go to the host's analytics, after the response.
  // A host booking for their client isn't a visitor, so it isn't tracked.
  const src = typeof input === "object" && input !== null && "src" in input ? (input as { src: unknown }).src : undefined;
  const funnel: FunnelReporter | undefined = authEnabled() && src !== undefined && !onBehalf
    ? (step) => { const now = new Date(); after(() => track(getPool(process.env.DATABASE_URL as string), { headers: request.headers, clientKey }, { ...step, source: sourceFromBody(src) }, now)); }
    : undefined;
  const { status, body } = await handleCreateBooking(store, input, new Date(), { clientKey, limiter: rateLimiter }, requestPaymentDeps(), funnel,
    ctx ? { hostId: ctx.host.id } : null, emailCodes());
  return NextResponse.json(body, { status });
}

/** B11: the mailer and server key for guest email codes; null when the key isn't set, so the code step reports it can't send. */
function emailCodes(): EmailCodeDeps | null {
  let secret: string;
  try { secret = guestEmailCodeSecret(); } catch { return null; }
  return { secret, send: (mail) => getMailer().send(mail) };
}
