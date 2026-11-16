import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { saveClientNoteAction, saveSessionNoteFromFile, setKeepVersionsAction } from "../actions";
import { eraseClientAction } from "../privacy-actions";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { ClientFile } from "@/components/ClientFile";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { getHostContext } from "@/lib/auth/session";
import { clientMoney, latestAnswers, loadClientFile, quickActions, type BookingEntry, type InvoiceView, type PackageEntry, type PaymentView } from "@/lib/client-file";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import type { HostI18n } from "@/lib/i18n/host/format";
import { getHostI18n } from "@/lib/i18n/host/server";
import { listConsents, type ConsentChannel, type ConsentPurpose } from "@/lib/privacy/consent";
import type { NoteRevision } from "@/lib/privacy/note-history";
import { MAX_NOTE } from "@/lib/privacy/notes";

export const dynamic = "force-dynamic";

const SAVED: Record<string, HostKey> = { "1": "clients.saved", session: "clients.savedSession", versions: "clients.saved" };
const ERRORS: Record<string, HostKey> = { too_long: "clients.noteTooLong", session_too_long: "clients.sessionNoteTooLong" };
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
const PAYMENT_WORDS: Record<string, HostKey> = {
  pending: "clients.payPending", paid: "clients.payPaid", failed: "clients.payFailed", refund_pending: "clients.payRefundPending", refunded: "clients.payRefunded",
};

type Search = { saved?: string; error?: string; cursor?: string };

/**
 * The client file: everything about one client before a session. Notes are the owner's alone: for a Duo second person
 * managing this account, loadClientFile never reads or decrypts a note, and the note, export and erase forms aren't shown.
 */
