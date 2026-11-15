import { notFound, redirect } from "next/navigation";
import { resolveJoin } from "@/lib/video/join";
import { joinDeps } from "@/lib/video/server";
import { JOIN_METADATA, JoinRefused } from "../refusal";

// /v/<manage token>: the guest's join link (their emails and booking pages). Every visit re-checks the booking and who
// is joining (the signed-in host of the booking joins as host), then sends them to the Jitsi room with a token minted
// just now. Nothing is cached.
export const dynamic = "force-dynamic";
export const metadata = JOIN_METADATA;

export default async function GuestJoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const result = await resolveJoin(joinDeps(new Date()), token);
  // Outside any try block: redirect() works by throwing.
  if (result.ok) redirect(result.url);
  if (result.reason === "not_found" || result.reason === "sign_in" || !result.booking) notFound();
  const back = result.role === "host" ? { href: `/dashboard/bookings/${result.booking.id}`, label: "Back to the booking" } : { href: `/b/${token}`, label: "See your booking" };
  return <JoinRefused reason={result.reason} opensAt={result.opensAt} tz={result.booking.invitee.timezone} back={back} />;
}
