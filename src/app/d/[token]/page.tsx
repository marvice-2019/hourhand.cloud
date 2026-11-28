import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { orderByToken, type OrderStatus } from "@/lib/products/products";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

const STATUS: Record<OrderStatus, string> = {
  pending: "Waiting for your payment. If you paid, this page updates within a minute or two.",
  paid: "Paid. It's yours.",
  failed: "The payment didn't go through, and nothing was charged.",
  refund_pending: "Refunded: your payment is on its way back, and the download has stopped.",
  refunded: "Refunded in full. Banks usually take 5 to 7 working days.",
};

/** The buyer's private page for their order (B20), from the link in their receipt. */
export default async function DownloadPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const o = authEnabled() ? await orderByToken(getPool(process.env.DATABASE_URL as string), token) : null;
  if (!o) notFound();
  const button = `inline-block rounded-md bg-accent px-4 py-2 font-semibold text-on-accent ${focusRing}`;
  return (
    <main className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <p className="text-sm font-semibold text-text-muted">{o.hostName}</p>
      <h1 className="font-display text-xl text-text">{o.productTitle}</h1>
      <p role="status" className="mt-2 text-text">{STATUS[o.status]}</p>
      {o.status === "paid" && (
        <Card className="mt-4">
          {o.delivery === "file" && o.hasFile && (o.downloadsLeft > 0
            ? <>
                <a href={`/api/downloads/${token}`} className={button}>Download {o.filename}</a>
                <p className="mt-2 text-sm text-text-muted">{o.downloadsLeft} {o.downloadsLeft === 1 ? "download" : "downloads"} left on this link.</p>
              </>
            : <p className="text-text">This link has used all its downloads. Reply to your receipt email to ask {o.hostName} for a new one.</p>)}
          {o.delivery === "link" && o.linkUrl && (
            <a href={o.linkUrl} rel="noopener noreferrer nofollow" className={button}>Open your link</a>
          )}
        </Card>
      )}
      <p className="mt-6 text-sm text-text-muted">Keep this link private: anyone with it can get what you bought.</p>
    </main>
  );
}