export default async function ClientFilePage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Search> }) {
  const ctx = await getHostContext();
  if (!ctx) redirect("/sign-in");
  const user = ctx.host;
  const owner = !ctx.acting;
  const i18n = await getHostI18n();
  const { t, tNodes, date, time, money } = i18n;
  const { key } = await params;
  const { saved, error, cursor } = await searchParams;
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const now = new Date();
  const file = await loadClientFile(db, store, user.id, key, { owner }, { now, cursor });
  if (!file) notFound();
  const { header: client, entries, nextCursor, notes } = file;
  const [consents, eventTypes, paid, allBookings] = await Promise.all([
    db ? listConsents(db, user.id, client.email) : [],
    store.listEventTypes(user.id),
    db ? clientMoney(db, user.id, client.email) : null,
    store.listBookings(user.id),
  ]);
  const actions = quickActions({
    baseUrl: resolveBaseUrl() ?? "http://localhost:3000", host: { slug: user.slug, name: user.name ?? "" }, client,
    eventTypes: eventTypes.filter((e) => e.active && e.kind !== "one_off").map((e) => ({ ...e, paid: e.priceMinor !== null || e.depositMinor !== null })),
  });
  // What they told you: the latest answer to each question across every booking, not only this page of the timeline.
  const email = client.email.trim().toLowerCase();
  const answers = latestAnswers(allBookings.filter((b) => b.invitee.email.trim().toLowerCase() === email && b.status !== "pending_payment"));
  const tz = user.timezone;
  const when = (d: Date) => t("clients.dateTime", { date: date(d, tz), time: time(d, tz) });
  const dataError = error && Object.hasOwn(DATA_ERRORS, error) ? t(DATA_ERRORS[error]) : null;
  const firstName = client.name.split(/\s+/)[0] || client.name;

  return (
    <div>
      <Link href="/dashboard/clients" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("clients.all")}</Link>
      <h1 className="font-display text-xl text-text">{client.name}</h1>
      <p className="mt-1 text-text-muted">
        <a href={`mailto:${client.email}`} className="underline">{client.email}</a>
        {client.phone && <> · <a href={`tel:${client.phone}`} className="underline">{client.phone}</a></>}
      </p>
      {saved && Object.hasOwn(SAVED, saved) && <p className="mt-3 text-success" role="status">{t(SAVED[saved])}</p>}
      {error && Object.hasOwn(ERRORS, error) && <p className="mt-3 text-danger" role="alert">{t(ERRORS[error])}</p>}

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:gap-6">
        <Stat label={t("clients.sessions")} value={String(client.sessions)} />
        <Stat label={t("clients.comingUp")} value={String(client.upcoming)} />
        <Stat label={t("clients.noShows")} value={String(client.noShows)} />
        <Stat label={t("clients.firstSession")} value={client.firstAt ? date(client.firstAt, tz) : t("clients.noneYet")} />
        <Stat label={t("clients.lastSession")} value={client.lastAt ? date(client.lastAt, tz) : t("clients.noneYet")} />
        {client.nextAt && <Stat label={t("clients.nextSession")} value={when(client.nextAt)} />}
        {paid && paid.totals.length > 0 && (
          <Stat label={t("clients.paidTotal")} value={paid.totals.map((x) => money(x.paidMinor - x.refundedMinor, x.currency)).join(" · ")} />
        )}
      </dl>

      <section aria-labelledby="quick" className="mt-6">
        <h2 id="quick" className="sr-only">{t("clients.quickActions")}</h2>
        <div className="flex flex-wrap items-center gap-3">
          {actions.book[0] && (
            <Link href={actions.book[0].path} target="_blank" className={buttonClasses()}>{t("clients.bookFor", { name: firstName })}</Link>
          )}
          {actions.mailto && <a href={actions.mailto} className={buttonClasses({ variant: "secondary" })}>{t("clients.emailRebook")}</a>}
          {actions.whatsapp && <a href={actions.whatsapp} target="_blank" rel="noreferrer" className={buttonClasses({ variant: "secondary" })}>{t("clients.whatsappRebook")}</a>}
          {/* Export and erase are the owner's alone (privacy-actions, export route); they live in the data section below. */}
          {owner && <a href="#data" className="text-sm font-semibold text-accent underline">{t("clients.exportOrErase")}</a>}
        </div>
        {actions.book.length > 1 && (
          <p className="mt-2 text-sm text-text-muted">
            {tNodes("clients.orBook", {
              links: actions.book.slice(1).map((b, i) => (
                <span key={b.path}>{i > 0 && " · "}<Link href={b.path} target="_blank" className="text-accent underline">{b.name}</Link></span>
              )),
            })}
          </p>
        )}
        {actions.book.length === 0 && actions.rebookUrl && <p className="mt-2 text-sm text-text-muted">{t("clients.paidSendLink", { name: client.name })}</p>}
        {!actions.rebookUrl && <p className="text-sm text-text-muted">{t("clients.noEventTypes", { name: client.name })}</p>}
      </section>

      <ClientFile answers={answers} money={paid} tz={tz} />

      {notes ? (
        <Card className="mt-6 max-w-xl">
          <form action={saveClientNoteAction} className="grid gap-3">
            <input type="hidden" name="key" value={key} />
            <label htmlFor="note" className="font-semibold text-text">{t("clients.privateNote")}</label>
            <p className="text-sm text-text-muted">{t("clients.noteHelp", { name: client.name })}</p>
            <textarea id="note" name="note" rows={6} maxLength={MAX_NOTE} defaultValue={notes.client} placeholder={t("clients.notePlaceholder")}
              className={`block w-full rounded-md border border-border-input bg-card p-3 text-base text-text ${focusRing}`} />
            <div><Button type="submit">{t("clients.saveNote")}</Button></div>
          </form>
          <History revisions={notes.clientHistory} when={when} i18n={i18n} />
          <form action={setKeepVersionsAction} className="mt-4 border-t border-border pt-3 text-sm">
            <input type="hidden" name="key" value={key} />
            <input type="hidden" name="keep" value={notes.keepVersions ? "0" : "1"} />
            <p className="text-text-muted">{t(notes.keepVersions ? "clients.versionsOn" : "clients.versionsOff")}</p>
            <Button type="submit" variant="secondary" size="sm" className="mt-2">{t(notes.keepVersions ? "clients.versionsStop" : "clients.versionsStart")}</Button>
          </form>
        </Card>
      ) : (
        <p className="mt-6 max-w-xl text-sm text-text-muted">{t("clients.notesOwnerOnly")}</p>
      )}

      <section aria-labelledby="timeline" className="mt-8">
        <h2 id="timeline" className="font-semibold text-text">{t("clients.timelineTitle")}</h2>
        <p className="mt-1 text-sm text-text-muted">{t("clients.timelineIntro")}</p>
        {entries.length === 0 ? <p className="mt-2 text-text-muted">{t("clients.timelineEmpty")}</p> : (
          <ol className="mt-3 grid gap-3">
            {entries.map((e) => e.kind === "booking"
              ? <BookingItem key={e.id} e={e} now={now} when={when} i18n={i18n} owner={owner} fileKey={key}
                  note={notes?.sessions[e.id] ?? ""} history={notes?.sessionHistory[e.id] ?? []} />
              : <PackageItem key={e.id} e={e} now={now} when={when} i18n={i18n} />)}
          </ol>
        )}
        <nav aria-label={t("clients.timelinePages")} className="mt-4 flex gap-4">
          {cursor && <Link href={`/dashboard/clients/${key}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("clients.newest")}</Link>}
          {nextCursor && <Link href={`/dashboard/clients/${key}?cursor=${nextCursor}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("clients.older")}</Link>}
        </nav>
      </section>

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
        <section aria-labelledby="data-heading" id="data" className="mt-8 max-w-xl">
          <h2 id="data-heading" className="font-semibold text-text">{t("clients.dataTitle", { name: client.name })}</h2>
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
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-sm text-text-muted">{label}</dt><dd className="text-lg font-semibold text-text">{value}</dd></div>;
}

