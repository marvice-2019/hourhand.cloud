"use client";

import { createContext, useContext, useMemo } from "react";
import { makeHostI18n, type HostI18n } from "@/lib/i18n/host/format";
import type { HostLocale } from "@/lib/i18n/host";

const HostLocaleContext = createContext<HostLocale>("en");

/** Set once by the dashboard layout from the host's saved language, so client components render it on the server too. */
export function HostI18nProvider({ locale, children }: { locale: HostLocale; children: React.ReactNode }) {
  return <HostLocaleContext.Provider value={locale}>{children}</HostLocaleContext.Provider>;
}

/** The host's words and formats in a client component. Outside the dashboard it falls back to English. */
export function useHostI18n(): HostI18n {
  const locale = useContext(HostLocaleContext);
  return useMemo(() => makeHostI18n(locale), [locale]);
}
