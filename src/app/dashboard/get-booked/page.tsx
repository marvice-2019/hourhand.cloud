import type { ReactNode } from "react";
import QRCode from "qrcode";
import Link from "next/link";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { Card } from "@/components/ui/Card";
import { buttonClasses } from "@/components/ui/Button";
import { resolveBaseUrl } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { channelLink, pageUrl, qrSvg } from "@/lib/share-links";

export const dynamic = "force-dynamic";

/**
 * Put the booking page behind the link on Instagram and Google Business Profile. Both are self-serve today:
 * Instagram's profile links and Google's booking link. Instagram's "Book now" action button and Google's in-Search
 * booking need a partner integration (docs/partnerships.md), so the steps here don't promise either.
 */
export default async function GetBookedPage() {
  const user = await requireHost();
  const base = (resolveBaseUrl() ?? "https://hourhand.cloud").replace(/\/+$/, "");
  const instagram = channelLink(base, user.slug, "instagram");
  const google = channelLink(base, user.slug, "google_business");
  const qrLink = channelLink(base, user.slug, "qr");
  const svg = await qrSvg(qrLink);
  const png = await QRCode.toDataURL(qrLink, { errorCorrectionLevel: "M", margin: 2, width: 1024 });
  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-xl text-text">Get booked from Instagram and Google</h1>
      <p className="mt-2 text-text-muted">
        Put your booking page one tap away where people already find you. Each place gets its own link, so your booking
        numbers can show which one brings clients. Your plain link is <span className="font-semibold text-text">{pageUrl(base, user.slug)}</span>.
      </p>

      <Card className="mt-6">
        <h2 className="font-semibold text-text">Instagram</h2>
        <LinkRow url={instagram} />
        <Steps>
          <li>Open Instagram, go to your profile and tap <b>Edit profile</b>.</li>
          <li>Tap <b>Links</b>, then <b>Add external link</b>.</li>
          <li>Paste the link above. For the title, type <b>Book now</b> (or &ldquo;Book a session&rdquo;). Tap <b>Done</b>.</li>
          <li>It shows under your bio. You can have up to five links; drag this one to the top.</li>
          <li>In Stories, add the <b>Link</b> sticker with the same link so viewers can book straight from a Story.</li>
        </Steps>
        <p className="mt-3 text-sm text-text-muted">
          Instagram&apos;s &ldquo;Book now&rdquo; action button only works with the scheduling apps on Meta&apos;s partner list, and Hourhand isn&apos;t
          on it yet. The bio link above does the same job: one tap opens your page inside Instagram, where guests pick a time and book.
        </p>
      </Card>

      <Card className="mt-6">
        <h2 className="font-semibold text-text">Google Business Profile</h2>
        <LinkRow url={google} />
        <Steps>
          <li>Your profile must be verified first. Search Google for your business name while signed in to the account that manages it.</li>
          <li>On your profile, select <b>Bookings</b> (in the Google Maps app: <b>Edit profile</b>, then <b>Bookings</b>).</li>
          <li>Select <b>Add link</b> (or <b>Add another link</b>), paste the link above and select <b>Save</b>.</li>
          <li>If you have more than one booking link, mark this one as your preferred link.</li>
          <li>Google checks the link before it appears on Search and Maps; that can take a few days.</li>
        </Steps>
        <p className="mt-3 text-sm text-text-muted">
          No <b>Bookings</b> option? Google doesn&apos;t offer it for every business type. Add the link as your <b>Website</b> instead, so
          people can still book from your profile. Google allows one booking link per website, and the page it opens must let people
          book, which yours does.
        </p>
      </Card>

      <Card className="mt-6">
        <h2 className="font-semibold text-text">QR code</h2>
        <p className="mt-1 text-text-muted">For your counter, visiting card or a Story. Scanning it opens your booking page.</p>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
          <div role="img" aria-label={`QR code for ${qrLink}`} className="h-44 w-44 shrink-0 rounded-md border border-border bg-white" dangerouslySetInnerHTML={{ __html: svg }} />
          <div className="flex flex-wrap gap-2">
            <a className={buttonClasses({ variant: "secondary", size: "sm" })} href={png} download={`hourhand-${user.slug}-qr.png`}>Download PNG</a>
            <a className={buttonClasses({ variant: "secondary", size: "sm" })} href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} download={`hourhand-${user.slug}-qr.svg`}>Download SVG (print)</a>
            <CopyLinkButton url={qrLink} label="Copy QR link" />
          </div>
        </div>
      </Card>

      <Card className="mt-6">
        <h2 className="font-semibold text-text">What people see when you share it</h2>
        <p className="mt-1 text-text-muted">
          Your link shows this card in Instagram DMs, WhatsApp and Google. It uses your photo, headline and first three services from{" "}
          <Link href="/dashboard/profile" className="font-semibold text-accent underline">Your page</Link>.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element -- our own generated card, already sized */}
        <img src={`/${user.slug}/opengraph-image`} alt="Your link preview card" width={1200} height={630} loading="lazy" className="mt-4 h-auto w-full rounded-md border border-border" />
      </Card>
    </div>
  );
}

function LinkRow({ url }: { url: string }) {
  return (
    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      <code className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-surface p-3 font-mono text-sm text-text">{url}</code>
      <CopyLinkButton url={url} />
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="mt-4 list-decimal space-y-2 pl-5 text-text">{children}</ol>;
}