function statusKey(e: BookingEntry, now: Date): HostKey {
  if (e.status === "cancelled") return e.cancelReason === "Rescheduled" ? "clients.statusMoved" : e.cancelledBy === "guest" ? "clients.cancelledByClient" : "clients.cancelledByYou";
  if (e.noShowAt) return "clients.noShow";
  return e.startAt > now ? "clients.statusUpcoming" : "clients.statusDone";
}

function PaymentLine({ p, when, i18n }: { p: PaymentView; when: (d: Date) => string; i18n: HostI18n }) {
  const { t, money } = i18n;
  const status = t(PAYMENT_WORDS[p.status] ?? "clients.payPending");
  return (
    <li>
      {t("clients.paymentLine", { kind: t(p.kind === "deposit" ? "clients.kindDeposit" : "clients.kindSession"), amount: money(p.amountMinor, p.currency), status: p.paidAt ? t("clients.paidOn", { status, when: when(p.paidAt) }) : status })}
      {p.refundedMinor > 0 && <> · {t("clients.refundedLine", { amount: money(p.refundedMinor, p.currency) })}{p.refundedAt && `, ${when(p.refundedAt)}`}</>}
    </li>
  );
}

function Invoices({ list, i18n }: { list: InvoiceView[]; i18n: HostI18n }) {
  const { t, money } = i18n;
  if (list.length === 0) return null;
  return (
    <li>
      {list.map((v, i) => (
        <span key={v.id}>{i > 0 && " · "}{t(v.kind === "credit_note" ? "clients.creditNote" : "clients.invoice")}{" "}
          <Link href={`/invoice/${v.token}`} className="text-accent underline">{v.number}</Link> ({money(v.totalMinor, "INR")})</span>
      ))}
    </li>
  );
}

