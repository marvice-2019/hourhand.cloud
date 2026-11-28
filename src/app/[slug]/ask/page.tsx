import { notFound } from "next/navigation";
import { AskQuestion } from "@/components/AskQuestion";
import { BookingFooter } from "@/components/BookingFooter";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { formatAmount } from "@/lib/money";
import { publicOffer } from "@/lib/questions/questions";

export const dynamic = "force-dynamic";

/** Ask a host a question (B19), when they have it on. */
export default async function AskPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const found = pool ? await publicOffer(pool, slug) : null;
  if (!found) notFound();
  const { host, offer } = found;
  const price = offer.priceMinor > 0 ? formatAmount(offer.priceMinor, "INR") : null;
  return (
    <main className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <p className="text-sm font-semibold text-text-muted">{host.name}</p>
      <h1 className="font-display text-xl text-text">Ask {host.name} a question</h1>
      {offer.intro && <p className="mt-2 whitespace-pre-line text-text">{offer.intro}</p>}
      <p className="mt-2 text-text-muted">
        {price ? `${price} for a written answer` : "Free"}, usually within {offer.responseDays} {offer.responseDays === 1 ? "day" : "days"}. The answer comes to your email.{price ? " If it isn't answered within a day after that, you get your money back in full." : ""}
      </p>
      <AskQuestion slug={host.slug} hostName={host.name} price={price} />
      <BookingFooter hostId={host.id} />
    </main>
  );
}
