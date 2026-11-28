import Link from "next/link";
import { notFound } from "next/navigation";
import { BookingFooter } from "@/components/BookingFooter";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { formatAmount } from "@/lib/money";
import { publicProducts } from "@/lib/products/products";

export const dynamic = "force-dynamic";

/** A host's shop (B20): their products on sale. */
export default async function ShopPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = authEnabled() ? await publicProducts(getPool(process.env.DATABASE_URL as string), slug) : null;
  if (!found) notFound();
  const { host, products } = found;
  return (
    <main className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <p className="text-sm font-semibold text-text-muted">{host.name}</p>
      <h1 className="font-display text-xl text-text">{host.name}&apos;s shop</h1>
      <ul className="mt-6 grid gap-4">
        {products.map((p) => (
          <li key={p.id}>
            <Card>
              <h2 className="font-semibold text-text">
                <Link href={`/${host.slug}/shop/${p.slug}`} className={`underline ${focusRing}`}>{p.title}</Link>
              </h2>
              <p className="mt-1 text-text-muted">{p.priceMinor > 0 ? formatAmount(p.priceMinor, "INR") : "Free"}</p>
              {p.description && <p className="mt-2 line-clamp-3 whitespace-pre-line text-text">{p.description}</p>}
            </Card>
          </li>
        ))}
      </ul>
      <BookingFooter hostId={host.id} />
    </main>
  );
}
