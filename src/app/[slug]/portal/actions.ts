"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { isLocale, type Locale } from "@/lib/i18n/guest";
import { deliverPortalLink } from "@/lib/portal/mail";
import { requestPortalLink } from "@/lib/portal/request";
import { consumeLink, createSession, endSession } from "@/lib/portal/store";
import { PORTAL_COOKIE, portalKey, portalPath } from "@/lib/portal/tokens";
import { clientIp, rateLimiter } from "@/lib/rate-limit";

export type PortalRequestState = { status: "idle" | "sent" | "invalid_email" | "too_many" | "unavailable"; email?: string };

const field = (form: FormData, k: string) => String(form.get(k) ?? "");
const langOf = (form: FormData): Locale => { const l = field(form, "lang"); return isLocale(l) ? l : "en"; };

async function baseUrl(): Promise<string> {
  const configured = resolveBaseUrl();
  if (configured) return configured;
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
}

/** The sign-in form: always answers "sent" for a valid email, whether or not it has booked with this host. */
export async function requestLinkAction(_prev: PortalRequestState, form: FormData): Promise<PortalRequestState> {
  const email = field(form, "email").trim();
  if (!authEnabled()) return { status: "unavailable", email };
  const host = await store.getUserBySlug(field(form, "slug"));
  if (!host) return { status: "unavailable", email };
  const locale = langOf(form);
  const db = getPool(process.env.DATABASE_URL as string);
  const result = await requestPortalLink(
    { db, key: portalKey(), limiter: rateLimiter, now: new Date(), send: (to, url) => deliverPortalLink(to, locale, host.name, url), defer: after },
    { host: { id: host.id, slug: host.slug }, email, ip: clientIp(await headers()), baseUrl: await baseUrl(), locale },
  );
  return result.status === "sent" ? { status: "sent", email: result.email } : { status: result.status, email };
}

/** "Open my portal": uses the emailed link once and starts a 30-day session for this host's portal on this device. */
export async function openPortalAction(form: FormData): Promise<void> {
  const slug = field(form, "slug");
  const lang = langOf(form);
  const back = `${portalPath(slug)}?lang=${lang}`;
  const host = authEnabled() ? await store.getUserBySlug(slug) : null;
  if (!host) redirect(back);
  const db = getPool(process.env.DATABASE_URL as string);
  const now = new Date();
  const opened = await consumeLink(db, portalKey(), field(form, "token"), host.id, now);
  if (!opened.ok) redirect(`${back}&error=link`);
  const session = await createSession(db, host.id, opened.email, now);
  (await cookies()).set(PORTAL_COOKIE, session.id, {
    path: portalPath(host.slug), httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", expires: session.expiresAt,
  });
  redirect(back);
}

export async function signOutAction(form: FormData): Promise<void> {
  const slug = field(form, "slug");
  const jar = await cookies();
  if (authEnabled()) await endSession(getPool(process.env.DATABASE_URL as string), jar.get(PORTAL_COOKIE)?.value);
  jar.delete({ name: PORTAL_COOKIE, path: portalPath(slug) });
  redirect(`${portalPath(slug)}?lang=${langOf(form)}`);
}

