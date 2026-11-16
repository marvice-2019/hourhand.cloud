import Link from "next/link";
import { notFound } from "next/navigation";
import { saveClientNoteAction } from "../actions";
import { eraseClientAction } from "../privacy-actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { getHostContext, requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { listConsents, type ConsentChannel, type ConsentPurpose } from "@/lib/privacy/consent";
import { MAX_NOTE } from "@/lib/privacy/notes";
import { clientKey, summarizeClients } from "@/lib/clients";
import { clientMoney, latestAnswers } from "@/lib/client-file";
import { ClientFile } from "@/components/ClientFile";
import { store } from "@/lib/data";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { focusRing } from "@/components/ui/focus";

export const dynamic = "force-dynamic";

const DATA_ERRORS: Record<string, HostKey> = {
  confirm_mismatch: "clients.errConfirmMismatch",
  erase_upcoming: "clients.errEraseUpcoming",
  erase_payments_settling: "clients.errErasePaymentsSettling",
  erase_not_found: "clients.errEraseNotFound",
  erase_unavailable: "clients.errEraseUnavailable",
};
// The consent log's labels (PURPOSE_LABELS, CHANNEL_LABELS in src/lib/privacy/consent.ts), one host line each.
const PURPOSE_KEYS: Record<ConsentPurpose, HostKey> = {
  booking: "clients.purposeBooking", whatsapp_updates: "clients.purposeWhatsapp", sms_updates: "clients.purposeSms", host_question: "clients.purposeHostQuestion",
};
const CHANNEL_KEYS: Record<ConsentChannel, HostKey> = {
  booking_page: "clients.channelBookingPage", single_use_link: "clients.channelSingleUseLink", package_link: "clients.channelPackageLink",
};

