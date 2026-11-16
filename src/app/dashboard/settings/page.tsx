import Link from "next/link";
import { DeleteAccountForm } from "@/components/DeleteAccountForm";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { signOutEverywhere } from "@/lib/auth/actions";
import { requireOwnAccount } from "@/lib/auth/session";
import { focusRing } from "@/components/ui/focus";
import { LOCALES, LOCALE_NAMES, isLocale } from "@/lib/i18n/guest";
import { setBookingLanguage, setSessionPrep } from "./actions";
import { hostPlan } from "@/lib/billing/account";
import { LIMITS } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { prepClientFromEnv, prepSettings } from "@/lib/session-prep/prep";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const user = await requireOwnAccount();
  const { saved, error } = await searchParams;
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const prep = pool ? await prepSettings(pool, user.id) : null;
  const prepPlan = pool ? LIMITS[await hostPlan(pool, user.id)].sessionPrep : false;
  const prepServer = prepClientFromEnv() !== null;
  return (
    <div>
      <h1 className="font-display text-xl text-text">Settings</h1>
      <p className="mt-2 text-text-muted">Change your name, booking page address, time zone and time format.</p>
      <ul className="flex flex-wrap gap-x-6">
        <li><Link href="/dashboard/event-types" className="mt-4 inline-flex min-h-11 items-center font-semibold text-accent underline">Event types</Link></li>
      </ul>

      <Card className="mt-8 max-w-xl">
        <h2 className="font-semibold text-text">Appearance</h2>
        <p className="mt-1 text-text-muted">Dark mode is easier on the eyes at night. Device follows your phone or computer setting.</p>
        <ThemeSwitch className="mt-4" />
      </Card>

      <Card className="mt-6 max-w-xl">
        <h2 className="font-semibold text-text">Booking page language</h2>
        <p className="mt-1 text-text-muted">What guests see first on your booking pages. They can switch to another language at the top of the page.</p>
        <form action={setBookingLanguage} className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="locale" className="block text-sm font-semibold text-text">Language</label>
            <select id="locale" name="locale" defaultValue={isLocale(user.locale) ? user.locale : "en"}
              className={`mt-1 block h-11 rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
              {LOCALES.map((l) => <option key={l} value={l} lang={l}>{LOCALE_NAMES[l]}</option>)}
            </select>
          </div>
          <Button type="submit">Save</Button>
        </form>
        {saved === "language" && <p role="status" className="mt-2 text-success">Saved. New guests see your booking pages in this language.</p>}
      </Card>

      {prep && (
        <Card id="session-prep" className="mt-6 max-w-xl">
          <h2 className="font-semibold text-text">Session prep</h2>
          <p className="mt-1 text-text-muted">
            A day before each session, a short note on the booking: what the client wants from it, anything in their booking answers worth
            following up, and their history with you (first session, a long gap, missed sessions).
          </p>
          <p className="mt-2 text-sm text-text-muted">
            To write it, Hourhand sends Anthropic&apos;s Claude API the client&apos;s first name, their answers to your booking questions and counts
            of their past sessions. Never their email or phone, and never your private notes. Anthropic doesn&apos;t train on it. Group classes
            and polls with several guests don&apos;t get a note.
          </p>
          {!prepServer ? (
            <p className="mt-3 text-sm text-text">Session prep isn&apos;t set up on this server yet.</p>
          ) : !prepPlan ? (
            <p className="mt-3 text-sm text-text">Session prep comes with Solo and Duo. <Link href="/dashboard/plan" className="font-semibold text-accent underline">See plans</Link></p>
          ) : prep.enabled ? (
            <form action={setSessionPrep} className="mt-4">
              <p className="text-sm text-success">On since {prep.enabledAt?.toISOString().slice(0, 10)}.</p>
              <Button type="submit" variant="secondary" className="mt-2">Turn off session prep</Button>
            </form>
          ) : (
            <form action={setSessionPrep} className="mt-4 grid gap-3">
              <input type="hidden" name="enabled" value="on" />
              <label className="flex items-start gap-3 text-sm text-text">
                <input type="checkbox" name="agree" required className={`mt-0.5 size-5 shrink-0 accent-accent ${focusRing}`} />
                <span>I&apos;m fine with my clients&apos; first names, booking answers and session counts going to Anthropic for these notes, and my privacy notice to clients covers it.</span>
              </label>
              <div><Button type="submit">Turn on session prep</Button></div>
            </form>
          )}
          {error === "prep_agree" && <p role="alert" className="mt-2 text-sm text-danger">Tick the box to turn it on.</p>}
          {error === "prep_plan" && <p role="alert" className="mt-2 text-sm text-danger">Session prep comes with Solo and Duo.</p>}
          {saved === "prep_on" && <p role="status" className="mt-2 text-sm text-success">On. Notes appear on bookings a day before each session.</p>}
          {saved === "prep_off" && <p role="status" className="mt-2 text-sm text-text">Off. No new notes are made; ones already made stay on their bookings.</p>}
        </Card>
      )}

      <Card className="mt-6 max-w-xl">
        <h2 className="font-semibold text-text">Signed in as {user.email}</h2>
        {authEnabled() ? (
          <>
            <p className="mt-1 text-text-muted">Lost a phone or used a shared computer? Sign out everywhere, including this browser.</p>
            <form action={signOutEverywhere} className="mt-4">
              <Button type="submit" variant="secondary">
                Sign out of all devices
              </Button>
            </form>
          </>
        ) : (
          <p className="mt-1 text-text-muted">This copy runs on demo data, so there are no sessions to end.</p>
        )}
      </Card>

      {authEnabled() && (
        <Card className="mt-6 max-w-xl">
          <h2 className="font-semibold text-text">Delete your account</h2>
          <p className="mt-1 text-text-muted">
            Your booking links stop working straight away and upcoming bookings are cancelled. We keep your data for 30 days in case you change
            your mind, then delete it for good.
          </p>
          <DeleteAccountForm email={user.email} />
        </Card>
      )}
    </div>
  );
}