function BookingItem({ e, now, when, i18n, owner, fileKey, note, history }: {
  e: BookingEntry; now: Date; when: (d: Date) => string; i18n: HostI18n; owner: boolean; fileKey: string; note: string; history: NoteRevision[];
}) {
  const { t } = i18n;
  const status = statusKey(e, now);
  return (
    <li id={`b-${e.id}`} className="rounded-md border border-border bg-card px-4 py-3">
      <p className="flex flex-wrap items-center gap-x-3">
        <Link href={`/dashboard/bookings/${e.id}`} className={`font-semibold text-accent underline ${e.status === "cancelled" ? "line-through" : ""}`}>{when(e.startAt)}</Link>
        <span className="text-text">{e.eventName}</span>
        <span className={status === "clients.noShow" ? "rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning" : "text-sm text-text-muted"}>{t(status)}</span>
        {e.packagePurchaseId && <span className="text-sm text-text-muted">{t("clients.fromPackage")}</span>}
      </p>
      {e.answers.length > 0 && (
        <dl className="mt-2 grid gap-1 text-sm">
          {e.answers.map((a, i) => (
            <div key={i}><dt className="text-text-muted">{a.label}</dt><dd className="whitespace-pre-wrap text-text">{a.answer}</dd></div>
          ))}
        </dl>
      )}
      {(e.payments.length > 0 || e.invoices.length > 0) && (
        <ul className="mt-2 grid gap-1 text-sm text-text">
          {e.payments.map((p) => <PaymentLine key={p.id} p={p} when={when} i18n={i18n} />)}
          <Invoices list={e.invoices} i18n={i18n} />
        </ul>
      )}
      {owner && (
        <details className="mt-2" open={note !== ""}>
          <summary className="cursor-pointer text-sm font-semibold text-text">{t(note === "" ? "clients.sessionNoteNone" : "clients.sessionNote")}</summary>
          <form action={saveSessionNoteFromFile} className="mt-2 grid gap-2">
            <input type="hidden" name="key" value={fileKey} />
            <input type="hidden" name="bookingId" value={e.id} />
            <label htmlFor={`sn-${e.id}`} className="sr-only">{t("clients.sessionNoteFor", { when: when(e.startAt) })}</label>
            <textarea id={`sn-${e.id}`} name="note" rows={3} maxLength={MAX_NOTE} defaultValue={note}
              className={`block w-full rounded-md border border-border-input bg-card p-2 text-base text-text ${focusRing}`} />
            <div><Button type="submit" variant="secondary" size="sm">{t("clients.saveSessionNote")}</Button></div>
          </form>
          <History revisions={history} when={when} i18n={i18n} />
        </details>
      )}
    </li>
  );
}

function PackageItem({ e, now, when, i18n }: { e: PackageEntry; now: Date; when: (d: Date) => string; i18n: HostI18n }) {
  const { t, money } = i18n;
  return (
    <li className="rounded-md border border-border bg-card px-4 py-3">
      <p className="flex flex-wrap items-center gap-x-3">
        <span className="font-semibold text-text">{when(e.at)}</span>
        <span className="text-text">{t("clients.packageLine", { name: e.name })}</span>
        <span className="text-sm text-text-muted">{e.status === "paid" ? t("clients.packagePaid", { amount: money(e.priceMinor, e.currency) }) : t("clients.payPending")}</span>
      </p>
      {e.status === "paid" && (
        <p className="mt-1 text-sm text-text">
          {t("clients.packageUse", { used: e.used, n: e.sessions, left: e.remaining })}
          {e.expiresAt && ` · ${t(e.expiresAt > now ? "clients.useBy" : "clients.expiredOn", { when: when(e.expiresAt) })}`}
        </p>
      )}
      {e.invoices.length > 0 && <ul className="mt-1 text-sm text-text"><Invoices list={e.invoices} i18n={i18n} /></ul>}
    </li>
  );
}

/** Who changed a note and when; the text of a version only if the owner keeps versions. */
function History({ revisions, when, i18n }: { revisions: NoteRevision[]; when: (d: Date) => string; i18n: HostI18n }) {
  const { t } = i18n;
  if (revisions.length === 0) return null;
  const latest = revisions[0];
  const by = (name: string | null): ReactNode => (name ? <> · {t("clients.byName", { name })}</> : null);
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-text-muted">
        {revisions.length === 1 ? t("clients.changesOne", { when: when(latest.at) }) : t("clients.changesMany", { n: revisions.length, when: when(latest.at) })}{by(latest.actorName)}
      </summary>
      <ol className="mt-2 grid gap-2">
        {revisions.map((r) => (
          <li key={r.id} className="border-l-2 border-border pl-3">
            <p className="text-text-muted">{t(r.action === "cleared" ? "clients.revCleared" : "clients.revSaved")} · {when(r.at)}{by(r.actorName)}</p>
            {r.text !== null && <p className="mt-1 whitespace-pre-wrap text-text">{r.text}</p>}
          </li>
        ))}
      </ol>
    </details>
  );
}
