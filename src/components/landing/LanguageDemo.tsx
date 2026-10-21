"use client";

import { useState } from "react";
import { LOCALES, LOCALE_NAMES, intlTag, t, type Locale } from "@/lib/i18n/guest";
import { ink } from "./ink";

// 23 Oct 2026 at four open times, India time. Formatted with each language's own Intl rules, Latin digits throughout.
// Node and the browser ship different ICU data (spacing before "am", for one), so the formatted text may differ by a character between server and client.
const times = ["2026-10-23T09:00:00+05:30", "2026-10-23T10:30:00+05:30", "2026-10-23T14:00:00+05:30", "2026-10-23T17:00:00+05:30"];

/** The guest's side of a booking page in each of the five languages a host can pick, using the real catalog strings. */
export function LanguageDemo() {
  const [locale, setLocale] = useState<Locale>("hi");
  const tag = intlTag(locale);
  const timeFmt = new Intl.DateTimeFormat(tag, { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  const dateFmt = new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" });

  return (
    <div className={`${ink.frame} p-2 sm:p-3`}>
      <div role="group" aria-label="Booking page language" className="flex flex-wrap gap-1 p-1">
        {LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            lang={l}
            aria-pressed={l === locale}
            onClick={() => setLocale(l)}
            className={`min-h-11 rounded-sm px-3 text-sm transition-colors duration-(--hh-motion-fast) ${ink.focus} ${
              l === locale ? `bg-[#120e0b] ${ink.text} shadow-[0_1px_0_rgb(244_236_225/0.08)_inset]` : `${ink.muted} hover:text-[#f4ece1]`
            }`}
          >
            {LOCALE_NAMES[l]}
          </button>
        ))}
      </div>
      <div className={`${ink.pane} mt-2 p-5 sm:p-6`} lang={locale} aria-live="polite">
        <p className={`text-lg font-semibold ${ink.text}`}>{t(locale, "pickTime")}</p>
        <p suppressHydrationWarning className={`mt-1 text-sm ${ink.muted}`}>{dateFmt.format(new Date(times[0]))}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {times.map((iso, i) => (
            <span
              key={iso}
              suppressHydrationWarning
              className={`rounded-sm border py-2.5 text-center text-sm tabular-nums ${i === 1 ? `border-transparent ${ink.accentBg} font-semibold` : `${ink.lineStrong} ${ink.text}`}`}
            >
              {timeFmt.format(new Date(iso))}
            </span>
          ))}
        </div>
        <p className={`mt-4 text-xs ${ink.muted}`}>{t(locale, "timesShownInYours", { zone: "IST" })}</p>
        <span className={`mt-5 flex h-11 items-center justify-center rounded-md text-sm font-semibold ${ink.accentBg}`}>{t(locale, "bookThisTime")}</span>
      </div>
    </div>
  );
}
