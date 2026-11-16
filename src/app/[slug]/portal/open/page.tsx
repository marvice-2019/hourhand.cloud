import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OpenPortalForm } from "@/components/portal/OpenPortalForm";
import { Card } from "@/components/ui/Card";
import { store } from "@/lib/data";
import { resolveLocale } from "@/lib/i18n/guest";
import { pt } from "@/lib/i18n/portal";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Where the emailed link lands. Opening the page uses nothing up; the client's tap does (see OpenPortalForm). */
export default async function OpenPortalPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ lang?: string }> }) {
  const host = await store.getUserBySlug((await params).slug);
  if (!host) notFound();
  const locale = resolveLocale((await searchParams).lang, host.locale);
  return (
    <main lang={locale} className="mx-auto max-w-md px-4 py-12">
      <p className="text-sm font-semibold text-text-muted">{host.name}</p>
      <h1 className="font-display text-xl text-text">{pt(locale, "openHeading")}</h1>
      <Card className="mt-6"><OpenPortalForm slug={host.slug} hostName={host.name} locale={locale} /></Card>
    </main>
  );
}
