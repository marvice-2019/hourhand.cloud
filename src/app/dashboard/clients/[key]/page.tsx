import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { saveClientNoteAction, saveSessionNoteFromFile, setKeepVersionsAction } from "../actions";
import { eraseClientAction } from "../privacy-actions";
import { ClientFile } from "@/components/ClientFile";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { getHostContext } from "@/lib/auth/session";
import { clientMoney, latestAnswers, loadClientFile, quickActions, type BookingEntry, type InvoiceView, type PackageEntry, type PaymentView } from "@/lib/client-file";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { formatDate, formatTime } from "@/lib/format";
import { CHANNEL_LABELS, listConsents, PURPOSE_LABELS } from "@/lib/privacy/consent";
import type { NoteRevision } from "@/lib/privacy/note-history";
import { MAX_NOTE } from "@/lib/privacy/notes";

export const dynamic = "force-dynamic";

const SAVED: Record<string, string> = { "1": "Client note saved.", session: "Session note saved.", versions: "Saved." };
const ERRORS: Record<string, string> = {
  too_long: `Keep the note under ${MAX_NOTE} characters.`,
  session_too_long: `Keep the session note under ${MAX_NOTE} characters.`,
};
/** From export and erase (privacy-actions); shown in the data section. */
const DATA_ERRORS: Record<string, string> = {
  confirm_mismatch: "The email you typed doesn't match. Nothing was erased.",
  erase_upcoming: "This client has an upcoming booking or a payment hold. Cancel it first, then erase.",
  erase_payments_settling: "A payment or refund for this client is still going through. Try again once it settles.",
  erase_not_found: "There's nothing to erase for this client.",
  erase_unavailable: "Erasing needs the database; it isn't available in demo mode.",
};

/** Any three-letter currency: payments can be in the host's Stripe account currency as well as rupees. */
const money = (minor: number, currency: string) => {
  const major = minor / 100;
  return new Intl.NumberFormat(currency === "INR" ? "en-IN" : "en-US", { style: "currency", currency, minimumFractionDigits: Number.isInteger(major) ? 0 : 2, maximumFractionDigits: 2 }).format(major);
};
type Money = typeof money;

type Search = { saved?: string; error?: string; cursor?: string };

