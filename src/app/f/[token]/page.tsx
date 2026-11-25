import type { Metadata } from "next";
import Link from "next/link";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { buttonClasses } from "@/components/ui/Button";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { isLocale, resolveLocale } from "@/lib/i18n/guest";
import { rt } from "@/lib/i18n/routing";
import { routingFormByToken } from "@/lib/routing/routing";

export const dynamic = "force-dynamic";
// Shared with the people a host chooses, not the world: keep it out of search results and referrer headers.
export const metadata: Metadata = { title: "Book a time · Hourhand", robots: { index: false, follow: false }, referrer: "no-referrer" };

/** A routing form: one question, and each answer opens the right booking page or shows the host's note. No account. */
export default async function RoutingFormPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string; o?: string }> }) {
  const { token } = await params;
  const { lang, o } = await searchParams;
  const form = authEnabled() ? await routingFormByToken(getPool(process.env.DATABASE_URL as string), token) : null;
  const locale = resolveLocale(lang, form?.host.locale);
  if (!form) {
    return (
      <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
        <h1 className="font-display text-xl text-text">{rt(locale, "notFoundTitle")}</h1>
        <p className="mt-2 text-text-muted">{rt(locale, "notFoundBody")}</p>
      </main>
    );
  }
  const path = `/f/${token}`;
  const keepLang = isLocale(lang) ? lang : undefined;
  const chosen = form.options.find((opt) => String(opt.position) === o && opt.message !== null);
  const withLang = (href: string) => (keepLang ? `${href}?lang=${keepLang}` : href);

  return (
    <main lang={locale} className="mx-auto max-w-(--hh-booking-max) px-4 py-10">
      <LanguageSwitcher locale={locale} path={path} params={{ o: chosen ? o : undefined }} />
      <p className="text-sm font-semibold text-text-muted">{form.host.name}</p>
      <h1 className="font-display text-xl text-text">{form.title}</h1>

      {chosen ? (
        <section className="mt-6 max-w-xl" aria-live="polite">
          <p className="font-semibold text-text">{chosen.label}</p>
          <p className="mt-2 whitespace-pre-line text-text">{chosen.message}</p>
          <Link href={keepLang ? `${path}?lang=${keepLang}` : path} className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">
            {rt(locale, "back")}
          </Link>
        </section>
      ) : (
        <section className="mt-4 max-w-xl">
          <h2 className="whitespace-pre-line text-lg text-text">{form.question}</h2>
          {form.options.length === 0 ? (
            <p className="mt-3 text-text-muted">{rt(locale, "noOptions", { host: form.host.name })}</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-text-muted">{rt(locale, "intro", { host: form.host.name })}</p>
              <ul className="mt-4 grid gap-3">
                {form.options.map((opt) => (
                  <li key={opt.position}>
                    <Link
                      href={opt.href ? withLang(opt.href) : `${path}?${new URLSearchParams({ ...(keepLang ? { lang: keepLang } : {}), o: String(opt.position) })}`}
                      className={`w-full justify-start text-left ${buttonClasses({ variant: "secondary" })}`}
                    >
                      {opt.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </main>
  );
}
