import Link from "next/link";
import { notFound } from "next/navigation";
import { BookingFooter } from "@/components/BookingFooter";
import { BuyProduct } from "@/components/BuyProduct";
import { focusRing } from "@/components/ui/focus";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { formatAmount } from "@/lib/money";
import { publicProduct } from "@/lib/products/products";

export const dynamic = "force-dynamic";

/** One product (B20), with the form to buy it. */
export default async function ProductPage({ params }: { params: Promise<{ slug: string; product: string }> }) {
  const { slug, product } = await params;
  const found = authEnabled() ? await publicProduct(getPool(process.env.DATABASE_URL as string), slug, product) : null;
  if (!found) notFound();
  const { host, product: p } = found;
  const price = p.priceMinor > 0 ? formatAmount(p.priceMinor, "INR") : null;
  return (
    <main className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <p className="text-sm font-semibold text-text-muted"><Link href={`/${host.slug}/shop`} className={`underline ${focusRing}`}>{host.name}</Link></p>
      <h1 className="font-display text-xl text-text">{p.title}</h1>
      <p className="mt-1 text-text-muted">{price ?? "Free"} · {p.delivery === "file" ? "Download" : "Private link"}</p>
      {p.description && <p className="mt-3 whitespace-pre-line text-text">{p.description}</p>}
      <BuyProduct slug={host.slug} product={p.slug} hostName={host.name} title={p.title} price={price} />
      <BookingFooter hostId={host.id} />
    </main>
  );
}
