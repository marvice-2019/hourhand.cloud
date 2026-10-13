# Hourhand: keys, APIs and where everything lives

Checked against the code on 2026-10-13 (`main` 74cdf83). **This file holds names and places only, never values.** Values live in Coolify (production and staging, set separately) and in your password manager.

## 1. Environment variables (Coolify → app → Environment Variables)

Mark every variable "runtime only"; the build needs none.

| Variable | What it is | Where the value comes from | Status |
| --- | --- | --- | --- |
| `DATABASE_URL` | Postgres connection | Coolify → the database resource → connection string (internal) | Set |
| `HOURHAND_DATA` | `postgres` | Fixed value | Set |
| `BETTER_AUTH_URL` | `https://hourhand.cloud` (staging: `https://staging.hourhand.cloud`) | Fixed value | Set |
| `BETTER_AUTH_SECRET` | Signs sign-in sessions | `openssl rand -hex 32`, once | Set |
| `TOKEN_ENCRYPTION_KEY` | Seals calendar tokens and hosts' Razorpay keys. **Never change it**: a new key disconnects every calendar | `openssl rand -hex 32`, once; keep in the password manager | Set |
| `RESEND_API_KEY` | Sends all email | resend.com → API Keys (sending access, domain hourhand.cloud) | Set |
| `EMAIL_FROM` | `Hourhand <booking@hourhand.cloud>` | Fixed value | Set |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in and Google Calendar | console.cloud.google.com → APIs & Services → Credentials → OAuth client (Web) | Set |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | Microsoft sign-in, Outlook, Teams links | entra.microsoft.com → App registrations → Hourhand (secret expires after 24 months, about October 2028) | Set |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Hourhand's own plan billing (live) | dashboard.razorpay.com → Account & Settings → API Keys (live mode) | Set |
| `RAZORPAY_WEBHOOK_SECRET` | Verifies Razorpay webhooks | Razorpay → Webhooks → the hourhand.cloud webhook → secret you chose | Set |
| `RAZORPAY_PLAN_SOLO_MONTH`, `RAZORPAY_PLAN_SOLO_YEAR`, `RAZORPAY_PLAN_DUO_MONTH`, `RAZORPAY_PLAN_DUO_YEAR` | The 4 live plan IDs (`plan_…`): ₹470.82, ₹4,708.20, ₹706.82, ₹7,068.20 including GST | Razorpay → Subscriptions → Plans | Set |
| `WHATSAPP_PHONE_NUMBER_ID` | The Hourhand WhatsApp number | WhatsApp Manager → Phone numbers | Set |
| `WHATSAPP_ACCESS_TOKEN` | Permanent system-user token | Business settings → System users → Generate token (never expires) | Set |
| `WHATSAPP_APP_SECRET` | Verifies Meta webhooks | Meta app → App settings → Basic | Set |
| `WHATSAPP_VERIFY_TOKEN` | Webhook handshake string | Made up by you; same string in Meta → Webhook | Set |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_SOLO_MONTH`, `STRIPE_PRICE_SOLO_YEAR`, `STRIPE_PRICE_DUO_MONTH`, `STRIPE_PRICE_DUO_YEAR` | USD billing (UK, Gulf) | dashboard.stripe.com | Not set yet, on purpose |
| `TRUSTED_PROXIES` | Proxy address ranges for rate limits | Only if Cloudflare is put in front | Leave unset |

**Never set in production** (testing only): `HOURHAND_ALLOW_MEMORY`, `HOURHAND_MAIL_TO_LOG`, `HOURHAND_E2E`, `HOURHAND_WORKER`, `TEST_DATABASE_URL`, `GOOGLE_API_BASE_URL`, `MICROSOFT_LOGIN_BASE_URL`, `MICROSOFT_GRAPH_BASE_URL`, `RAZORPAY_API_BASE_URL`, `STRIPE_API_BASE_URL`, `WHATSAPP_API_BASE_URL`, `ICLOUD_CALDAV_URL`, `RAZORPAY_STATUS`, `STRIPE_STATUS`, `RAZORPAY_FEE_BP`.

Staging uses its own database, **test** Razorpay keys and plan IDs, and no WhatsApp variables.

## 2. External services and what each one needs registered

| Service | Account / console | Registered on their side | Hourhand calls |
| --- | --- | --- | --- |
| Resend (email) | resend.com | Domain `hourhand.cloud` verified (SPF, DKIM, DMARC records at Hostinger DNS) | Send email API |
| Google Cloud | console.cloud.google.com | Redirect URIs `https://hourhand.cloud/api/auth/callback/google` and `https://hourhand.cloud/api/calendars/google/callback`; authorized domain `hourhand.cloud`; scopes `calendar.calendarlist.readonly`, `calendar.events.freebusy`, `calendar.events.owned`. Verification submitted, pending; until then only listed test users (max 100) | Google sign-in, Calendar API (free/busy, events, push notifications to `/api/webhooks/google-calendar`) |
| Microsoft Entra | entra.microsoft.com | Redirect URIs `https://hourhand.cloud/api/auth/callback/microsoft` and `https://hourhand.cloud/api/calendars/microsoft/callback`; delegated `openid`, `email`, `offline_access`, `User.Read`, `Calendars.ReadWrite`; optional claim `xms_edov`. Publisher verification not done yet | Microsoft sign-in, Microsoft Graph (calendar, Teams links) |
| Razorpay | dashboard.razorpay.com | Webhook `https://hourhand.cloud/api/webhooks/razorpay`, events `subscription.*`; 4 live plans; GST details for Marvice Media Private Limited (GSTIN 33AAMCM6642H1ZB) | Subscriptions API. Hosts' booking payments use each host's own Razorpay keys, entered in their dashboard |
| Meta WhatsApp Cloud API | business.facebook.com, developers.facebook.com | Webhook `https://hourhand.cloud/api/webhooks/whatsapp`, subscribed to `messages`; 6 utility templates (`hh_booking_confirmed`, `hh_booking_reminder`, `hh_booking_changed`, each English and Hindi); business verification submitted | Messages API (send template) |
| Stripe (later) | dashboard.stripe.com | Webhook `https://hourhand.cloud/api/webhooks/stripe` | Billing API |
| iCloud | none | Nothing: each host enters their own Apple ID app-specific password | CalDAV |
| Hostinger | hpanel.hostinger.com | DNS for hourhand.cloud: A records for `@`, `www`, `staging`, `status`; Resend email records; Google site verification TXT | — |
| Coolify | coolify.marvice.tech | Production and staging apps from `marvice-2019/hourhand.cloud`, Dockerfile, base directory `/`; Postgres; daily backups to Cloudflare R2 | — |
| Cloudflare R2 | dash.cloudflare.com | Bucket and access key for backups (stored in Coolify → S3 Storage, not in the app) | — |
| Uptime Kuma, UptimeRobot | status.hourhand.cloud, uptimerobot.com | Monitors on `https://hourhand.cloud/api/health` | — |

