# Deploy: Hourhand at https://hourhand.cloud

Host: your Coolify server (single 16GB VPS). Claude prepared the repo; you do the Coolify, DNS and account steps, and nothing goes live until you say go.

## Verdict

The repo is ready to deploy as a **public beta**. Five must-have features are still missing (below), and Google limits sign-in to 100 test users until its verification is approved (2–6 weeks), so launch quietly to your first coaches rather than with ads.

## 1. Preflight (2026-10-11)

| Check | Result |
| --- | --- |
| Unit and Postgres tests | **335 of 335 pass** (`TEST_DATABASE_URL` set, Postgres 16) |
| Production build with no env vars (as Docker builds it) | **passes** |
| Container start command, production mode, fresh database | migrations 0001–0007 applied; `/api/health` 200, `/icon.svg` 200, `/opengraph-image` 200, `/sign-in` 200; job runner started. Second start: "Nothing to apply" |
| Missing required env var | server refuses to start with a named error (e.g. `RESEND_API_KEY is not set`), so the healthcheck fails and Coolify keeps the previous version live |
| Brand sweep (`sweep.py hourhand --config docs/brand.json`) | **Clean** |
| Parity (`parity.py docs/features.csv`) | **70.1 / 100, must-haves 17 of 22** (was 42.0 because the list hadn't been updated since B2; every row changed was checked against the code) |
| Privacy policy and terms | `/privacy` and `/terms`, working drafts under Indian law: **have a lawyer review before public launch** |
| Public home page | `/` shows the landing page to visitors (needed for Google verification); signed-in hosts go to the dashboard |
| Cookie banner | not needed: only the sign-in session cookie, no analytics or ad cookies |
| Account deletion | Dashboard → Settings → Delete your account; recoverable 30 days, then purged hourly |
| Favicon, title, share image | yours (`src/app/icon.svg`, `src/app/opengraph-image.tsx`) |
| Real Docker build | **not run here** (no Docker daemon in this sandbox); the first Coolify build is the real test. The steps it runs were each run above |

**Still missing (must-haves):** text/WhatsApp reminders (B9), add-guests on the booking form, an add-to-calendar button on the confirmation page (the confirmation email already carries the calendar file).

**Not yet tried against the real services:** Resend sending, Google Calendar freeBusy and push, Razorpay Checkout in a browser. The first live booking is that test.

## 2. Production services (you)

| Service | Step |
| --- | --- |
| Postgres | Coolify → New resource → PostgreSQL 16, separate from anything dev. Turn on scheduled backups (daily, to S3-compatible storage such as Cloudflare R2 or Backblaze B2) and do one restore test a month. Copy its **internal** connection URL for `DATABASE_URL` |
| Resend | Add domain `hourhand.cloud`, add the SPF, DKIM and DMARC records it shows (section 4), wait for "Verified" |
| Google Cloud | Redirect URIs, authorised domain and scopes from `docs/backend.md` → "Production addresses for hourhand.cloud". Then submit verification: home page `https://hourhand.cloud`, privacy `https://hourhand.cloud/privacy`, terms `https://hourhand.cloud/terms` |
| Microsoft Entra | Section 6 |
| Stripe Connect (hosts outside India) | Section 5d. Sandbox first |
| Razorpay | Test mode first: webhook `https://hourhand.cloud/api/webhooks/razorpay` (events `subscription.*`), 4 test Plans, one test payment end to end. Then live keys (the live pair shared in chat on 2026-10-11 must be **regenerated** first) |

## 3. Coolify application

1. **New resource → Application → GitHub** (Coolify's GitHub App), repo `marvice-2019/hourhand.cloud`, branch `main`.
2. **Build pack:** Dockerfile. **Base directory:** `/`. **Port:** 3000.
3. **Domains:** `https://hourhand.cloud,https://www.hourhand.cloud`, and turn on the redirect to non-www (apex is the canonical address). Coolify issues the certificates.
4. **Healthcheck:** the Dockerfile has one (`/api/health`, which also checks the database). If you set it in Coolify's UI instead, use path `/api/health`, port 3000.
5. **Environment variables** (section 5). Mark all of them "runtime only"; the build needs none.
6. **Deploy.** In the logs you should see `Applied 0001_init … 0007_calendar_push`, then `✓ Ready`, then `[jobs] runner started (Resend, Google Calendar on, booking payments on)`.
7. **Deploys on merge come from CI, not from Coolify's auto deploy.** Coolify's git auto deploy never fired (2026-11-15: PR #8 needed a manual Redeploy), so the `deploy` job in `.github/workflows/hourhand-ci.yml` calls Coolify once the `check` job passes on a push to `main`, waits for the deployment to finish, then checks `/`, `/coaches`, `/sign-in` and `/api/health` live. It needs two secrets in the GitHub Environment **`Production`** (Settings → Environments; a job only sees an environment's secrets when it names that environment, which the `deploy` job does): `COOLIFY_WEBHOOK` (Coolify → app → Webhooks → Deploy Webhook URL) and `COOLIFY_TOKEN` (Coolify → Keys & Tokens → API token with deploy permission). Leave Coolify's own **auto deploy off**, or a merge deploys twice. Migrations run on each deploy before the server starts; a failing one stops the deploy and the old version stays up.

One container runs the website and the background jobs (emails, calendar sync, payment checks). Run exactly **one** replica; a second one would need `HOURHAND_WORKER=0`. Expect about 300–500 MB of RAM.

## 4. DNS records for hourhand.cloud

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | your Coolify server's public IPv4 |
| A | `www` | the same IP (Coolify redirects it to the apex) |
| TXT / CNAME / MX | as Resend shows | SPF and DKIM for sending as `booking@hourhand.cloud` (copy them exactly from Resend → Domains) |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:yuvarajgs@marvice.in` (tighten to `p=quarantine` after two weeks of clean reports) |

If you want mail sent **to** booking@hourhand.cloud to arrive somewhere, add a mailbox (Zoho or Google Workspace) and its MX records. Sending doesn't need it.

## 5. Environment variables (Coolify → app → Environment)

Generate the two random values on your own machine with `openssl rand -hex 32` (once each). **Keep `TOKEN_ENCRYPTION_KEY` in your password manager and never change it:** every connected calendar, every host's Razorpay key and every private client and session note is sealed with it, so a new key disconnects them all and makes notes unreadable.

| Name | Value | Required |
| --- | --- | --- |
| `HOURHAND_DATA` | `postgres` | yes |
| `DATABASE_URL` | the internal URL of the Coolify Postgres | yes |
| `BETTER_AUTH_URL` | `https://hourhand.cloud` | yes |
| `BETTER_AUTH_SECRET` | random (openssl) | yes |
| `TOKEN_ENCRYPTION_KEY` | random (openssl), never changes | yes |
| `RESEND_API_KEY` | from Resend | yes |
| `EMAIL_FROM` | `Hourhand <booking@hourhand.cloud>` | yes |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from Google Cloud | for Google sign-in and calendars |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | from Razorpay (test first) | for paid plans |
| `RAZORPAY_PLAN_SOLO_MONTH`, `_SOLO_YEAR`, `_DUO_MONTH`, `_DUO_YEAR` | the 4 Plan ids | for paid plans |
| `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET` | from Stripe (sandbox first), Runtime only | for hosts outside India taking payments through Stripe Connect. Both are needed; without them the Stripe option on Integrations says "not set up on this server" |
| other `STRIPE_*` | only if you get Stripe for Hourhand plans (see backend.md) | no |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | from Entra (section 6) | for Outlook and Sign in with Microsoft |
| `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`, `ZOOM_WEBHOOK_SECRET` | from the Zoom app (section 6b), as **Runtime** variables | for Zoom links |
| `TRUSTED_PROXIES` | leave unset (defaults cover Coolify's Docker network) | no |
| `RAZORPAY_PLAN_DOMAIN_MONTH` | the Razorpay Plan id of the custom-domain add-on (section 5c) | for custom domains |
| `TRAEFIK_DYNAMIC_DIR` | `/traefik-dynamic` (the mount in section 5c) | for custom domains |
| `HOURHAND_UPSTREAM_URL` | `http://hourhand-app:3000` (section 5c) | for custom domains |

Never set `HOURHAND_ALLOW_MEMORY`, `HOURHAND_MAIL_TO_LOG`, `HOURHAND_E2E`, `GOOGLE_API_BASE_URL`, `RAZORPAY_API_BASE_URL`, `STRIPE_API_BASE_URL`, `MICROSOFT_LOGIN_BASE_URL`, `MICROSOFT_GRAPH_BASE_URL`, `ZOOM_OAUTH_BASE_URL`, `ZOOM_API_BASE_URL` or `ICLOUD_CALDAV_URL` in production; they exist for local testing only.

iCloud calendars need no server keys: each host connects with their own Apple ID and app-specific password, sealed with `TOKEN_ENCRYPTION_KEY`.

**Batches A–C (2026-10-11):** migrations now run to `0020` (0019 is skipped on purpose); the container applies them on start, as before. No new required variables. Monthly earnings emails, waitlist emails, Duo invitations and waitlist cleanup run inside the existing job runner. Profile photos are stored in Postgres (up to 2 MB each), so they are in your database backups.

**Batch D (2026-10-11):** migrations run to `0023`. No new variables. Booking pages can now be embedded on other sites through `/embed.js`; the dashboard, sign-in, API and legal pages refuse to be framed. Only https redirect links are kept on event types (any other stored value was cleared by `0023`).

**Roadmap 1.4, Stripe Connect (2026-11-15):** migrations `0034_stripe_connect` and `0035_stripe_payments` (0026 to 0033 belong to other work and may land in any order; each migration is independent). New Runtime variables `STRIPE_SECRET_KEY` and `STRIPE_CONNECT_WEBHOOK_SECRET` (section 5d). Without them, nothing changes for Razorpay hosts and the Stripe option says it isn't set up.

**Security fixes (2026-10-11):** if you put Cloudflare (or any other proxy) in front of Coolify, add its address ranges to `TRUSTED_PROXIES`, or every visitor shares one rate-limit bucket. Keep the app's own port closed to the internet so all traffic comes through Coolify's proxy.

**Group classes and installable app (2026-10-13):** migrations run to `0025` (adds the seat column to bookings; existing bookings are untouched). No new variables. Hosts can install Hourhand to their phone's home screen from the dashboard.

## 5b. WhatsApp (D7: automatic confirmations and reminders)

Off until all four variables below are set. With them unset nothing is queued, the booking form doesn't offer WhatsApp, and the wa.me buttons on each booking work as before. Migration `0024` adds the opt-in and opt-out tables either way.

| Variable | Value | Required for WhatsApp |
| --- | --- | --- |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp Manager → your number → Phone number ID | yes |
| `WHATSAPP_ACCESS_TOKEN` | the permanent system-user token (step 4 below) | yes |
| `WHATSAPP_APP_SECRET` | Meta app → App settings → Basic → App secret (signs the webhook) | yes |
| `WHATSAPP_VERIFY_TOKEN` | any long random string you make up; type the same one in step 5 | yes |

Steps (you; Claude never signs in to Meta or handles the token):

1. Meta Business Suite → Settings → Business info: verify Marvice Media Private Limited.
2. WhatsApp Manager: create the WhatsApp Business account with **INR** as its currency (Meta stops delivering non-INR messages for Indian accounts from 1 January 2027). Add a number that is not on the WhatsApp app, display name "Hourhand".
3. Add a payment method.
4. Business settings → Users → System users: add one (Admin), assign it the WhatsApp account and the app, generate a token that never expires with `whatsapp_business_messaging` and `whatsapp_business_management`. Paste it straight into Coolify as `WHATSAPP_ACCESS_TOKEN`.
5. Meta app → WhatsApp → Configuration → Webhook: callback URL `https://hourhand.cloud/api/webhooks/whatsapp`, verify token = your `WHATSAPP_VERIFY_TOKEN`, then subscribe to `messages`. This works only after the variables are set and the app redeployed.
6. WhatsApp Manager → Message templates: create the six templates below, category **Utility**, exactly as written (the app sends these names and languages). Approval takes from minutes to a few days. Sends fail as "template not found" until each is approved; email still goes meanwhile.

Plan limits per host per calendar month (IST): Free 0, Solo 300, Duo 600 WhatsApp messages. Over the limit, email still goes. Cost at about ₹0.136 a message including GST (check your INR rate card): roughly ₹0.27 per booking.

Check after go-live: book on your own page with your phone and the WhatsApp tick; the confirmation arrives within a minute and the booking page in the dashboard says "Confirmation: sent automatically". Reply STOP from that phone: you get one reply, and the dashboard shows the reminder won't go.

### Book over WhatsApp (3.4)

Clients message the same number ("Book with priya", usually pre-filled by the host's wa.me link) and get the host's event types, then the next free times (in the zone their country code suggests, with "Change time zone"), then a link to the booking page with that time. Nothing is booked over WhatsApp: payment, questions and consent happen on the page as before. Migration `0038` adds the tables.

| Variable | Value | Required |
| --- | --- | --- |
| `WHATSAPP_DISPLAY_NUMBER` | Hourhand's WhatsApp number with country code, e.g. `918000012345` (the number clients see, not the Phone number ID) | for hosts' wa.me links and QR codes |

Steps (you):

1. Set `WHATSAPP_DISPLAY_NUMBER` in Coolify and redeploy.
2. Meta app → WhatsApp → Configuration → Webhook fields: `messages` must be subscribed (step 5 above already does this; the same field carries clients' messages and taps).
3. Add a payment method if you haven't (step 3): without one Meta stops delivering replies once the 1,000 free service messages of the month are used.
4. Turn it on for your own account (Dashboard → Integrations → WhatsApp → Turn on), message the link from your phone, and walk through to the booking page.

Only hosts on Solo or Duo who turned it on are offered; a client is never shown a list of hosts. Text that names no host gets the opening question only when it asks to book ("book", "booking", "बुक"); anything else, like "ok thanks" to a reminder, gets no reply. Replies go only inside Meta's 24-hour customer service window (we only ever answer a message), so no templates are needed. STOP works as before, and an opted-out number gets no booking replies. Each phone gets at most 20 answered messages per 10 minutes. We keep each phone's step for a day (host, event type, zone; never message text) and daily counts per host in `whatsapp_booking_counts`.

Cost (Meta pricing from 1 October 2026): replies are service messages, free for the first 1,000 a month per number, then ₹0.115 each before GST (about ₹0.136 with 18% GST). A full booking conversation is 3 replies (2 when the host has one event type): ₹0 inside the free tier, about ₹0.41 after it. Check the INR rate card in WhatsApp Manager.

### Templates to submit

#### hh_booking_confirmed (en)

```json
{
  "name": "hh_booking_confirmed",
  "language": "en",
  "category": "utility",
  "components": [
    {
      "type": "body",
      "text": "Hi {{1}}, your {{2}} with {{3}} is booked for {{4}}. Use the button below to reschedule or cancel.",
      "example": {
        "body_text": [
          [
            "Kiran",
            "Coaching",
            "Priya Raman",
            "Tuesday, 3 November 2026, 10:00 am IST"
          ]
        ]
      }
    },
    {
      "type": "buttons",
      "buttons": [
        {
          "type": "url",
          "text": "Manage booking",
          "url": "https://hourhand.cloud/b/{{1}}",
          "example": [
            "https://hourhand.cloud/b/3f9c2a7d41e8b6c0"
          ]
        }
      ]
    }
  ]
}
```

#### hh_booking_confirmed (hi)

```json
{
  "name": "hh_booking_confirmed",
  "language": "hi",
  "category": "utility",
  "components": [
    {
      "type": "body",
      "text": "नमस्ते {{1}}, {{3}} के साथ आपका {{2}} {{4}} के लिए बुक हो गया है। समय बदलने या रद्द करने के लिए नीचे का बटन दबाएँ।",
      "example": {
        "body_text": [
          [
            "Kiran",
            "Coaching",
            "Priya Raman",
            "मंगलवार, 3 नवंबर 2026, 10:00 am IST"
          ]
        ]
      }
    },
    {
      "type": "buttons",
      "buttons": [
        {
          "type": "url",
          "text": "बुकिंग देखें",
          "url": "https://hourhand.cloud/b/{{1}}",
          "example": [
            "https://hourhand.cloud/b/3f9c2a7d41e8b6c0"
          ]
        }
      ]
    }
  ]
}
```

#### hh_booking_reminder (en)

```json
{
  "name": "hh_booking_reminder",
  "language": "en",
  "category": "utility",
  "components": [
    {
      "type": "body",
      "text": "Hi {{1}}, a reminder: your {{2}} with {{3}} is on {{4}}. Use the button below to reschedule or cancel.",
      "example": {
        "body_text": [
          [
            "Kiran",
            "Coaching",
            "Priya Raman",
            "Tuesday, 3 November 2026, 10:00 am IST"
          ]
        ]
      }
    },
    {
      "type": "buttons",
      "buttons": [
        {
          "type": "url",
          "text": "Manage booking",
          "url": "https://hourhand.cloud/b/{{1}}",
          "example": [
            "https://hourhand.cloud/b/3f9c2a7d41e8b6c0"
          ]
        }
      ]
    }
  ]
}
```

#### hh_booking_reminder (hi)

```json
{
  "name": "hh_booking_reminder",
  "language": "hi",
  "category": "utility",
  "components": [
    {
      "type": "body",
      "text": "नमस्ते {{1}}, याद दिला दें: {{3}} के साथ आपका {{2}} {{4}} को है। समय बदलने या रद्द करने के लिए नीचे का बटन दबाएँ।",
      "example": {
        "body_text": [
          [
            "Kiran",
            "Coaching",
            "Priya Raman",
            "मंगलवार, 3 नवंबर 2026, 10:00 am IST"
          ]
        ]
      }
    },
    {
      "type": "buttons",
      "buttons": [
        {
          "type": "url",
          "text": "बुकिंग देखें",
          "url": "https://hourhand.cloud/b/{{1}}",
          "example": [
            "https://hourhand.cloud/b/3f9c2a7d41e8b6c0"
          ]
        }
      ]
    }
  ]
}
```

#### hh_booking_changed (en)

```json
{
  "name": "hh_booking_changed",
  "language": "en",
  "category": "utility",
  "components": [
    {
      "type": "body",
      "text": "Hi {{1}}, your {{2}} with {{3}} has changed: {{4}}. Use the button below for details.",
      "example": {
        "body_text": [
          [
            "Kiran",
            "Coaching",
            "Priya Raman",
            "it is now on Tuesday, 3 November 2026, 10:00 am IST"
          ]
        ]
      }
    },
    {
      "type": "buttons",
      "buttons": [
        {
          "type": "url",
          "text": "View booking",
          "url": "https://hourhand.cloud/b/{{1}}",
          "example": [
            "https://hourhand.cloud/b/3f9c2a7d41e8b6c0"
          ]
        }
      ]
    }
  ]
}
```

#### hh_booking_changed (hi)

```json
{
  "name": "hh_booking_changed",
  "language": "hi",
  "category": "utility",
  "components": [
    {
      "type": "body",
      "text": "नमस्ते {{1}}, {{3}} के साथ आपके {{2}} में बदलाव हुआ है: {{4}}। जानकारी के लिए नीचे का बटन दबाएँ।",
      "example": {
        "body_text": [
          [
            "Kiran",
            "Coaching",
            "Priya Raman",
            "अब यह मंगलवार, 3 नवंबर 2026, 10:00 am IST को है"
          ]
        ]
      }
    },
    {
      "type": "buttons",
      "buttons": [
        {
          "type": "url",
          "text": "बुकिंग देखें",
          "url": "https://hourhand.cloud/b/{{1}}",
          "example": [
            "https://hourhand.cloud/b/3f9c2a7d41e8b6c0"
          ]
        }
      ]
    }
  ]
}
```

## 5d. SMS (roadmap 1.2: booking texts through MSG91 and DLT)

Off until every variable below is set. With any missing, nothing is queued, nothing is sent, and the booking form doesn't offer texts. Migration `0030` adds the opt-in, the short-link code and the opt-out table either way.

Who gets texts: a guest who gives an **Indian mobile** (+91, starting 6–9) and ticks "Text me booking updates by SMS", on a host whose plan includes texts. They get four texts: booking confirmed, a reminder a day ahead, cancelled and rescheduled. Each text has a short link (`https://hourhand.cloud/m/<12-character code>`) that opens the booking's manage page. Guests with other numbers get email, and WhatsApp if they ticked it. If a guest ticks both WhatsApp and SMS, the message goes on WhatsApp. A text is sent only when that WhatsApp message can't go (the guest isn't on WhatsApp, Meta refuses it, it's reported undelivered, or the host is over their WhatsApp limit). The same message never goes on both channels. Guests can turn texts off, and back on, on the manage page.

| Variable | Value | Required for SMS |
| --- | --- | --- |
| `SMS_PROVIDER` | `msg91` | yes |
| `MSG91_AUTH_KEY` | MSG91 → API → Auth key | yes |
| `MSG91_SENDER_ID` | your 6-letter DLT header, capitals (e.g. `HRHAND`) | yes |
| `MSG91_TEMPLATE_BOOKED` | MSG91's template id (24 characters) for the English "booking confirmed" template | yes |
| `MSG91_TEMPLATE_REMINDER` | same, English reminder | yes |
| `MSG91_TEMPLATE_CANCELLED` | same, English cancelled | yes |
| `MSG91_TEMPLATE_RESCHEDULED` | same, English rescheduled | yes |
| `MSG91_TEMPLATE_BOOKED_HI` and the other three with `_HI` | MSG91's ids for the Hindi templates | no: Hindi guests get English until set |
| `MSG91_WEBHOOK_SECRET` | any long random string you make up; type the same one in step 6 | yes |

Set them in Coolify as **Runtime** variables, not Build variables, then redeploy.

#### Sign-in by phone (optional): `MSG91_TEMPLATE_OTP`

Hosts can sign in, or sign up, with an Indian mobile number and a 6-digit code by text. It needs `SMS_PROVIDER=msg91` and `MSG91_AUTH_KEY` (above) plus one more DLT template, registered in the **Service Implicit (OTP)** category under the same header. Phone sign-in doesn't need the four booking templates. Until `MSG91_TEMPLATE_OTP` is set, the sign-in page doesn't offer it.

Register this text word for word (MSG91 shows the slot as `##VAR1##`, the DLT portal as `{#var#}`):

```
{#var#} is your Hourhand sign-in code. It expires in 5 minutes. Do not share it with anyone.
```

| Variable | Value | Required for phone sign-in |
| --- | --- | --- |
| `MSG91_TEMPLATE_OTP` | MSG91's template id for the OTP template above | yes |

Limits: 3 codes per number and 10 per client address every 10 minutes, and 3 tries per code. Each code is a paid text. A host who signs up by phone has a placeholder email (`<digits>@phone.invalid`) until they add one. No email is sent to that address, so booking and reminder emails for that host stay unsent until a real address is on the account. Run `npm run db:migrate` before deploying (migration 0053 adds `users.phone_number`).

Steps (you; Claude never signs in to a DLT portal or MSG91):

1. **DLT entity.** On one operator's DLT portal (Jio TrueConnect, Airtel, Vi, BSNL, Tata, SmartPing/Videocon or PingConnect; any one covers all networks), register Marvice Media Private Limited as a Principal Entity (PE). You need the PAN, GST certificate, a letter of authorisation and the signatory's ID. You get a 19-digit Entity ID. MSG91 lists portal fees of about ₹5,000 + GST and also says PingConnect is free; check the portal before you pay.
2. **Header.** Register a 6-letter header (sender ID) in the **Service Implicit** category, e.g. `HRHAND`. These are booking updates for a service the guest asked for, which TRAI allows without separate consent. "Transactional" only covers texts sent within 30 minutes of the guest's own action, so reminders wouldn't qualify. Operators show it to the guest as e.g. `VM-HRHAND-S`.
3. **URL whitelisting.** On the same portal, whitelist `https://hourhand.cloud/m/`. Since 1 October 2024, operators drop texts with links that aren't whitelisted.
4. **Content templates.** Register the eight templates below as **Service Implicit**, linked to your header, with exactly the text shown (Hindi as Unicode). Each has three `{#var#}` slots, TRAI's default allowance; each slot carries at most 30 characters. Note each template's DLT Template ID.
5. **Telemarketer binding.** Bind your Entity ID to MSG91 on the portal (PE–TM chain): Walkover Web Solutions Pvt. Ltd, TM ID `1302157225275643280` (from MSG91's help page; confirm it in your MSG91 panel). Since 11 December 2024, texts without a complete PE–TM chain are rejected.
6. **MSG91.** Create an account and add your Entity ID and header. Add each template under SMS → Templates, pasting the DLT text with the slots renamed `##VAR1##`, `##VAR2##` and `##VAR3##` in order, and the DLT Template ID. Copy MSG91's template id of each into the variables above. Then go to Webhook (New), event "On Report Received", URL `https://hourhand.cloud/api/webhooks/sms`, and add a custom header `x-hourhand-secret` set to your `MSG91_WEBHOOK_SECRET`. MSG91 doesn't sign its webhooks, so this header is what keeps others from posting fake reports. If a header can't be added, use the URL `https://hourhand.cloud/api/webhooks/sms?secret=<your secret>`.
7. Recharge MSG91 credits.

Plan allowance per host per calendar month (IST): Free 0, Solo 100, Duo 200 texts. Over it, the text is skipped and email still goes. A Hindi text counts as one text against the allowance but MSG91 bills it by segment (up to 3).

Opt-out: the manage page has an on/off switch for each booking. A delivery report saying a number is blocked (MSG91 status 17, or 9 NDNC) adds it to `sms_opt_outs`, and that number gets no more texts from any host. To block a number by hand: `insert into sms_opt_outs (phone, source) values ('91XXXXXXXXXX', 'manual');`.

Check after go-live: book on your own page with your Indian mobile and the SMS tick (not WhatsApp). The confirmation text arrives within a minute, its link opens the booking, and the `notifications` row for it gets a `delivered_at`. Turn texts off on the manage page: the reminder row turns `skipped`.

### SMS templates to register

The texts the app sends. `docs/deploy.md` is checked against `src/lib/sms/templates.ts` by a test, so the two can't drift apart. If the site moves off hourhand.cloud, register new templates with the new address.

#### Booking confirmed (English): `MSG91_TEMPLATE_BOOKED`

```
Your {#var#} is booked for {#var#}. To change or cancel: https://hourhand.cloud/m/{#var#}
```

Fixed text 76% of the template. Longest real text: 133 GSM characters, 1 segment.

#### Booking confirmed (Hindi): `MSG91_TEMPLATE_BOOKED_HI`

```
आपका {#var#} {#var#} के लिए बुक है। बदलने या रद्द करने के लिए: https://hourhand.cloud/m/{#var#}
```

Fixed text 78% of the template. Longest real text: 139 Unicode characters, 3 segments.

#### Day-ahead reminder (English): `MSG91_TEMPLATE_REMINDER`

```
Reminder: your {#var#} is on {#var#}. To change or cancel: https://hourhand.cloud/m/{#var#}
```

Fixed text 77% of the template. Longest real text: 135 GSM characters, 1 segment.

#### Day-ahead reminder (Hindi): `MSG91_TEMPLATE_REMINDER_HI`

```
याद दिला दें: आपका {#var#} {#var#} को है। बदलने या रद्द करने के लिए: https://hourhand.cloud/m/{#var#}
```

Fixed text 79% of the template. Longest real text: 145 Unicode characters, 3 segments.

#### Cancelled (English): `MSG91_TEMPLATE_CANCELLED`

```
Your {#var#} on {#var#} is cancelled. To book again: https://hourhand.cloud/m/{#var#}
```

Fixed text 75% of the template. Longest real text: 129 GSM characters, 1 segment.

#### Cancelled (Hindi): `MSG91_TEMPLATE_CANCELLED_HI`

```
{#var#} का आपका {#var#} रद्द हो गया है। फिर से बुक करने के लिए: https://hourhand.cloud/m/{#var#}
```

Fixed text 78% of the template. Longest real text: 140 Unicode characters, 3 segments.

#### Rescheduled (English): `MSG91_TEMPLATE_RESCHEDULED`

```
Your {#var#} has moved to {#var#}. To change or cancel: https://hourhand.cloud/m/{#var#}
```

Fixed text 76% of the template. Longest real text: 132 GSM characters, 1 segment.

#### Rescheduled (Hindi): `MSG91_TEMPLATE_RESCHEDULED_HI`

```
आपका {#var#} अब {#var#} को है। बदलने या रद्द करने के लिए: https://hourhand.cloud/m/{#var#}
```

Fixed text 77% of the template. Longest real text: 134 Unicode characters, 2 segments.

## 5c. Custom domains (roadmap 1.1: book.coachname.com)

Hosts on Solo or Duo buy the **Custom domain add-on** (₹199 + 18% GST = ₹234.82 a month) and serve their booking pages at their own domain. It costs nothing extra to run: certificates come from the same Coolify Traefik that serves hourhand.cloud, through one small config file per domain that the app writes. No Cloudflare.

Until `TRAEFIK_DYNAMIC_DIR` and `HOURHAND_UPSTREAM_URL` are set, the Custom domain page says "Custom domains are not set up on this server" and nothing can be bought or added; the rest of Hourhand is unaffected. Migrations `0027` (domains) and `0028` (add-on subscriptions) run on deploy either way.

**1. DNS at Hostinger (hourhand.cloud's DNS).** Add one record. Hosts point their domains at this name, so it must exist before anyone can verify.

| Type | Name | Value |
| --- | --- | --- |
| A | `domains` | your Coolify server's public IPv4 (the same IP as `@`) |

Check: `dig +short domains.hourhand.cloud` prints the IP.

**2. Razorpay Plan.** Razorpay → Subscriptions → Plans → Create: name "Hourhand Custom domain", **₹199**, monthly, every 1 month. It's set before tax, like the other plans; GST is invoiced at 18% on top, so the host pays ₹234.82. Test mode first, then live. Copy the Plan id (`plan_…`) into `RAZORPAY_PLAN_DOMAIN_MONTH`. The webhook is the existing one (`subscription.*`), and no change is needed.

**3. Let the app write into Traefik's dynamic folder.** On the server (SSH, once):

```sh
ls /data/coolify/proxy/dynamic            # Coolify's own files are here; Traefik watches this folder
sudo apt-get install -y acl               # if setfacl is missing
sudo setfacl -m u:1000:rwx /data/coolify/proxy/dynamic   # the app runs as user "node" (uid 1000)
```

This gives the app write access without changing who owns the folder or Coolify's files. The app only ever creates, rewrites or deletes files named `hourhand-domain-<hash>.yaml`.

**4. Coolify → app → Persistent storage → Add → Directory mount:** source `/data/coolify/proxy/dynamic`, destination `/traefik-dynamic`.

**5. A fixed container name for Traefik to reach.** Coolify → app → Advanced: set **Custom container name** to `hourhand-app` (or turn on "Consistent container name" and use the name it shows; the exact label differs between Coolify versions, so check `docker ps` after the next deploy shows the same name as before). Without it, the name changes on every deploy and the domain files would point nowhere.

**6. Environment variables** (Coolify → app → Environment). Mark each one **Runtime only**, never "Build Variable": production broke once before because keys were set for the build only, and the running server never saw them.

| Name | Value |
| --- | --- |
| `TRAEFIK_DYNAMIC_DIR` | `/traefik-dynamic` |
| `HOURHAND_UPSTREAM_URL` | `http://hourhand-app:3000` |
| `RAZORPAY_PLAN_DOMAIN_MONTH` | the Plan id from step 2 |

Then **Redeploy**. The log should **not** contain `Custom domains are not set up on this server`.

**7. Check it end to end** (with a domain you own, on a Solo test account):

1. `docker exec coolify-proxy wget -qO- http://hourhand-app:3000/api/health` returns `{"ok":true…}`. If it doesn't, Traefik can't reach the app by that name: fix step 5.
2. Dashboard → Custom domain → Add custom domain → pay in Razorpay test mode. Within a minute the card says Active.
3. Add `book.yourdomain.com`. At your DNS provider, create a CNAME `book` → `domains.hourhand.cloud`. Click Check now until it says **Active**.
4. `ls /data/coolify/proxy/dynamic` shows a `hourhand-domain-….yaml`. Within about a minute Traefik's log shows the Let's Encrypt certificate, and `https://book.yourdomain.com` shows your booking page. `/dashboard` there redirects to hourhand.cloud.
5. Cancel the add-on. The domain keeps working to the end of the paid month. After that, within 5 minutes the file is deleted and the domain redirects to `hourhand.cloud/<slug>`.

How it runs: every 5 minutes the job runner re-checks DNS (pending and failed domains every 5 minutes, active ones every 30) and makes the folder match the domains that should serve. A domain serves only while DNS is verified, the add-on is active and the host is on a paid plan. A DNS lookup that times out never takes a live domain down; a record that's gone or pointing elsewhere does, and the host sees why.

Watch: `[domains]` lines in the app log. Let's Encrypt allows 50 certificates per registered domain a week and 300 new orders per 3 hours per account, far above what this needs.

## 5d. Stripe Connect (roadmap 1.4: hosts outside India take payment through their own Stripe)

Do all of this in a **Stripe sandbox first**, then repeat it in live mode.

1. **Stripe Dashboard → Connect → Get started.** Choose the platform / SaaS setup, where hosts run their own businesses and accept their own payments. Fill in the Connect branding (business name, icon, brand colour); Stripe's hosted onboarding won't open without it. Hourhand creates accounts with Accounts v2 and the full Stripe Dashboard, so no OAuth client id is needed.
2. **Workbench → Webhooks → Add destination**, **Events from: Connected accounts**, URL `https://hourhand.cloud/api/webhooks/stripe-connect`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `account.updated`, `account.application.deauthorized`. Copy its signing secret. This is a different endpoint and secret from the plans webhook (`/api/webhooks/stripe`, Your account).
3. **Coolify env (Runtime only, never build-time):** `STRIPE_SECRET_KEY` (the sandbox key first; a restricted key also works if it can write Accounts v2, Account Links, Checkout Sessions and Refunds) and `STRIPE_CONNECT_WEBHOOK_SECRET`. Redeploy. The log line should end `Stripe on)`.
4. **Test end to end in the sandbox:** sign in as a host on a paid plan, then Integrations → Stripe → pick a country → Connect Stripe → finish onboarding with Stripe's test data. The card shows "Taking payments" and the currency. Set a price on an event type and book it as a guest with card `4242 4242 4242 4242`. The booking confirms, the host sees "paid", and Stripe emails the receipt. Cancel it and the guest is refunded in the connected account's Dashboard. Try a package and a no-show deposit the same way.
5. **Live:** swap in the live secret key and the live endpoint's signing secret. Connected accounts made in the sandbox don't carry over; hosts connect again.

Production webhook endpoints for Connect receive both live and test events. Test events that don't match anything here are acknowledged and ignored.

## 6. Microsoft Entra (for B6: Outlook, Teams links, Sign in with Microsoft)

Done 2026-10-13: the Entra app is registered and `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` are set in Coolify for production. Verified the same day: Outlook connected from the dashboard, and a test booking appeared in Outlook. The client secret expires in 24 months; renew it a month before.

1. [entra.microsoft.com](https://entra.microsoft.com) → App registrations → New registration. Name `Hourhand`. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
2. Redirect URI, platform **Web**: `https://hourhand.cloud/api/auth/callback/microsoft`. Then Authentication → add `https://hourhand.cloud/api/calendars/microsoft/callback`, plus `http://localhost:3000/...` versions of both for development.
3. API permissions → Microsoft Graph → Delegated: `openid`, `email`, `offline_access`, `User.Read`, `Calendars.ReadWrite`. No admin consent needed for these.
4. Certificates & secrets → New client secret (24 months). Copy the **Value** straight into Coolify as `MICROSOFT_CLIENT_SECRET`. Put a reminder in your calendar a month before it expires.
5. Overview → copy **Application (client) ID** into `MICROSOFT_CLIENT_ID`. Tenant stays `common` (no variable).
6. Branding & properties: home page `https://hourhand.cloud`, privacy `https://hourhand.cloud/privacy`, terms `https://hourhand.cloud/terms`. Later, verify the publisher (needs a Microsoft Partner ID) so users don't see "unverified" on the consent screen.
7. Token configuration → Add optional claim → token type **ID** → tick `xms_edov` → Add. This tells Hourhand that Microsoft has verified a work or school email's domain. Without it, people on work or school accounts can still connect Outlook, but must sign up with an email link rather than "Continue with Microsoft" (Hourhand won't create an account from an email Microsoft doesn't vouch for). Personal Microsoft accounts don't need it.

Teams links only work for work or school Microsoft 365 accounts; personal Outlook.com accounts get Outlook calendar sync but no Teams link.

**Action needed:** a client secret value was pasted into chat on 2026-10-11. Delete it in Entra and create a new one (step 4).

## 6b. Zoom app (2.4: a Zoom link for every Zoom booking)

Not done yet. Until `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` are set, the Zoom option still saves, the editor says "Zoom isn't set up on this server", and Zoom bookings get no link.

1. [marketplace.zoom.us](https://marketplace.zoom.us) → Develop → Build App → **General App**, **User-managed** (each host authorises their own Zoom account). Name `Hourhand`.
2. Basic Information → OAuth Information: redirect URL `https://hourhand.cloud/api/integrations/zoom/callback`. Add the same URL to the **OAuth allow list**, plus `http://localhost:3000/api/integrations/zoom/callback` for development. Copy **Client ID** and **Client Secret** into Coolify as `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET` (Runtime variables, not build-time).
3. Scopes: `meeting:write:meeting`, `meeting:update:meeting`, `meeting:delete:meeting`, `user:read:user`. Nothing else. A host who unticks one is sent back with "Zoom didn't grant the permission to create meetings".
4. Features → Access → **Event Subscription** on: add the endpoint `https://hourhand.cloud/api/webhooks/zoom`, subscribe to **App Deauthorized** (under Marketplace / App). Copy the **Secret Token** into Coolify as `ZOOM_WEBHOOK_SECRET`. Zoom checks the URL when you save it; Hourhand answers that check once the variable is set and the app redeployed.
5. Redeploy. Integrations → Connect Zoom with your own Zoom account; make a test booking on an event type set to Zoom and check the link in the confirmation email, the calendar invite and the booking page. Reschedule it (same link, new time in Zoom) and cancel it (meeting gone from Zoom).
6. Until the app is **published** on the Zoom Marketplace, only users on the Zoom account that owns the app can connect, and Zoom sends the deauthorization notice only for published apps. A handful of outside hosts can test it first through Zoom's beta sharing (Beta Test → Request to share; Zoom approves it, for limited users and time). For every host to connect, submit it for Marketplace review: listing, privacy policy (`https://hourhand.cloud/privacy`), terms, support URL, a test plan linked in the release notes, a test account, and the Technical Design Document. Sources: https://developers.zoom.us/docs/distribute/sharing-private-and-beta-apps/ and https://developers.zoom.us/docs/distribute/app-submission/common-rejection-issues/

What hosts get: each Zoom booking gets its own scheduled meeting in the host's Zoom (waiting room on, join before host off, passcode per the host's Zoom setting, topic "event name with guest name"). Group class seats share one meeting. Zoom's limit is 100 meetings created or updated per host per day.

## 7. Watch it (first week)

| What | How |
| --- | --- |
| Uptime | A monitor (Uptime Kuma on the same Coolify, or UptimeRobot free) on `https://hourhand.cloud/api/health` every minute, alerting your phone, plus one on a real booking page |
| Logs | Coolify → app → Logs. Search for `[jobs]` (email and sync failures) and `Error` |
| Failed emails | `select kind, last_error, count(*) from notifications where status = 'failed' group by 1, 2;` daily for the first week |
| Calendar health | Dashboard → Calendars sync light on your own account |
| Backups | confirm the first nightly Postgres backup landed, then restore it once into a scratch database |
| End to end | you: sign up, connect Google Calendar, create an event type, book it from your phone as a guest, cancel it. Check both emails and the calendar event |

Error tracking (Sentry or GlitchTip) isn't wired in yet; logs and the failed-email query cover the beta.

## 8. Go-live record

| | |
| --- | --- |
| Live URL | https://hourhand.cloud (not live yet: waiting for your go) |
| DNS set | (fill in after you set them) |
| First deploy commit | (fill in) |