export default async function ClientFilePage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Search> }) {
  const ctx = await getHostContext();
  if (!ctx) redirect("/sign-in");
  const user = ctx.host;
  // Notes are the owner's alone: a Duo second person managing this account sees the timeline but never a note.
  const owner = !ctx.acting;
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
  // What they told you: the latest answer to each question, across every booking (not just this page of the timeline).
  const answers = latestAnswers(allBookings.filter((b) => b.invitee.email.trim().toLowerCase() === client.email.trim().toLowerCase()));
  const tz = user.timezone;
  const when = (d: Date) => `${formatDate(d, tz)}, ${formatTime(d, tz)}`;
  const dataError = error && Object.hasOwn(DATA_ERRORS, error) ? DATA_ERRORS[error] : null;

  return (
    <div>
      <Link href="/dashboard/clients" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">All clients</Link>
      <h1 className="font-display text-xl text-text">{client.name}</h1>
      <p className="mt-1 text-text-muted">
        <a href={`mailto:${client.email}`} className="underline">{client.email}</a>
        {client.phone && <> · <a href={`tel:${client.phone}`} className="underline">{client.phone}</a></>}
      </p>
      {saved && SAVED[saved] && <p className="mt-3 text-success" role="status">{SAVED[saved]}</p>}
      {error && ERRORS[error] && <p className="mt-3 text-danger" role="alert">{ERRORS[error]}</p>}

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:gap-6">
        <Stat label="Sessions" value={String(client.sessions)} />
        <Stat label="Coming up" value={String(client.upcoming)} />
        <Stat label="No-shows" value={String(client.noShows)} />
        <Stat label="First session" value={client.firstAt ? formatDate(client.firstAt, tz) : "None yet"} />
        <Stat label="Last session" value={client.lastAt ? formatDate(client.lastAt, tz) : "None yet"} />
        {client.nextAt && <Stat label="Next session" value={when(client.nextAt)} />}
        {paid && paid.totals.length > 0 && (
          <Stat label="Paid in total" value={paid.totals.map((t) => money(t.paidMinor - t.refundedMinor, t.currency)).join(" · ")} />
        )}
      </dl>

      <section aria-labelledby="quick" className="mt-6">
        <h2 id="quick" className="sr-only">Quick actions</h2>
        <div className="flex flex-wrap items-center gap-3">
          {actions.book[0] && (
            <Link href={actions.book[0].path} target="_blank" className={buttonClasses()}>
              Book for {client.name.split(/\s+/)[0]}
            </Link>
          )}
          {actions.mailto && <a href={actions.mailto} className={buttonClasses({ variant: "secondary" })}>Email a rebook link</a>}
          {actions.whatsapp && <a href={actions.whatsapp} target="_blank" rel="noreferrer" className={buttonClasses({ variant: "secondary" })}>WhatsApp a rebook link</a>}
          {/* Export and erase are the owner's alone (privacy-actions, export route); they live in the data section below. */}
          {owner && <a href="#data" className="text-sm font-semibold text-accent underline">Export or erase</a>}
        </div>
        {actions.book.length > 1 && (
          <p className="mt-2 text-sm text-text-muted">
            Or book: {actions.book.slice(1).map((b, i) => (
              <span key={b.path}>{i > 0 && " · "}<Link href={b.path} target="_blank" className="text-accent underline">{b.name}</Link></span>
            ))}
          </p>
        )}
        {actions.book.length === 0 && actions.rebookUrl && <p className="mt-2 text-sm text-text-muted">Your event types take payment, so send {client.name} the link and they book and pay themselves.</p>}
        {!actions.rebookUrl && <p className="text-sm text-text-muted">Turn on an event type to book for {client.name} or send them a link.</p>}
      </section>

      <ClientFile answers={answers} money={paid} tz={tz} />

      {notes ? (
        <Card className="mt-6 max-w-xl">
          <form action={saveClientNoteAction} className="grid gap-3">
            <input type="hidden" name="key" value={key} />
            <label htmlFor="note" className="font-semibold text-text">Private note</label>
            <p className="text-sm text-text-muted">Only you see this: it is encrypted when stored and a second person on your Duo plan can&apos;t read it. It shows on each of {client.name}&apos;s bookings.</p>
            <textarea id="note" name="note" rows={6} maxLength={MAX_NOTE} defaultValue={notes.client} placeholder="What you're working on together, preferences, what you agreed."
              className={`block w-full rounded-md border border-border-input bg-card p-3 text-base text-text ${focusRing}`} />
            <div><Button type="submit">Save note</Button></div>
          </form>
          <History revisions={notes.clientHistory} when={when} />
          <form action={setKeepVersionsAction} className="mt-4 border-t border-border pt-3 text-sm">
            <input type="hidden" name="key" value={key} />
            <input type="hidden" name="keep" value={notes.keepVersions ? "0" : "1"} />
            <p className="text-text-muted">
              {notes.keepVersions
                ? "Earlier versions of your notes are kept (encrypted) so you can read back what you wrote."
                : "Only who changed a note and when is kept, not the earlier text."}
            </p>
            <Button type="submit" variant="secondary" size="sm" className="mt-2">
              {notes.keepVersions ? "Stop keeping versions (deletes the ones kept)" : "Keep earlier versions"}
            </Button>
          </form>
        </Card>
      ) : (
        <p className="mt-6 max-w-xl text-sm text-text-muted">Notes about this client are private to the account owner.</p>
      )}

      <section aria-labelledby="timeline" className="mt-8">
        <h2 id="timeline" className="font-semibold text-text">Timeline</h2>
        <p className="mt-1 text-sm text-text-muted">Bookings, answers, payments, packages and invoices, newest first.</p>
        {entries.length === 0 ? <p className="mt-2 text-text-muted">Nothing here yet.</p> : (
          <ol className="mt-3 grid gap-3">
            {entries.map((e) => e.kind === "booking"
              ? <BookingItem key={e.id} e={e} now={now} when={when} money={money} owner={owner} fileKey={key}
                  note={notes?.sessions[e.id] ?? ""} history={notes?.sessionHistory[e.id] ?? []} />
              : <PackageItem key={e.id} e={e} when={when} money={money} />)}
          </ol>
        )}
        <nav aria-label="Timeline pages" className="mt-4 flex gap-4">
          {cursor && <Link href={`/dashboard/clients/${key}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">Newest</Link>}
          {nextCursor && <Link href={`/dashboard/clients/${key}?cursor=${nextCursor}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">Older</Link>}
        </nav>
      </section>

      <section aria-labelledby="consent" className="mt-8 max-w-2xl">
        <h2 id="consent" className="font-semibold text-text">Consent log</h2>
        <p className="mt-1 text-sm text-text-muted">What {client.name} agreed to each time they booked, in the words they saw. Kept as your record under India&apos;s data protection law.</p>
        {consents.length === 0 ? <p className="mt-2 text-sm text-text-muted">Nothing recorded yet. Bookings made from now on are logged here.</p> : (
          <ul className="mt-2 grid gap-2">
            {consents.map((c) => (
              <li key={c.id} className="rounded-md border border-border bg-card px-4 py-2 text-sm">
                <p className="text-text">
                  <span className="font-semibold">{PURPOSE_LABELS[c.purpose]}: </span>
                  <span className={c.granted ? "text-success" : "text-text-muted"}>{c.granted ? "agreed" : "not ticked"}</span>
                </p>
                <p className="mt-1 text-text">&ldquo;{c.statement}&rdquo;</p>
                <p className="mt-1 text-text-muted">
                  {when(c.recordedAt)} · {CHANNEL_LABELS[c.channel]} · notice {c.noticeVersion} · {c.locale} ·{" "}
                  <Link href={`/dashboard/bookings/${c.bookingId}`} className="text-accent underline">booking</Link>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {owner && (
        <section aria-labelledby="data-heading" id="data" className="mt-8 max-w-xl">
          <h2 id="data-heading" className="font-semibold text-text">{client.name}&apos;s data</h2>
          <p className="mt-1 text-sm text-text-muted">
            You decide what happens to your clients&apos; data; Hourhand keeps it for you. Use these when a client asks for a copy or to be deleted.
            Only you can use them, not a second person on your plan.
          </p>
          {dataError && <p role="alert" className="mt-3 rounded-md bg-danger-bg p-3 text-sm text-danger">{dataError}</p>}
          <form action={`/dashboard/clients/${key}/export`} method="get" target="_blank" className="mt-3 grid gap-2">
            <p className="font-semibold text-text">Export everything about {client.name}</p>
            <p className="text-sm text-text-muted">Bookings, answers, payments, packages, invoices, consent log and requests. Print the readable copy to PDF from your browser.</p>
            <label className="flex items-start gap-2 text-sm text-text">
              <input type="checkbox" name="notes" value="1" className="mt-1 size-5 accent-accent" />
              <span>Include my private notes (leave this off if you&apos;re sending the export to {client.name})</span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" name="format" value="html" variant="secondary">Readable copy</Button>
              <Button type="submit" name="format" value="json" variant="secondary">JSON file</Button>
            </div>
          </form>
          <form id="erase" action={eraseClientAction} className="mt-6 grid gap-2 rounded-md border border-danger p-4">
            <input type="hidden" name="key" value={key} />
            <p className="font-semibold text-danger">Erase {client.name}</p>
            <p className="text-sm text-text">
              This can&apos;t be undone. Their name, email, phone, answers, notes (with their edit history) and messages come out of Hourhand. Past
              bookings stay in your history as &ldquo;Erased client&rdquo;, and GST invoices keep what tax law requires (amounts, numbers, dates; the name
              only on invoices of ₹50,000 or more). Hourhand logs that you erased a client and when, not who. Events already in your own calendar
              aren&apos;t touched: delete those yourself.
            </p>
            {client.upcoming > 0 && <p className="text-sm text-warning">{client.name} has {client.upcoming} upcoming {client.upcoming === 1 ? "booking" : "bookings"}. Cancel {client.upcoming === 1 ? "it" : "them"} first.</p>}
            <label htmlFor="confirm" className="text-sm text-text">Type <span className="font-semibold">{client.email}</span> to confirm</label>
            <input id="confirm" name="confirm" type="text" autoComplete="off" required
              className={`h-11 rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`} />
            <div><Button type="submit" variant="danger">Erase for good</Button></div>
          </form>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-sm text-text-muted">{label}</dt><dd className="text-lg font-semibold text-text">{value}</dd></div>;
}

function bookingStatus(e: BookingEntry, now: Date): string {
  if (e.status === "cancelled") return e.cancelReason === "Rescheduled" ? "Moved" : e.cancelledBy === "guest" ? "Cancelled by client" : "Cancelled by you";
  if (e.noShowAt) return "No-show";
  return e.startAt > now ? "Upcoming" : "Done";
}

const PAYMENT_WORDS: Record<string, string> = {
  pending: "awaiting payment", paid: "paid", failed: "not completed", refund_pending: "refund on its way", refunded: "refunded",
};

function PaymentLine({ p, when, money }: { p: PaymentView; when: (d: Date) => string; money: Money }) {
  const what = p.kind === "deposit" ? "Deposit" : "Payment";
  return (
    <li>
      {what} {money(p.amountMinor, p.currency)}: {PAYMENT_WORDS[p.status] ?? p.status}{p.paidAt && `, ${when(p.paidAt)}`}
      {p.refundedMinor > 0 && <> · refunded {money(p.refundedMinor, p.currency)}{p.refundedAt && `, ${when(p.refundedAt)}`}</>}
    </li>
  );
}

function Invoices({ list, money }: { list: InvoiceView[]; money: Money }) {
  if (list.length === 0) return null;
  return (
    <li>
      {list.map((v, i) => (
        <span key={v.id}>{i > 0 && " · "}{v.kind === "credit_note" ? "Credit note" : "Invoice"}{" "}
          <Link href={`/invoice/${v.token}`} className="text-accent underline">{v.number}</Link> ({money(v.totalMinor, "INR")})</span>
      ))}
    </li>
  );
}

function BookingItem({ e, now, when, money, owner, fileKey, note, history }: {
  e: BookingEntry; now: Date; when: (d: Date) => string; money: Money; owner: boolean; fileKey: string; note: string; history: NoteRevision[];
}) {
  const status = bookingStatus(e, now);
  return (
    <li id={`b-${e.id}`} className="rounded-md border border-border bg-card px-4 py-3">
      <p className="flex flex-wrap items-center gap-x-3">
        <Link href={`/dashboard/bookings/${e.id}`} className={`font-semibold text-accent underline ${e.status === "cancelled" ? "line-through" : ""}`}>{when(e.startAt)}</Link>
        <span className="text-text">{e.eventName}</span>
        <span className={status === "No-show" ? "rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning" : "text-sm text-text-muted"}>{status}</span>
        {e.packagePurchaseId && <span className="text-sm text-text-muted">from a package</span>}
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
          {e.payments.map((p) => <PaymentLine key={p.id} p={p} when={when} money={money} />)}
          <Invoices list={e.invoices} money={money} />
        </ul>
      )}
      {owner && (
        <details className="mt-2" open={note !== ""}>
          <summary className="cursor-pointer text-sm font-semibold text-text">Session note{note === "" ? " (none yet)" : ""}</summary>
          <form action={saveSessionNoteFromFile} className="mt-2 grid gap-2">
            <input type="hidden" name="key" value={fileKey} />
            <input type="hidden" name="bookingId" value={e.id} />
            <label htmlFor={`sn-${e.id}`} className="sr-only">Session note for {when(e.startAt)}</label>
            <textarea id={`sn-${e.id}`} name="note" rows={3} maxLength={MAX_NOTE} defaultValue={note}
              className={`block w-full rounded-md border border-border-input bg-card p-2 text-base text-text ${focusRing}`} />
            <div><Button type="submit" variant="secondary" size="sm">Save session note</Button></div>
          </form>
          <History revisions={history} when={when} />
        </details>
      )}
    </li>
  );
}

function PackageItem({ e, when, money }: { e: PackageEntry; when: (d: Date) => string; money: Money }) {
  return (
    <li className="rounded-md border border-border bg-card px-4 py-3">
      <p className="flex flex-wrap items-center gap-x-3">
        <span className="font-semibold text-text">{when(e.at)}</span>
        <span className="text-text">Package: {e.name}</span>
        <span className="text-sm text-text-muted">{e.status === "paid" ? `paid ${money(e.priceMinor, e.currency)}` : "awaiting payment"}</span>
      </p>
      {e.status === "paid" && (
        <p className="mt-1 text-sm text-text">
          {e.used} of {e.sessions} booked · {e.remaining} left
          {e.expiresAt && ` · ${e.expiresAt > new Date() ? "use by" : "expired"} ${when(e.expiresAt)}`}
        </p>
      )}
      {e.invoices.length > 0 && <ul className="mt-1 text-sm text-text"><Invoices list={e.invoices} money={money} /></ul>}
    </li>
  );
}

/** Who changed a note and when; the text of a version only if the owner keeps versions. */
function History({ revisions, when }: { revisions: NoteRevision[]; when: (d: Date) => string }) {
  if (revisions.length === 0) return null;
  const latest = revisions[0];
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-text-muted">
        {revisions.length === 1 ? "1 change" : `${revisions.length} changes`} · last {when(latest.at)}{latest.actorName ? ` by ${latest.actorName}` : ""}
      </summary>
      <ol className="mt-2 grid gap-2">
        {revisions.map((r) => (
          <li key={r.id} className="border-l-2 border-border pl-3">
            <p className="text-text-muted">{r.action === "cleared" ? "Cleared" : "Saved"} · {when(r.at)}{r.actorName ? ` · ${r.actorName}` : ""}</p>
            {r.text !== null && <p className="mt-1 whitespace-pre-wrap text-text">{r.text}</p>}
          </li>
        ))}
      </ol>
    </details>
  );
}
