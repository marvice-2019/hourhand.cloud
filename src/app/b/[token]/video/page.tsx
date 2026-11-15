import { notFound, redirect } from "next/navigation";
import { resolveLocale } from "@/lib/i18n/guest";
import { resolveJoin } from "@/lib/video/join";
import { joinDeps } from "@/lib/video/server";
import { JOIN_METADATA, JoinRefused } from "@/components/VideoJoinRefused";

// /b/<manage token>/video: the guest's join link (their emails and booking pages). Every visit re-checks the booking and who
// is joining (the signed-in host of the booking joins as host), then sends them to the Jitsi room with a token minted
// just now. Nothing is cached.
export const dynamic = "force-dynamic";
export const metadata = JOIN_METADATA;

export default async function GuestJoinPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { token } = await params;
  const { lang } = await searchParams;
  const result = await resolveJoin(joinDeps(new Date()), token);
  // Outside any try block: redirect() works by throwing.
  if (result.ok) redirect(result.url);
  if (result.reason === "not_found" || result.reason === "sign_in" || !result.booking) notFound();
  const { booking } = result;
  if (result.role === "host") {
    return <JoinRefused reason={result.reason} opensAt={result.opensAt} tz={booking.invitee.timezone} locale="en" back={{ href: `/dashboard/bookings/${booking.id}`, label: "Back to the booking" }} />;
  }
  // The language the guest booked in, unless they pick another here.
  const locale = resolveLocale(lang, booking.invitee.locale);
  const q = lang === locale ? `?lang=${locale}` : "";
  return <JoinRefused reason={result.reason} opensAt={result.opensAt} tz={booking.invitee.timezone} locale={locale} back={{ href: `/b/${token}${q}` }} switcherPath={`/b/${token}/video`} />;
}