export default async function ClientPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ saved?: string; error?: string }> }) {
  const user = await requireHost();
  const { t, tNodes, date, time } = await getHostI18n();
  const { key } = await params;
  const { saved, error } = await searchParams;
  const all = await store.listBookings(user.id);
  const client = summarizeClients(all, new Date()).find((c) => c.key === key);
  if (!client) notFound();
  const history = all.filter((b) => clientKey(b.invitee.email) === key && b.status !== "pending_payment").sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  // The note is decrypted for the account owner only, never for a Duo second person managing the account.
  const owner = !(await getHostContext())?.acting;
  const note = owner ? await store.getClientNote(user.id, client.email) : "";
  const consents = authEnabled() ? await listConsents(getPool(process.env.DATABASE_URL as string), user.id, client.email) : [];
  const money = authEnabled() ? await clientMoney(getPool(process.env.DATABASE_URL as string), user.id, client.email) : null;
  const tz = user.timezone;
  const dataError = error && Object.hasOwn(DATA_ERRORS, error) ? t(DATA_ERRORS[error]) : null;
  return (
    <div>
      <Link href="/dashboard/clients" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("clients.all")}</Link>
      <h1 className="font-display text-xl text-text">{client.name}</h1>
      <p className="mt-1 text-text-muted">{client.email}{client.phone && ` · ${client.phone}`}</p>
      <dl className="mt-4 flex flex-wrap gap-6">
        <div><dt className="text-sm text-text-muted">{t("clients.sessions")}</dt><dd className="text-lg font-semibold text-text">{client.sessions}</dd></div>
        <div><dt className="text-sm text-text-muted">{t("clients.comingUp")}</dt><dd className="text-lg font-semibold text-text">{client.upcoming}</dd></div>
        <div><dt className="text-sm text-text-muted">{t("clients.noShows")}</dt><dd className="text-lg font-semibold text-text">{client.noShows}</dd></div>
        <div><dt className="text-sm text-text-muted">{t("clients.since")}</dt><dd className="text-lg font-semibold text-text">{date(client.firstAt, tz)}</dd></div>
      </dl>

      <ClientFile answers={latestAnswers(history)} money={money} tz={tz} />

      {owner ? (
        <Card className="mt-6 max-w-xl">
          <form action={saveClientNoteAction} className="grid gap-3">
            <input type="hidden" name="key" value={key} />
            <label htmlFor="note" className="font-semibold text-text">{t("clients.privateNote")}</label>
            <p className="text-sm text-text-muted">{t("clients.noteHelp", { name: client.name })}</p>
            <textarea id="note" name="note" rows={6} maxLength={MAX_NOTE} defaultValue={note} placeholder={t("clients.notePlaceholder")}
              className={`block w-full rounded-md border border-border-input bg-card p-3 text-base text-text ${focusRing}`} />
            {saved && <p className="text-success" role="status">{t("clients.saved")}</p>}
            {error === "too_long" && <p className="text-danger" role="alert">{t("clients.noteTooLong")}</p>}
            <div><Button type="submit">{t("clients.saveNote")}</Button></div>
          </form>
        </Card>
      ) : (
        <p className="mt-6 max-w-xl text-sm text-text-muted">{t("clients.notesOwnerOnly")}</p>
      )}

      <section aria-labelledby="consent" className="mt-8 max-w-2xl">
        <h2 id="consent" className="font-semibold text-text">{t("clients.consentTitle")}</h2>
        <p className="mt-1 text-sm text-text-muted">{t("clients.consentIntro", { name: client.name })}</p>
        {consents.length === 0 ? <p className="mt-2 text-sm text-text-muted">{t("clients.consentEmpty")}</p> : (
          <ul className="mt-2 grid gap-2">
            {consents.map((c) => (
              <li key={c.id} className="rounded-md border border-border bg-card px-4 py-2 text-sm">
                <p className="text-text">
                  <span className="font-semibold">{t("clients.consentPurpose", { purpose: t(PURPOSE_KEYS[c.purpose]) })}</span>
                  <span className={c.granted ? "text-success" : "text-text-muted"}>{t(c.granted ? "clients.consentAgreed" : "clients.consentNotTicked")}</span>
                </p>
                <p className="mt-1 text-text">{t("clients.consentStatement", { statement: c.statement })}</p>
                <p className="mt-1 text-text-muted">
                  {tNodes("clients.consentMeta", {
                    date: date(c.recordedAt, tz), time: time(c.recordedAt, tz), channel: t(CHANNEL_KEYS[c.channel]), version: c.noticeVersion, locale: c.locale,
                    booking: <Link href={`/dashboard/bookings/${c.bookingId}`} className="text-accent underline">{t("clients.consentBooking")}</Link>,
                  })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {owner && (
        <section aria-labelledby="data" className="mt-8 max-w-xl">
          <h2 id="data" className="font-semibold text-text">{t("clients.dataTitle", { name: client.name })}</h2>
          <p className="mt-1 text-sm text-text-muted">{t("clients.dataIntro")}</p>
          {dataError && <p role="alert" className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">{dataError}</p>}
          <form action={`/dashboard/clients/${key}/export`} method="get" target="_blank" className="mt-3 grid gap-2">
            <p className="font-semibold text-text">{t("clients.exportTitle", { name: client.name })}</p>
            <p className="text-sm text-text-muted">{t("clients.exportHelp")}</p>
            <label className="flex items-start gap-2 text-sm text-text">
              <input type="checkbox" name="notes" value="1" className="mt-1 size-5 accent-accent" />
              <span>{t("clients.exportNotes", { name: client.name })}</span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" name="format" value="html" variant="secondary">{t("clients.exportReadable")}</Button>
              <Button type="submit" name="format" value="json" variant="secondary">{t("clients.exportJson")}</Button>
            </div>
          </form>
          <form id="erase" action={eraseClientAction} className="mt-6 grid gap-2 rounded-md border border-danger p-4">
            <input type="hidden" name="key" value={key} />
            <p className="font-semibold text-danger">{t("clients.eraseTitle", { name: client.name })}</p>
            <p className="text-sm text-text">{t("clients.eraseHelp")}</p>
            {client.upcoming > 0 && <p className="text-sm text-warning">{t(client.upcoming === 1 ? "clients.eraseOneUpcoming" : "clients.eraseUpcoming", { name: client.name, n: client.upcoming })}</p>}
            <label htmlFor="confirm" className="text-sm text-text">{tNodes("clients.eraseConfirm", { email: <span className="font-semibold">{client.email}</span> })}</label>
            <input id="confirm" name="confirm" type="text" autoComplete="off" required
              className={`h-11 rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`} />
            <div><Button type="submit" variant="danger">{t("clients.eraseButton")}</Button></div>
          </form>
        </section>
      )}

      <section aria-labelledby="history" className="mt-8">
        <h2 id="history" className="font-semibold text-text">{t("clients.history")}</h2>
        <ul className="mt-2 grid gap-2">
          {history.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-4">
              <Link href={`/dashboard/bookings/${b.id}`} className={`inline-flex min-h-11 items-center font-semibold text-accent underline ${b.status === "cancelled" ? "line-through" : ""}`}>
                {t("clients.dateTime", { date: date(b.startAt, tz), time: time(b.startAt, tz) })}
              </Link>
              {b.status === "cancelled" && <span className="text-sm text-text-muted">{t("clients.cancelled")}</span>}
              {b.invitee.noShowAt && <span className="rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning">{t("clients.noShow")}</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
