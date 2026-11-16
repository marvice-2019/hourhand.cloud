"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { focusRing } from "./ui/focus";
import { useHostI18n } from "./HostI18nProvider";
import type { HostKey } from "@/lib/i18n/host";

const items: { href: string; label: HostKey }[] = [
  { href: "/dashboard/bookings", label: "nav.bookings" },
  { href: "/dashboard/clients", label: "nav.clients" },
  { href: "/dashboard/feedback", label: "nav.feedback" },
  { href: "/dashboard/profile", label: "nav.profile" },
  { href: "/dashboard/event-types", label: "nav.eventTypes" },
  { href: "/dashboard/links", label: "nav.links" },
  { href: "/dashboard/polls", label: "nav.polls" },
  { href: "/dashboard/get-booked", label: "nav.getBooked" },
  { href: "/dashboard/packages", label: "nav.packages" },
  { href: "/dashboard/offers", label: "nav.offers" },
  { href: "/dashboard/memberships", label: "nav.memberships" },
  { href: "/dashboard/earnings", label: "nav.earnings" },
  { href: "/dashboard/invoices", label: "nav.invoices" },
  { href: "/dashboard/availability", label: "nav.availability" },
  { href: "/dashboard/calendars", label: "nav.calendars" },
  { href: "/dashboard/integrations", label: "nav.integrations" },
  { href: "/dashboard/domain", label: "nav.domain" },
  { href: "/dashboard/plan", label: "nav.plan" },
  { href: "/dashboard/referrals", label: "nav.referrals" },
  { href: "/dashboard/settings", label: "nav.settings" },
];

/** Pages a Duo second person can use while managing the owner's account; the rest stay the owner's alone. */
const SHARED = new Set(["/dashboard/bookings", "/dashboard/clients", "/dashboard/feedback", "/dashboard/profile", "/dashboard/event-types", "/dashboard/links", "/dashboard/polls", "/dashboard/get-booked", "/dashboard/packages", "/dashboard/availability"]);

export function NavLinks({ onNavigate, acting = false }: { onNavigate?: () => void; acting?: boolean }) {
  const pathname = usePathname();
  const { t } = useHostI18n();
  return (
    <ul className="flex flex-col gap-1">
      {items.filter((item) => !acting || SHARED.has(item.href)).map((item) => {
        const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={current ? "page" : undefined}
              className={`flex min-h-11 items-center rounded-md px-3 text-sm ${current ? "bg-surface font-semibold text-text" : "text-text-muted hover:bg-surface hover:text-text"} ${focusRing}`}
            >
              {t(item.label)}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Below 1024px the sidebar collapses into this menu in the top bar. */
export function MobileMenu({ acting = false }: { acting?: boolean }) {
  const [open, setOpen] = useState(false);
  const { t } = useHostI18n();
  return (
    <div className="lg:hidden" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold text-text hover:bg-surface ${focusRing}`}
      >
        {open ? t("nav.close") : t("nav.menu")}
      </button>
      {open && (
        <nav id="mobile-nav" aria-label={t("nav.main")} className="absolute inset-x-0 top-full z-10 border-b border-border bg-bg p-4 shadow-pop">
          <NavLinks acting={acting} onNavigate={() => setOpen(false)} />
        </nav>
      )}
    </div>
  );
}
