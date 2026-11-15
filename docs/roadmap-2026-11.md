# Hourhand build roadmap (from the competitor comparison, 2026-11-15)

Source: the "Booking tool features" comparison (Calendly, Cal.com, Zoho Bookings, Google appointment schedules, checked 15 Nov 2026).
Each item is one PR with tests, merged and deployed on its own. Effort is build time for one engineer-equivalent; "you" items are owner steps that gate go-live.

## 0. Unblock first (nothing ships until these are done)
| # | Item | Status | Owner step |
|---|---|---|---|
| 0.1 | Coolify deploy failing since the Build Variable change | open | Paste the failed deployment log |
| 0.2 | Razorpay + WhatsApp return `not_configured` in production | open | Runtime variables, then redeploy |
| 0.3 | CI deploy job gets empty `COOLIFY_WEBHOOK` / `COOLIFY_TOKEN` | parked | Repository secrets |
| 0.4 | PR #11 WhatsApp sync alert to hosts | review | Submit `hh_calendar_alert` template to Meta |

## 1. Gaps from the comparison (owner chose all four)
| # | Feature | Beats | Effort | Owner step / cost |
|---|---|---|---|---|
| 1.1 | Remove branding on paid plans + own domain (`book.coachname.com`) with automatic TLS and DNS check | Calendly has no custom domain; Cal.com only on Organizations | 2-3 days | Coolify/Traefik wildcard routing on the VPS |
| 1.2 | SMS reminders for guests without WhatsApp (DLT templates, India) | Calendly has none; Google has none | 1 day | DLT registration (2-4 weeks); MSG91 or Twilio, ~Rs 0.20-0.25 per SMS |
| 1.3 | Meeting polls: offer 3-5 times, guests vote, host confirms | Cal.com has none; Google has none | 2 days | - |
| 1.4 | Stripe for hosts outside India (UK, global), next to Razorpay | Google needs Workspace Business Standard | 1-2 days | Stripe account and keys |

## 2. Advanced features (owner asked for "much more"; picked for coaches, tutors, therapists)
| # | Feature | Why it matters | Effort |
|---|---|---|---|
| 2.1 | Booking-link importer: Calendly (token) and Cal.com (API key). Google has no API; Zoho needs a Zoho app | Removes the switching cost | 2 days |
| 2.2 | Recurring sessions for paid types and multiple durations on one event type (features.csv "should", not built) | Weekly clients are the core of coaching and tutoring | 2 days |
| 2.3 | Several named availability schedules (features.csv "should", not built) | Online vs in-clinic hours | 1.5 days |
| 2.4 | Zoom auto-links (Meet and Teams exist) | Most-used video tool for coaches | 1 day |
| 2.5 | Intake forms with conditional questions and a client file (notes, past sessions, payments) in one view | Therapists and coaches need history before a session | 3 days |
| 2.6 | Automatic follow-ups after a session: feedback form, rebook link, Google review ask, package top-up nudge | Rebooking is the revenue lever | 2 days |
| 2.7 | Earnings and no-show dashboard with GST-ready export | Hosts run small businesses | 1.5 days |

## Skipped on purpose (do not build)
Round robin, routing forms, CRM sync, SSO, SOC 2 (enterprise, sales-team products; features.csv marks them out of scope), App Store / Play apps (deferred by owner; installable web app exists), Google appointment-schedule import (no public API).

## Order
0.x, then 1.1, 1.4, 2.2, 2.1, 1.3, 2.6, 2.5, 2.4, 2.3, 2.7, then 1.2 when DLT approval lands.