## 3. Hourhand's own API (all under https://hourhand.cloud)

| Route | Method | Used by |
| --- | --- | --- |
| `/api/health` | GET | Monitors and Docker healthcheck; `{"ok":true}` or 503 if the database is down |
| `/api/auth/[...]` | GET, POST | Sign-in (email link, Google, Microsoft) |
| `/api/slots` | GET | Booking page: free times |
| `/api/bookings` | POST | Booking page: create a booking |
| `/api/bookings/pay` | POST | Booking page: pay for a booking |
| `/api/b/[token]/cancel`, `/reschedule`, `/late` | POST | Guest manage link |
| `/api/waitlist` | POST | Booking page: join the waitlist |
| `/api/packages/[id]/buy`, `/api/packages/pay` | POST | Session packages |
| `/api/photo/[slug]` | GET | Host profile photo |
| `/api/calendars/google/connect`, `/callback` | GET | Connect Google Calendar |
| `/api/calendars/microsoft/connect`, `/callback` | GET | Connect Outlook |
| `/api/webhooks/razorpay` | POST | Razorpay (signed) |
| `/api/webhooks/stripe` | POST | Stripe (signed) |
| `/api/webhooks/whatsapp` | GET, POST | Meta (verify token, then signed) |
| `/api/webhooks/google-calendar` | POST | Google Calendar push |
| `/embed.js` | GET | Booking widget on hosts' own sites |

## 4. Renewals and rotations

| What | When | Action |
| --- | --- | --- |
| Microsoft client secret | ~September 2028 (a month before expiry) | New secret in Entra → update Coolify → Redeploy |
| Backup restore test | Monthly, 1st, 11:00 IST (calendar event) | Restore the latest R2 backup into a scratch database |
| Any key pasted in a chat or email | Immediately | Revoke it at the provider, create a new one, update Coolify, Redeploy |
| `TOKEN_ENCRYPTION_KEY` | Never | Changing it disconnects every calendar and host Razorpay key |
