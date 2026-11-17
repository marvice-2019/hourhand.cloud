import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { EmbedResize } from "@/components/EmbedResize";
import { formatMoney } from "@/lib/billing/plans";
import { practiceJsonLd, type PracticePageData } from "@/lib/clinic/page";
import { t, type Locale } from "@/lib/i18n/guest";
import { PracticeWaitlistForm } from "./PracticeWaitlistForm";

/**
 * hourhand.cloud/<practice-slug>: the practice, its services with the practitioners who offer each, and every listed
 * practitioner. Clients choose who they book; each booking goes through that practitioner's own link.
 */
export function PracticePage({ data, baseUrl, locale }: { data: PracticePageData; baseUrl: string; locale: Locale }) {
  const { practice, practitioners, services } = data;
  const price = (minor: number | null) => (minor !== null ? formatMoney(minor, "INR") : t(locale, "free"));
  return (
    <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <EmbedResize />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: practiceJsonLd(baseUrl, data) }} />
      <header>
        <h1 className="font-display text-display text-text">{practice.name}</h1>
        {practice.about && <p className="mt-2 max-w-2xl whitespace-pre-line text-text">{practice.about}</p>}
      </header>

      {services.length > 0 && (
        <section aria-labelledby="services" className="mt-8">
          <h2 id="services" className="font-display text-lg text-text">{t(locale, "services")}</h2>
          <p className="mt-1 text-text-muted">Choose who you&apos;d like to see.</p>
          <ul className="mt-4 grid gap-4">
            {services.map((s) => (
              <li key={s.id}>
                <Card>
                  <h3 className="font-display text-lg text-text">{s.name}</h3>
                  {s.description && <p className="mt-1 text-sm text-text">{s.description}</p>}
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {s.offers.map(({ practitioner: p, offer: o }) => (
                      <li key={`${p.slug}/${o.slug}`}>
                        <Link href={`/${p.slug}/${o.slug}`} className={`flex min-h-11 flex-col justify-center rounded-md border border-border px-3 py-2 hover:border-border-input ${focusRing}`}>
                          <span className="font-semibold text-text">{p.name}</span>
                          <span className="text-sm text-text-muted">{t(locale, "minutes", { n: o.durationMinutes })} · {price(o.priceMinor)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              </li>
            ))}
          </ul>
          <PracticeWaitlistForm practice={practice.slug} practiceName={practice.name} services={services.map((s) => ({ slug: s.slug, name: s.name }))} locale={locale} />
        </section>
      )}

      <section aria-labelledby="team" className="mt-8">
        <h2 id="team" className="font-display text-lg text-text">Our practitioners</h2>
        <ul className="mt-4 grid gap-4 md:grid-cols-2">
          {practitioners.map((p) => (
            <li key={p.userId}>
              <Card className="h-full">
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- the practitioner's own upload, served by our route */}
                  {p.hasPhoto && <img src={`/api/photo/${p.slug}?v=${p.photoVersion}`} alt="" width={56} height={56} className="h-14 w-14 rounded-full object-cover" />}
                  <div>
                    <h3 className="font-display text-lg text-text">{p.name}</h3>
                    {p.headline && <p className="text-sm text-text-muted">{p.headline}</p>}
                  </div>
                </div>
                {p.offers.length > 0 && (
                  <ul className="mt-3 grid gap-1">
                    {p.offers.map((o) => (
                      <li key={o.slug}>
                        <Link href={`/${p.slug}/${o.slug}`} className={`inline-flex min-h-11 items-center text-accent underline ${focusRing}`}>
                          {o.name} · {t(locale, "minutes", { n: o.durationMinutes })} · {price(o.priceMinor)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
                <Link href={`/${p.slug}`} className={`mt-2 inline-flex min-h-11 items-center font-semibold text-accent ${focusRing}`}>About {p.name}</Link>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
