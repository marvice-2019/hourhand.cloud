import Link from "next/link";
import { connection } from "next/server";
import { MobileMenu, NavLinks } from "@/components/DashboardNav";
import { PwaInstall } from "@/components/PwaInstall";
import { SyncLight } from "@/components/SyncLight";
import { focusRing } from "@/components/ui/focus";
import { store } from "@/lib/data";
import { summarizeSync } from "@/lib/sync";
import { getHostContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/data/pg-store";
import { pendingInvite, seatOwner } from "@/lib/seats";
import { acceptSeatAction, leaveSeatAction, startActingAction, stopActingAction } from "./seat/actions";
import { authEnabled } from "@/lib/auth/auth";
import { isPhonePlaceholderEmail } from "@/lib/auth/phone";
import { signOut } from "@/lib/auth/actions";
import { Button } from "@/components/ui/Button";
import { HostI18nProvider } from "@/components/HostI18nProvider";
import { getHostI18n } from "@/lib/i18n/host/server";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await connection(); // render per request: the sync light shows minutes since the last check
  const ctx = await getHostContext();
  if (!ctx) redirect("/sign-in");
  const { host: user, actor, acting } = ctx;
  const { t, tNodes, locale } = await getHostI18n();
  const sync = summarizeSync(await store.listCalendarConnections(user.id), new Date());
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const [invite, owner] = db && !acting ? await Promise.all([pendingInvite(db, actor), seatOwner(db, actor.id)]) : [null, null];
  const brand = (
    <Link href="/dashboard/event-types" className={`inline-flex min-h-11 items-center rounded-sm font-display text-lg text-text ${focusRing}`}>
      Hourhand
    </Link>
  );
  return (
    <HostI18nProvider locale={locale}>
    <div lang={locale} className="min-h-dvh lg:flex">
      <a href="#main" className={`sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-20 focus:rounded-md focus:bg-card focus:p-3 ${focusRing}`}>
        {t("nav.skip")}
      </a>
      <aside className="hidden border-r border-border bg-surface p-4 lg:block lg:w-(--hh-sidebar) lg:shrink-0">
        {brand}
        <nav aria-label={t("nav.main")} className="mt-6">
          <NavLinks acting={acting} />
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="relative flex min-h-(--hh-header) items-center justify-between gap-3 border-b border-border px-4 lg:justify-end lg:px-8">
          <div className="flex items-center gap-2 lg:hidden">
            <MobileMenu acting={acting} />
            {brand}
          </div>
          <div className="flex items-center gap-2">
            {owner && (
              <form action={startActingAction}>
                <Button type="submit" variant="secondary" size="sm">{t("nav.manageOwner", { name: owner.name })}</Button>
              </form>
            )}
            {!acting && <SyncLight status={sync.status} minutesAgo={sync.minutesAgo} t={t} />}
            {authEnabled() && (
              <form action={signOut}>
                <Button type="submit" variant="ghost" size="sm">
                  {t("nav.signOut")}
                </Button>
              </form>
            )}
          </div>
        </header>
        <PwaInstall />
        {acting && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2 text-sm text-text lg:px-8">
            <span>{tNodes("nav.acting", { name: <span className="font-semibold">{user.name}</span> })}</span>
            <form action={stopActingAction}><Button type="submit" variant="secondary" size="sm">{t("nav.backToYours")}</Button></form>
          </div>
        )}
        {!acting && isPhonePlaceholderEmail(actor.email) && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2 text-sm text-text lg:px-8">
            <span>{t("nav.addEmail")}</span>
            <Link href="/dashboard/settings#add-email" className={`font-semibold text-accent underline ${focusRing}`}>{t("nav.addEmailLink")}</Link>
          </div>
        )}
        {invite && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2 text-sm text-text lg:px-8">
            <span>{tNodes("nav.invited", { name: <span className="font-semibold">{invite.ownerName}</span> })}</span>
            <span className="flex gap-2">
              <form action={acceptSeatAction}><Button type="submit" size="sm">{t("nav.accept")}</Button></form>
              <form action={leaveSeatAction}><Button type="submit" variant="ghost" size="sm">{t("nav.decline")}</Button></form>
            </span>
          </div>
        )}
        <main id="main" className="mx-auto max-w-(--hh-content-max) px-4 py-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
    </HostI18nProvider>
  );
}
