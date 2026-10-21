import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { LegalLinks } from "@/components/LegalLinks";
import { LanguageDemo } from "@/components/landing/LanguageDemo";
import { Mark } from "@/components/landing/Mark";
import { SyncDemo } from "@/components/landing/SyncDemo";
import { BREAK_HASH, display, heading, ink } from "@/components/landing/ink";
import { buttonClasses } from "@/components/ui/Button";
import { focusRing } from "@/components/ui/focus";
import { authEnabled } from "@/lib/auth/auth";
import { getSignedInUser } from "@/lib/auth/session";

// The data mode is read at request time; a build made in memory mode must not prerender away the signed-in redirect.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Hourhand: a booking link that checks your calendar",
  description:
    "One booking link for coaches, tutors and therapists. Hourhand checks your Google Calendar, shows a sync light for each calendar, and a person answers support.",
};

const container = "mx-auto w-full max-w-[1160px] px-4 sm:px-6 lg:px-8";

const steps = [
  { title: "Connect your calendar", body: "Google, Outlook or iCloud: pick the calendars to check. Each one gets its own sync light." },
  { title: "Share your link", body: "Put it in your bio, your messages or your site. Guests see only the times you're free, in their own time zone." },
  { title: "Show up", body: "The booking lands in your calendar with a Google Meet link, and your guest gets a confirmation and reminders." },
];

const included = [
  "Google Meet and Teams links created for you",
  "Weekly repeat bookings",
  "Session packages",
  "Refundable no-show deposits",
  "GST invoices to guests",
  "Group classes with a seat limit",
  "A waitlist for full days",
  "Private client notes",
  "A monthly earnings report",
  "An app you can install on your phone from the browser",
  "Cancel, move or mark a no-show from your dashboard",
];

const onTheWay = ["WhatsApp alerts to you when a calendar stops syncing", "Apps in the App Store and Google Play", "An importer for links you already have"];

const plans = [
  {
    name: "Free",
    for: "For trying it, or a light schedule",
    price: "₹0",
    note: "Free for good",
    items: ["2 calendars checked for conflicts", "Booking emails with calendar files", "Google Meet links", "A small “Booked with Hourhand” line on your page"],
    recommended: false,
  },
  {
    name: "Solo",
    for: "For a coach, tutor or therapist",
    price: "₹399",
    note: "+ 18% GST, or ₹3,990 a year",
    items: ["Every calendar you want checked", "Payment at booking through your Razorpay account", "300 automatic WhatsApp messages to guests a month, once WhatsApp approves our business number", "No Hourhand line on your page"],
    recommended: true,
  },
  {
    name: "Duo",
    for: "For you and an assistant",
    price: "₹599",
    note: "+ 18% GST, or ₹5,990 a year",
    items: ["Everything in Solo", "600 automatic WhatsApp messages to guests a month, once WhatsApp approves our business number", "A second person at no extra cost: an assistant who runs your bookings, or a co-host with their own page"],
    recommended: false,
  },
];

const faqs = [
  {
    q: "What happens if my calendar stops syncing?",
    a: "The sync light shows it, your booking page stops offering times until we can check again, and we email you a link to reconnect. Nobody can book a time we can't check.",
  },
  { q: "Which calendars work?", a: "Google Calendar, Outlook, Office 365 and iCloud." },
  {
    q: "Do you send WhatsApp reminders?",
    a: "Not automatically yet. On Solo and Duo, guests who tick WhatsApp at booking will get the confirmation, a reminder the day before, and a message if the time changes, as soon as WhatsApp approves our business number. Until then, each booking has a button to message your guest on WhatsApp yourself, and emails always go.",
  },
  { q: "How do I cancel?", a: "Dashboard, then Plan, then Cancel. You keep your plan until the end of the period you've paid for." },
  { q: "Who answers support?", a: "A person, within one working day." },
  { q: "Is GST included?", a: "No. Prices are shown before GST, and 18% GST is added at checkout." },
];

const emails = [
  { when: "On booking", what: "You're booked: 45-minute coaching session", who: "To Anjali, with a calendar file" },
  { when: "On booking", what: "New booking: Anjali, Thu 23 Oct, 10:30 am", who: "To Priya" },
  { when: "24 hours before", what: "Reminder: tomorrow at 10:30 am with Priya", who: "To Anjali" },
  { when: "1 hour before", what: "Starting at 10:30 am: your Google Meet link", who: "To Anjali" },
  { when: "If it changes", what: "Moved to Fri 24 Oct, 2:00 pm", who: "To both of you" },
];

