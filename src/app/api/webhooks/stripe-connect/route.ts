import { NextResponse } from "next/server";
import { tokenKey } from "@/lib/crypto/seal";
import { getPool } from "@/lib/data/pg-store";
import { stripeCheckoutFromEnv, stripeDepsFor } from "@/lib/payments/stripe-checkout";
import { stripeConnectFromEnv } from "@/lib/payments/stripe-connect";
import { handleConnectEvent, parseConnectDelivery } from "@/lib/payments/stripe-webhook";

export const dynamic = "force-dynamic";

/**
 * Stripe's "Connected accounts" webhook endpoint: guests' Checkout Sessions and hosts' account changes. 200 once handled
 * (or ignored), 400 for a bad signature or body, 503 when Stripe isn't set up here, 500 so Stripe retries a failure.
 */
export async function POST(request: Request) {
  const connect = stripeConnectFromEnv();
  const checkout = stripeCheckoutFromEnv();
  let key: Buffer;
  try {
    key = tokenKey();
  } catch {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (!connect || !checkout || !process.env.DATABASE_URL) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const parsed = parseConnectDelivery(await request.text(), request.headers.get("stripe-signature"), connect.webhookSecret);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  const pool = getPool(process.env.DATABASE_URL);
  try {
    const outcome = await handleConnectEvent({ stripe: stripeDepsFor(pool, key, checkout), connect: connect.api, key }, parsed.body);
    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    console.error(`[payments] Stripe Connect event ${String(parsed.body.id)} (${String(parsed.body.type)}) failed; Stripe will retry`, error);
    return NextResponse.json({ error: "handling_failed" }, { status: 500 });
  }
}
