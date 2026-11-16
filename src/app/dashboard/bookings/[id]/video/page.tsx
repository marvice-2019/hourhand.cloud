import { notFound, redirect } from "next/navigation";
import { getHostI18n } from "@/lib/i18n/host/server";
import { resolveHostJoin } from "@/lib/video/join";
import { joinDeps } from "@/lib/video/server";
import { JOIN_METADATA, JoinRefused } from "@/components/VideoJoinRefused";

// /dashboard/bookings/<id>/video: the host's join link (host emails, the host's calendar, the dashboard). Only the
// signed-in host of the booking gets through, as moderator; the guest's manage token never appears in it.
export const dynamic = "force-dynamic";
export const metadata = JOIN_METADATA;

export default async function HostJoinPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await resolveHostJoin(joinDeps(new Date()), id);
  if (result.ok) redirect(result.url);
  if (result.reason === "sign_in") redirect("/sign-in");
  if (result.reason === "not_found" || !result.booking) notFound();
  // In the host's dashboard language (every host language is also a guest language, which the page's lines cover).
  const { t, locale } = await getHostI18n();
  const back = { href: `/dashboard/bookings/${result.booking.id}`, label: t("bookings.videoBack") };
  return <JoinRefused reason={result.reason} opensAt={result.opensAt} tz={result.booking.invitee.timezone} locale={locale} back={back} />;
}
