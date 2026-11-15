import Link from "next/link";
import { changeClinicAction, startClinicAction } from "@/app/dashboard/practice/billing-actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import type { HostSubscription } from "@/lib/billing/account";
import { paidPlaces } from "@/lib/clinic/billing";
import { practiceContext, practitionerCount } from "@/lib/clinic/practices";
import { CLINIC_COUNTS, clinicExtraLine, clinicPriceLine } from "@/lib/clinic/pricing";
import { getPool } from "@/lib/data/pg-store";

const ERRORS: Record<string, string> = {
  demo: "The demo copy can't take payments.",
  not_owner: "Only the practice's owner can change its plan. Set up your own practice first, or ask its owner.",
  invalid_count: "Pick 3 to 10 practitioners.",
  places_in_use: "More practitioners are in the practice than that. Take someone off the page first.",
  already_subscribed: "You already have a subscription. Use Switch to Clinic below.",
  not_configured: "Clinic isn't set up on this server yet.",
  no_subscription: "There's no subscription to change.",
  not_razorpay: "Clinic is billed in rupees through Razorpay. Cancel your current plan, then subscribe to Clinic when it ends.",
  cannot_change: "Razorpay couldn't change this subscription. Subscriptions paid by UPI AutoPay or eMandate can't be changed: cancel it above and subscribe to Clinic once it ends. Your practice and everyone's data stay.",
  provider: "Razorpay didn't respond. Try again in a minute; nothing was changed.",
};

/** The Clinic plan on the Plan page: price per practitioner count, and start, switch or resize. */
export async function ClinicPlanCard({ userId, sub, error, done }: { userId: string; sub: HostSubscription | null; error?: string; done?: string }) {
  const db = getPool(process.env.DATABASE_URL as string);
  const ctx = await practiceContext(db, userId);
  const owner = ctx?.role === "owner";
  const [inUse, paid] = owner ? await Promise.all([practitionerCount(db, ctx!.practice.id), paidPlaces(db, userId)]) : [0, null];
  const holding = Boolean(sub?.subscriptionId) && sub!.plan !== "free" && sub!.status !== "cancelled";
  const onClinic = holding && sub!.plan === "clinic";
  const initial = Math.max(3, paid ?? inUse);
  return (
    <Card className="mt-6 max-w-2xl">
      <h2 className="font-display text-lg text-text">Clinic</h2>
      <p className="mt-1 text-text-muted">
        For a clinic or institute: 3 to 10 practitioners, each with their own calendars, hours, services and booking link. One practice page,
        admins who see every booking, one GST invoice series and one Razorpay account for the practice. Clients choose who they book.
      </p>
      <p className="mt-3 font-semibold text-text">{clinicPriceLine(3)} for up to 3 practitioners</p>
      <p className="text-text">{clinicExtraLine()}, up to 10</p>
      {error && <p role="alert" className="mt-3 text-danger">{ERRORS[error] ?? "That didn't work."}</p>}
      {done === "changed" && <p role="status" className="mt-3 text-success">Done. Your plan is updated.</p>}
      {!owner ? (
        <p className="mt-4 text-text">
          {ctx ? `You're in ${ctx.practice.name}; its owner manages the plan.` : "First set up your practice. Your bookings, event types and clients stay as they are."}{" "}
          {!ctx && <Link href="/dashboard/practice" className={`font-semibold text-accent underline ${focusRing}`}>Set up a practice</Link>}
        </p>
      ) : (
        <form action={onClinic || holding ? changeClinicAction : startClinicAction} className="mt-4 grid max-w-md gap-2">
          <label htmlFor="clinic-count" className="text-sm font-semibold text-text">Practitioner places{onClinic && paid ? ` (now ${paid})` : ""}</label>
          <select id="clinic-count" name="practitioners" defaultValue={String(initial)}
            className={`block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
            {CLINIC_COUNTS.map((n) => <option key={n} value={n} disabled={n < inUse}>{n} practitioners · {clinicPriceLine(n)}</option>)}
          </select>
          <p className="text-sm text-text-muted">{inUse} in use now. The new total applies straight away.</p>
          <div><Button type="submit">{onClinic ? "Change places" : holding ? "Switch to Clinic" : "Choose Clinic"}</Button></div>
        </form>
      )}
    </Card>
  );
}
