import Link from "next/link";
import { renderSVG } from "uqr";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { Plan } from "@/lib/billing/plans";
import { LIMITS } from "@/lib/billing/plans";
import { hostWaLink } from "@/lib/whatsapp-booking";
import { whatsappConfig } from "@/lib/whatsapp-cloud";
import { disableWhatsAppBooking, enableWhatsAppBooking } from "./whatsapp-booking-actions";

/** Book over WhatsApp (3.4): the host turns it on and gets their wa.me link and a QR code to share. */
export function WhatsAppBookingCard({ slug, plan, on, notice }: { slug: string; plan: Plan | null; on: boolean; notice?: string }) {
  const link = whatsappConfig() ? hostWaLink(slug) : null;
  const allowed = plan !== null && LIMITS[plan].whatsappBooking;
  const qr = link ? `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(link, { border: 2 }))}` : null;

  return (
    <Card className="mt-6 max-w-2xl" id="whatsapp-booking">
      <h2 className="font-semibold text-text">WhatsApp · clients find your times by message</h2>
      <p className="mt-1 text-text-muted">
        Clients message Hourhand&apos;s WhatsApp number, pick a session and a free time, and get a link to finish booking on your page.
        Payment, questions and confirmations work as they do today.
      </p>
      {notice && <p role="status" className="mt-3 text-success">{notice === "on" ? "On. Share your link or QR code below." : "Off. Clients asking for you on WhatsApp are no longer shown your times."}</p>}

      {!link ? (
        <p className="mt-4 text-sm text-text-muted">WhatsApp isn&apos;t set up on this server yet.</p>
      ) : !allowed ? (
        <p className="mt-4 text-sm text-text-muted">
          Booking over WhatsApp needs the Solo or Duo plan.{" "}
          <Link href="/dashboard/plan" className="font-semibold text-accent underline">See plans</Link>
        </p>
      ) : on ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-start">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text">Your link</p>
            <a href={link} className="block break-all font-mono text-sm text-accent underline">{link}</a>
            <p className="mt-2 text-sm text-text-muted">It opens WhatsApp with &ldquo;Book with {slug}&rdquo; ready to send. Put it in your Instagram bio, WhatsApp status or website.</p>
            <form action={disableWhatsAppBooking} className="mt-4">
              <Button type="submit" variant="secondary" size="sm">Turn off</Button>
            </form>
          </div>
          {qr && (
            <div className="justify-self-start">
              {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URI, nothing to optimise */}
              <img src={qr} alt={`QR code for ${link}`} width={160} height={160} className="rounded-md bg-white" />
              <a href={qr} download={`hourhand-whatsapp-${slug}.svg`} className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">Download QR code</a>
            </div>
          )}
        </div>
      ) : (
        <form action={enableWhatsAppBooking} className="mt-4">
          <Button type="submit">Turn on</Button>
        </form>
      )}
    </Card>
  );
}
