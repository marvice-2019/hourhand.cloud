import { notFound, redirect } from "next/navigation";
import { resolveLocale } from "@/lib/i18n/guest";
import { getHostI18n } from "@/lib/i18n/host/server";
import { resolveExtraGuestJoin } from "@/lib/video/join";
import { joinDeps } from "@/lib/video/server";
import { JOIN_METADATA, JoinRefused } from "@/components/VideoJoinRefused";

// /b/g/<token>: an extra guest's own join link (their emails only). Same checks as the guest's link on every visit,
// plus: that email must still be on the booking. It never opens the booking's manage page.
export const dynamic = "force-dynamic";
export const metadata = JOIN_METADATA;

export default async function ExtraGuestJoinPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { token } = await params;
  const { lang } = await searchParams;
  const result = await resolveExtraGuestJoin(joinDeps(new Date()), token);
  if (result.ok) redirect(result.url);
  if (result.reason === "not_found" || result.reason === "sign_in" || !result.booking) notFound();
  const { booking } = result;
  if (result.role === "host") {
    const { t, locale } = await getHostI18n();
    return <JoinRefused reason={result.reason} opensAt={result.opensAt} tz={booking.invitee.timezone} locale={locale} back={{ href: `/dashboard/bookings/${booking.id}`, label: t("bookings.videoBack") }} />;
  }
  // The language the booking was made in; an extra guest has no booking page of their own to go back to.
  const locale = resolveLocale(lang, booking.invitee.locale);
  return <JoinRefused reason={result.reason} opensAt={result.opensAt} tz={booking.invitee.timezone} locale={locale} switcherPath={`/b/g/${token}`} />;
}