function Arrow() {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

function Check({ className = "" }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={`mt-1 size-4 shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

/** One showcase row on the ink band: words on one side, the product doing it on the other. */
function Showcase({ id, title, children, visual, flip = false }: { id: string; title: string; children: ReactNode; visual: ReactNode; flip?: boolean }) {
  return (
    <div className={`grid items-center gap-10 border-t py-16 md:grid-cols-2 md:gap-16 md:py-24 ${ink.line}`} aria-labelledby={id}>
      <div className={flip ? "md:order-2" : ""}>
        <h3 id={id} className={`${heading} text-3xl md:text-4xl ${ink.text}`}>
          {title}
        </h3>
        <div className={`mt-5 max-w-[46ch] space-y-4 text-base leading-relaxed ${ink.muted}`}>{children}</div>
      </div>
      <div className={flip ? "md:order-1" : ""}>{visual}</div>
    </div>
  );
}

function ExampleNote() {
  return <p className={`mt-3 text-xs ${ink.muted}`}>Example data.</p>;
}

export default async function Home() {
  // In memory mode there are no accounts (the dashboard opens as the demo host), so everyone sees the landing page.
  if (authEnabled() && (await getSignedInUser())) redirect("/dashboard/event-types");

  const navLink = `rounded-sm px-3 py-2 text-sm text-text-muted transition-colors duration-(--hh-motion-fast) hover:text-text ${focusRing}`;

  return (
    <div className="selection:bg-highlight selection:text-on-highlight">
      <header className="sticky top-0 z-20 border-b border-border bg-bg">
        <div className={`${container} flex h-16 items-center gap-6`}>
          <Link href="/" className={`flex items-center gap-2.5 rounded-sm font-display text-lg font-semibold tracking-[-0.01em] text-text ${focusRing}`} aria-label="Hourhand home">
            <Mark />
            hourhand
          </Link>
          <nav aria-label="Main" className="ml-auto flex items-center gap-1 md:ml-0">
            <a href="#how" className={`${navLink} hidden md:inline-flex`}>
              How it works
            </a>
            <a href="#pricing" className={`${navLink} inline-flex`}>
              Pricing
            </a>
            <a href="#faq" className={`${navLink} hidden md:inline-flex`}>
              Questions
            </a>
          </nav>
          <div className="flex items-center gap-2 md:ml-auto">
            <Link href="/sign-in" className={`${navLink} hidden sm:inline-flex`}>
              Sign in
            </Link>
            <Link href="/sign-in" className={`${buttonClasses({ size: "sm" })} whitespace-nowrap`}>
              Start free
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section aria-labelledby="hero-title" className={`${container} pb-10 pt-12 md:pb-10 md:pt-10`}>
          <h1 id="hero-title" className={`${display} max-w-[24ch] text-[2.5rem] text-text sm:text-5xl lg:text-[3.5rem]`}>
            Your booking link, kept in sync. <span className="text-text-muted">And a person when it isn&apos;t.</span>
          </h1>
          <p className="mt-5 max-w-[68ch] text-base font-normal leading-relaxed text-text-muted md:text-lg">
            One link for coaches, tutors and therapists. It offers only the times your calendar says you&apos;re free, and a real person answers if anything goes wrong.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2">
            <Link href="/sign-in" className={buttonClasses({ size: "lg" })}>
              Start free
            </Link>
            <a href={BREAK_HASH} className={`${buttonClasses({ variant: "ghost", size: "lg" })} gap-2`}>
              See it pause a booking
              <Arrow />
            </a>
            <p className="w-full text-sm text-text-muted lg:ml-2 lg:w-auto">Free for one person. No card needed.</p>
          </div>
        </section>

        <section id="demo" aria-label="See it work" className={`${ink.band} scroll-mt-16 border-y border-border pt-8 pb-12 md:pt-8 md:pb-20`}>
          <div className={container}>
            <SyncDemo />
          </div>
        </section>

        <section aria-labelledby="problem" className={`${container} grid gap-10 py-20 md:grid-cols-12 md:py-28`}>
          <h2 id="problem" className={`${heading} text-3xl text-text md:col-span-5 md:text-[2.75rem]`}>
            Two things a booking tool should never do
          </h2>
          <div className="divide-y divide-border border-y border-border md:col-span-7">
            <div className="py-7">
              <h3 className="font-display text-2xl font-semibold tracking-[-0.015em] text-text">Say you&apos;re free when you&apos;re not</h3>
              <p className="mt-3 max-w-[58ch] leading-relaxed text-text-muted">
                A calendar quietly stops syncing, a client books over another session, and you only find out when two people turn up.
              </p>
            </div>
            <div className="py-7">
              <h3 className="font-display text-2xl font-semibold tracking-[-0.015em] text-text">Go quiet when it breaks</h3>
              <p className="mt-3 max-w-[58ch] leading-relaxed text-text-muted">
                You get a bot or a help article instead of an answer. And leaving turns out to be harder than joining was.
              </p>
            </div>
          </div>
        </section>

        <section id="how" aria-labelledby="how-title" className="scroll-mt-16 border-t border-border">
          <div className={`${container} py-20 md:py-28`}>
            <h2 id="how-title" className={`${heading} text-3xl text-text md:text-[2.75rem]`}>
              How it works
            </h2>
            <ol className="mt-12 grid border-t border-border md:grid-cols-3 md:divide-x md:divide-border">
              {steps.map((s, i) => (
                <li key={s.title} className="border-b border-border py-8 md:border-b-0 md:px-8 md:first:pl-0 md:last:pr-0">
                  <span aria-hidden className="font-display text-5xl font-semibold tabular-nums text-accent">
                    {i + 1}
                  </span>
                  <h3 className="mt-6 text-lg text-text">{s.title}</h3>
                  <p className="mt-2 leading-relaxed text-text-muted">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section aria-labelledby="features" className={ink.band}>
          <div className={`${container} pt-20 md:pt-28`}>
            <h2 id="features" className={`${heading} max-w-[18ch] text-3xl md:text-5xl ${ink.text}`}>
              Built around what goes wrong
            </h2>
            <p className={`mt-5 max-w-[52ch] text-lg font-normal leading-relaxed ${ink.muted}`}>
              A sync light for every calendar. If we can&apos;t check one, your booking page stops offering times, and if the connection drops, we email you.
            </p>

            <div className="mt-16">
              <Showcase
                id="zones"
                title="No time zone guesswork"
                visual={
                  <div>
                    <LanguageDemo />
                    <ExampleNote />
                  </div>
                }
              >
                <p>Guests see times in their own zone, and can switch between 12-hour and 24-hour clocks.</p>
                <p>Booking pages work in Hindi, Tamil, Telugu and Kannada as well as English. Try the switch.</p>
              </Showcase>

              <div className={`border-t py-16 md:py-24 ${ink.line}`} aria-labelledby="emails">
                <div className="grid gap-6 md:grid-cols-2 md:gap-16">
                  <h3 id="emails" className={`${heading} text-3xl md:text-4xl ${ink.text}`}>
                    Emails that do the chasing
                  </h3>
                  <p className={`max-w-[46ch] text-base leading-relaxed md:pt-2 ${ink.muted}`}>
                    Confirmation, reminder, reschedule and cancellation emails, each with a calendar file your guest can add in one click.
                  </p>
                </div>
                <ol className={`${ink.frame} mt-12 grid gap-2 p-2 sm:grid-cols-2 sm:p-3 lg:grid-cols-5`}>
                  {emails.map((e, i) => (
                    <li key={e.what} className={`${ink.pane} flex flex-col p-4`}>
                      <span className={`flex items-center gap-2 text-xs ${ink.muted}`}>
                        <span aria-hidden className={`flex size-5 items-center justify-center rounded-pill border text-[0.6875rem] tabular-nums ${ink.lineStrong} ${ink.text}`}>
                          {i + 1}
                        </span>
                        {e.when}
                      </span>
                      <span className={`mt-4 block text-sm ${ink.text}`}>{e.what}</span>
                      <span className={`mt-auto block pt-3 text-xs ${ink.muted}`}>{e.who}</span>
                    </li>
                  ))}
                </ol>
                <ExampleNote />
              </div>

              <Showcase
                id="paid"
                flip
                title="Paid sessions"
                visual={
                  <div>
                    <div className={`${ink.frame} p-2 sm:p-3`}>
                      <div className={`${ink.pane} p-5 sm:p-6`}>
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className={`text-sm ${ink.muted}`}>Payment received</p>
                            <p className={`mt-1 font-display text-4xl font-semibold tabular-nums tracking-[-0.02em] ${ink.text}`}>₹1,500</p>
                          </div>
                          <span className={`rounded-pill px-2.5 py-1 text-xs ${ink.successPill}`}>Paid</span>
                        </div>
                        <dl className={`mt-6 divide-y border-t text-sm ${ink.line} ${ink.divide}`}>
                          {[
                            ["Session", "45-minute coaching, Thu 23 Oct"],
                            ["Guest", "Anjali"],
                            ["Paid through", "Priya's Razorpay account"],
                            ["GST invoice", "Emailed to Anjali"],
                          ].map(([k, v]) => (
                            <div key={k} className="flex justify-between gap-4 py-3">
                              <dt className={ink.muted}>{k}</dt>
                              <dd className={`text-right ${ink.text}`}>{v}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    </div>
                    <ExampleNote />
                  </div>
                }
              >
                <p>On Solo and Duo, take payment at booking through your own Razorpay account. The money goes straight to you.</p>
                <p>Guests get a GST invoice, and session packages and refundable no-show deposits work the same way.</p>
              </Showcase>

              <Showcase
                id="person"
                title="A person, not a bot. And one tap to leave."
                visual={
                  <div>
                    <div className={`${ink.frame} p-2 sm:p-3`}>
                      <div className={`${ink.pane} p-5 sm:p-6`}>
                        <p className={`text-sm ${ink.muted}`}>Your plan</p>
                        <p className={`mt-1 text-xl font-semibold ${ink.text}`}>Solo</p>
                        <p className={`mt-1 text-sm tabular-nums ${ink.muted}`}>₹399 a month + 18% GST · renews 14 Nov</p>
                        <p className={`mt-5 rounded-sm border p-3 text-sm ${ink.line} ${ink.text}`}>We emailed you on 7 Nov, 7 days before this renewal.</p>
                        <div className="mt-5 flex flex-wrap items-center gap-3">
                          <span className={`inline-flex h-11 items-center rounded-md border px-4 text-sm font-semibold ${ink.lineStrong} ${ink.text}`}>Cancel plan</span>
                          <span className={`text-xs ${ink.muted}`}>You keep Solo until 14 Nov.</span>
                        </div>
                      </div>
                      <div className={`${ink.pane} mt-2 flex items-center justify-between gap-4 p-5 sm:p-6`}>
                        <div>
                          <p className={`text-sm font-semibold ${ink.text}`}>Write to support</p>
                          <p className={`mt-1 text-sm ${ink.muted}`}>A person replies within one working day, on every plan.</p>
                        </div>
                      </div>
                    </div>
                    <ExampleNote />
                  </div>
                }
              >
                <p>Write to support and a person answers within one working day, on every plan.</p>
                <p>We email you 7 days before each renewal. Cancel from your plan page and keep access to the end of what you paid for.</p>
              </Showcase>
            </div>

            <div className={`grid gap-12 border-t py-16 md:grid-cols-12 md:py-24 ${ink.line}`}>
              <div className="md:col-span-8">
                <h3 className={`text-lg ${ink.text}`}>Also included</h3>
                <ul className="mt-6 grid gap-x-8 sm:grid-cols-2">
                  {included.map((item) => (
                    <li key={item} className={`flex gap-3 border-t py-3 text-sm ${ink.line} ${ink.text}`}>
                      <Check className={ink.accent} />
                      {item}
                    </li>
                  ))}
                  <li className={`flex gap-3 border-t py-3 text-sm ${ink.line} ${ink.text}`}>
                    <Check className={ink.accent} />
                    Booking pages in Hindi, Tamil, Telugu and Kannada
                  </li>
                </ul>
              </div>
              <div className="md:col-span-4">
                <h3 className={`flex items-center gap-3 text-lg ${ink.text}`}>
                  On the way
                  <span className={`inline-flex items-center gap-2 rounded-pill bg-[rgb(242_169_59/0.14)] px-2.5 py-1 text-xs ${ink.text}`}>
                    <span aria-hidden className="size-1.5 rounded-pill bg-highlight" />
                    Coming soon
                  </span>
                </h3>
                <ul className="mt-6">
                  {onTheWay.map((item) => (
                    <li key={item} className={`border-t py-3 text-sm ${ink.line} ${ink.muted}`}>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-16">
          <div className={`${container} py-20 md:py-28`}>
            <div className="flex flex-wrap items-end justify-between gap-6">
              <h2 id="pricing-title" className={`${heading} text-3xl text-text md:text-5xl`}>
                Simple pricing
              </h2>
              <p className="max-w-[40ch] text-text-muted">Cancel in one tap. We&apos;ll email you 7 days before every renewal.</p>
            </div>
            <div className="mt-12 grid overflow-hidden rounded-lg border border-border bg-card md:grid-cols-3 md:divide-x md:divide-border">
              {plans.map((p) => (
                <div
                  key={p.name}
                  className={`relative flex flex-col border-b border-border p-6 last:border-b-0 md:border-b-0 lg:p-8 ${p.recommended ? "bg-surface" : ""}`}
                >
                  {p.recommended && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-accent" />}
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-lg text-text">{p.name}</h3>
                    {p.recommended && <span className="rounded-pill bg-accent px-2.5 py-1 text-xs text-on-accent">Recommended</span>}
                  </div>
                  <p className="mt-1 text-sm text-text-muted">{p.for}</p>
                  <p className="mt-8 flex items-baseline gap-2">
                    <span className="font-display text-5xl font-semibold tabular-nums tracking-[-0.03em] text-text">{p.price}</span>
                    <span className="text-sm text-text-muted">a month</span>
                  </p>
                  <p className="mt-2 text-sm text-text-muted">{p.note}</p>
                  <ul className="mt-8 flex-1 space-y-3 border-t border-border pt-6 text-sm text-text">
                    {p.items.map((item) => (
                      <li key={item} className="flex gap-3">
                        <Check className="text-accent" />
                        {item}
                      </li>
                    ))}
                  </ul>
                  <Link href="/sign-in" className={`${buttonClasses({ variant: p.recommended ? "primary" : "secondary" })} mt-8`}>
                    Start free
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="faq" aria-labelledby="faq-title" className="scroll-mt-16 border-t border-border">
          <div className={`${container} grid gap-10 py-20 md:grid-cols-12 md:py-28`}>
            <h2 id="faq-title" className={`${heading} text-3xl text-text md:col-span-4 md:text-5xl`}>
              Questions
            </h2>
            <div className="divide-y divide-border border-y border-border md:col-span-8">
              {faqs.map((f) => (
                <details key={f.q} className="group">
                  <summary
                    className={`flex min-h-14 cursor-pointer list-none items-center justify-between gap-6 rounded-sm py-5 text-left text-lg font-semibold text-text [&::-webkit-details-marker]:hidden ${focusRing}`}
                  >
                    {f.q}
                    <svg
                      aria-hidden
                      viewBox="0 0 16 16"
                      className="size-4 shrink-0 text-text-muted transition-transform duration-(--hh-motion-base) group-open:rotate-45"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                    >
                      <path d="M8 3v10M3 8h10" />
                    </svg>
                  </summary>
                  <p className="max-w-[62ch] pb-6 leading-relaxed text-text-muted">{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="final" className={ink.band}>
          <div className={`${container} py-24 md:py-32`}>
            <h2 id="final" className={`${display} max-w-[18ch] text-4xl md:text-7xl ${ink.text}`}>
              Book clients without double-checking your calendar.
            </h2>
            <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Link
                href="/sign-in"
                className={`inline-flex h-13 items-center rounded-md px-5 text-base font-semibold transition-opacity duration-(--hh-motion-fast) hover:opacity-90 ${ink.accentBg} ${ink.focus}`}
              >
                Start free
              </Link>
              <p className={`text-sm ${ink.muted}`}>No card needed.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className={`${container} grid gap-10 py-14 sm:grid-cols-2 md:grid-cols-4`}>
          <div>
            <span className="flex items-center gap-2.5 font-display text-lg font-semibold text-text">
              <Mark size="size-6" />
              hourhand
            </span>
            <p className="mt-3 max-w-[30ch] text-sm text-text-muted">A booking link that checks your calendar.</p>
          </div>
          <nav aria-label="Product" className="text-sm">
            <p className="font-semibold text-text">Product</p>
            <ul className="mt-3 space-y-2 text-text-muted">
              <li>
                <a href="#how" className={`rounded-sm hover:text-text ${focusRing}`}>How it works</a>
              </li>
              <li>
                <a href="#pricing" className={`rounded-sm hover:text-text ${focusRing}`}>Pricing</a>
              </li>
              <li>
                <a href="#faq" className={`rounded-sm hover:text-text ${focusRing}`}>Questions</a>
              </li>
            </ul>
          </nav>
          <nav aria-label="Account" className="text-sm">
            <p className="font-semibold text-text">Account</p>
            <ul className="mt-3 space-y-2 text-text-muted">
              <li>
                <Link href="/sign-in" className={`rounded-sm hover:text-text ${focusRing}`}>Sign in</Link>
              </li>
              <li>
                <Link href="/sign-in" className={`rounded-sm hover:text-text ${focusRing}`}>Start free</Link>
              </li>
            </ul>
          </nav>
          <div className="text-sm">
            <p className="font-semibold text-text">Legal</p>
            <LegalLinks className="mt-3 flex-col items-start gap-2" />
          </div>
        </div>
        <div className={`${container} border-t border-border py-6 text-sm text-text-muted`}>
          <p>© 2026 Marvice Media Private Limited</p>
        </div>
      </footer>
    </div>
  );
}
