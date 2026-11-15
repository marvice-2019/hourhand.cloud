import { notFound, redirect } from "next/navigation";
import { resolveHostJoin } from "@/lib/video/join";
import { joinDeps } from "@/lib/video/server";
import { JOIN_METADATA, JoinRefused } from "../../refusal";

// /v/host/<booking id>: the host's join link (host emails, the host's calendar, the dashboard). Only the signed-in host
// of the booking gets through, as moderator; the guest's manage token never appears in it.
export const dynamic = "force-dynamic";
export const metadata = JOIN_METADATA;

export default async function HostJoinPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = await params;
  const result = await resolveHostJoin(joinDeps(new Date()), bookingId);
  if (result.ok) redirect(result.url);
  if (result.reason === "sign_in") redirect("/sign-in");
  if (result.reason === "not_found" || !result.booking) notFound();
  const back = { href: `/dashboard/bookings/${result.booking.id}`, label: "Back to the booking" };
  return <JoinRefused reason={result.reason} opensAt={result.opensAt} tz={result.booking.invitee.timezone} back={back} />;
}
