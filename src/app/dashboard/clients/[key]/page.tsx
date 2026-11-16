import Link from "next/link";
import { notFound } from "next/navigation";
import { saveClientNoteAction } from "../actions";
import { eraseClientAction } from "../privacy-actions";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { getHostContext, requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { CHANNEL_LABELS, listConsents, PURPOSE_LABELS } from "@/lib/privacy/consent";
import { MAX_NOTE } from "@/lib/privacy/notes";
import { clientKey, summarizeClients } from "@/lib/clients";
import { clientMoney, latestAnswers } from "@/lib/client-file";
import { ClientFile } from "@/components/ClientFile";
import { store } from "@/lib/data";
import { formatDate, formatTime } from "@/lib/format";
import { focusRing } from "@/components/ui/focus";

export const dynamic = "force-dynamic";

const DATA_ERRORS: Record<string, string> = {
  confirm_mismatch: "The email you typed doesn't match. Nothing was erased.",
  erase_upcoming: "This client has an upcoming booking or a payment hold. Cancel it first, then erase.",
  erase_payments_settling: "A payment or refund for this client is still going through. Try again once it settles.",
  erase_not_found: "There's nothing to erase for this client.",
  erase_unavailable: "Erasing needs the database; it isn't available in demo mode.",
};

export default async function ClientPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ saved?: string; error?: string }> }) {
  const user = await requireHost();
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
  const dataError = error && Object.hasOwn(DATA_ERRORS, error) ? DATA_ERRORS[error] : null;
  return (
    <div>
      <Link href="/dashboard/clients" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">All clients</Link>
      <h1 className="font-display text-xl text-text">{client.name}</h1>
      <p className="mt-1 text-text-muted">{client.email}{client.phone && ` · ${client.phone}`}</p>
      <dl className="mt-4 flex flex-wrap gap-6">
        <div><dt className="text-sm text-text-muted">Sessions</dt><dd className="text-lg font-semibold text-text">{client.sessions}</dd></div>
        <div><dt className="text-sm text-text-muted">Coming up</dt><dd className="text-lg font-semibold text-text">{client.upcoming}</dd></div>
        <div><dt className="text-sm text-text-muted">No-shows</dt><dd className="text-lg font-semibold text-text">{client.noShows}</dd></div>
        <div><dt className="text-sm text-text-muted">Client since</dt><dd className="text-lg font-semibold text-text">{formatDate(client.firstAt, tz)}</dd></div>
      </dl>

      <ClientFile answers={latestAnswers(history)} money={money} tz={tz} />

      {owner ? (
        <Card className="mt-6 max-w-xl">
          <form action={saveClientNoteAction} className="grid gap-3">
            <input type="hidden" name="key" value={key} />
            <label htmlFor="note" className="font-semibold text-text">Private note</label>
            <p className="text-sm text-text-muted">Only you see this: it is encrypted when stored and a second person on your Duo plan can&apos;t read it. It shows on each of {client.name}&apos;s bookings.</p>
            <textarea id="note" name="note" rows={6} maxLength={MAX_NOTE} defaultValue={note} placeholder="What you're working on together, preferences, what you agreed."
              className={`block w-full rounded-md border border-border-input bg-card p-3 text-base text-text ${focusRing}`} />
            {saved && <p className="text-success" role="status">Saved.</p>}
            {error === "too_long" && <p className="text-danger" role="alert">Keep the note under 5000 characters.</p>}
            <div><Button type="submit">Save note</Button></div>
          </form>
        </Card>
      ) : (
        <p className="mt-6 max-w-xl text-sm text-text-muted">Notes about this client are private to the account owner.</p>
      )}

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
                  {formatDate(c.recordedAt, tz)}, {formatTime(c.recordedAt, tz)} · {CHANNEL_LABELS[c.channel]} · notice {c.noticeVersion} · {c.locale} ·{" "}
                  <Link href={`/dashboard/bookings/${c.bookingId}`} className="text-accent underline">booking</Link>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {owner && (
        <section aria-labelledby="data" className="mt-8 max-w-xl">
          <h2 id="data" className="font-semibold text-text">{client.name}&apos;s data</h2>
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
              This can&apos;t be undone. Their name, email, phone, answers, notes and messages come out of Hourhand. Past bookings stay in your history as
              &ldquo;Erased client&rdquo;, and GST invoices keep what tax law requires (amounts, numbers, dates; the name only on invoices of ₹50,000 or more).
              Hourhand logs that you erased a client and when, not who. Events already in your own calendar aren&apos;t touched: delete those yourself.
            </p>
            {client.upcoming > 0 && <p className="text-sm text-warning">{client.name} has {client.upcoming} upcoming {client.upcoming === 1 ? "booking" : "bookings"}. Cancel {client.upcoming === 1 ? "it" : "them"} first.</p>}
            <label htmlFor="confirm" className="text-sm text-text">Type <span className="font-semibold">{client.email}</span> to confirm</label>
            <input id="confirm" name="confirm" type="text" autoComplete="off" required
              className={`h-11 rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`} />
            <div><Button type="submit" variant="danger">Erase for good</Button></div>
          </form>
        </section>
      )}

      <section aria-labelledby="history" className="mt-8">
        <h2 id="history" className="font-semibold text-text">History</h2>
        <ul className="mt-2 grid gap-2">
          {history.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-x-4">
              <Link href={`/dashboard/bookings/${b.id}`} className={`inline-flex min-h-11 items-center font-semibold text-accent underline ${b.status === "cancelled" ? "line-through" : ""}`}>
                {formatDate(b.startAt, tz)}, {formatTime(b.startAt, tz)}
              </Link>
              {b.status === "cancelled" && <span className="text-sm text-text-muted">Cancelled</span>}
              {b.invitee.noShowAt && <span className="rounded-md bg-warning-bg px-2 py-0.5 text-sm text-warning">No-show</span>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
