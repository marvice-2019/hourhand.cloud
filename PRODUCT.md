# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Solo coaches, tutors and therapists, plus small service businesses run by one person (fitness trainers, music and language tutors, life coaches). India first. Their job is to let clients book a session without the host checking their calendar by hand. They have been let down by schedulers that double-booked them when a calendar quietly stopped syncing, and by vendors that answered with a bot.

Their guests are the second audience. They open the host's link on a phone from a WhatsApp message, an Instagram bio or a website, pick a time in their own time zone, and often read the page in Hindi, Tamil, Telugu or Kannada.

On Duo, a third person may be involved: an assistant who runs the host's bookings, or a co-host with their own page.

## Product Purpose

One booking link that offers only the times the host's calendars say are free, keeps those calendars visibly in sync, and stops offering times when it can't check them. Success means a host never finds out about a double booking by two people turning up. Launch target: 50 active Solo or Duo users within 90 days of public launch, where active means at least 5 bookings a month (docs/launch/launch-plan.md).

## Positioning

The booking link that tells you when it can't be trusted. Every connected calendar shows a sync light, and a calendar Hourhand can't check pauses the booking page instead of failing quietly. When something breaks, a person answers support within one working day on every plan, and leaving takes one tap. Most schedulers fail silently and hide cancellation. Hourhand's whole pitch is the opposite.

## Operating Context

- **Hosts** connect Google, Outlook/Office 365 or iCloud calendars, share one link, and run their day from a dashboard: cancel, move a booking to another free time, mark a no-show, keep private client notes, read a monthly earnings report.
- **Guests** book from a phone, pick 12h or 24h time, get a confirmation email with a calendar file, reminder emails at 24 hours and 1 hour, and change notices. Paid plans can also send WhatsApp messages (see Capabilities).
- **Money:** hosts on Solo and Duo take payment at booking through their own Razorpay account, so the money goes straight to them. Guests get GST invoices. Session packages, weekly repeat bookings and refundable no-show deposits are supported.
- **Video:** Google Meet links are created automatically, and Microsoft Teams links on work and school Outlook accounts. Zoom is not supported.
- **Install:** the web app installs on a phone from the browser. Native App Store and Google Play apps are planned, not built.

## Capabilities and Constraints

- **Calendars:** Google (busy times every 5 minutes plus instant push), Outlook/Office 365 (every 5 minutes, no push yet) and iCloud (CalDAV with an app-specific password, polling). All three show a sync light and send an email alert on disconnect (docs/features.csv, row 42). The landing page currently says only "Each Google calendar shows when it last synced". That is narrower than the product, not wrong.
- **Pause on uncertainty:** if a calendar can't be checked, the booking page stops offering times. This is the core promise; no design may soften or hide it.
- **WhatsApp to guests (D7):** automatic confirmation, day-ahead reminder and change notices from one shared Hourhand number. Opt-in only, STOP opts the guest out for every host, and the monthly limit is 300 on Solo and 600 on Duo. **Built but switched off until Meta approves the account and templates** (docs/deploy.md 5b, build-log D7). The live landing and FAQ sell it as available today. **Open: confirm whether production has the WhatsApp variables set; if not, the pricing and FAQ copy overclaim.**
- **Not built:** a WhatsApp alert to the host when a calendar stops syncing ("Coming soon" on the site, but the launch plan's Show HN draft claims it), an importer for existing booking links, native store apps, Zoom, SMS.
- **Plans:** Free ₹0 (2 calendars checked, a "Booked with Hourhand" line on the page). Solo ₹399/month or ₹3,990/year. Duo ₹599/month or ₹5,990/year, with a second person at no extra cost. Prices are shown before GST, and 18% GST is added at checkout. Renewal email 7 days before each renewal, and cancelling keeps access to the end of the paid period.
- **Languages:** guest pages, guest emails and WhatsApp texts in English, Hindi, Tamil, Telugu and Kannada. Host emails are English only. The four Indian-language drafts are still waiting on native-speaker review.
- **Also included:** group classes with a seat limit, a waitlist for full days, a booking page that works as a mini website (photo, about, services with prices, social links, schema.org markup).
- **Stack:** Next.js 16, React 19, Tailwind 4, Postgres, Better Auth, Resend. Deployed on Coolify from `main` (live at hourhand.cloud, staging at staging.hourhand.cloud).
- **Terminology:** host, guest, booking link, sync light, Solo, Duo. Say "calendar", not "integration", and "booking page", not "scheduling page".

## Brand Commitments

- **Name and voice:** the name is Hourhand, written "hourhand" in lowercase in the wordmark. The voice is plain, steady and human: short words, calm about failures, says what happened and what happens next, no emoji in errors, no "Oops", no AI-assistant framing. The string examples in docs/brand.md section 4 are binding.
- **Distance from Calendly:** never use their blue (`#006bff`), a ring or "C" letterform, or a rounded-square badge like theirs, and never name them in public copy (docs/brand.json is the sweep list). No ranking claims ("best", "#1").
- **Existing identity:** an existing visual identity is recorded in docs/brand.md and docs/design/ (tokens.json, tokens.css, components.md). PRODUCT.md does not restate it; DESIGN.md is the place for it.
- **Legal entity:** the site is operated by Marvice Media Private Limited, and the footer carries that name.
- **Trademark:** the Hourhand trademark searches in India, the US, the EU, Canada and WIPO are still to run (docs/brand.md). Don't add ® or ™ until they clear.

## Evidence on Hand

- **No customer proof yet.** There are no testimonials, customer names, logos, user counts, ratings or case studies. Future work must not invent any. The launch plan says quotes come only from beta users who agree in writing, and that the proof section stays empty until there are at least 3.
- **Real product demonstrations:** the seeded demo hosts Priya Raman (`/priya`) and Arun (`/arun`), the live booking widget on the landing page, and the sync light (`src/components/SyncLight.tsx`).
- **Research:** the complaints research behind the positioning is in docs/recon.md and docs/fixes.md.
- **Existing copy:** the landing copy is in docs/launch/landing.md and docs/launch/landing/index.html, and pricing rationale is in docs/launch/pricing.md.

## Product Principles

1. **Say so when it can't be trusted.** Sync state is always visible, and uncertainty pauses bookings rather than risking a clash.
2. **A person answers.** Support is human on every plan; never frame help as a bot.
3. **Leaving is as easy as joining.** One-tap cancel and a renewal notice before every charge. No hidden steps.
4. **The guest's time, in the guest's language.** Every time shown carries a zone, and guest-facing pages work in the five supported languages on a phone.
5. **Claim only what ships.** Features behind approval or still planned are labelled as such, and proof is real and permissioned or absent.

## Accessibility & Inclusion

- **Contrast:** WCAG AA. The token pairs have been checked (12 pairs, 0 failing, docs/brand.md section 2).
- **Phones first:** guest booking pages must work on low-end Android phones over mobile data, since that is how most guests arrive.
- **Scripts:** guest pages render Devanagari, Tamil, Telugu and Kannada. Dates use Latin digits, and layouts must allow for longer strings than English.
