# Personal data breach: incident note (owner-facing)

> **Working draft, review with a lawyer.** For Hourhand's owners and on-call engineer. DPDP Act 2023 s.8(6) and DPDP Rules 2025 Rule 7 are **not in force until about 13 May 2027**; until then IT Act s.43A and the CERT-In Directions of 28 April 2022 (report cyber incidents within 6 hours) apply. Follow this template now so the habit is in place.

Copy this file to `incidents/YYYY-MM-DD-short-name.md` in a private place (not this repository). Fill it in as you go; timestamps in IST.

## 1. First hour

- [ ] Detected at: ____ by: ____ how: ____
- [ ] Contained (what was shut off, rotated or blocked): ____
- [ ] Secrets rotated if exposed: database password, `BETTER_AUTH_SECRET`, Resend, Razorpay, WhatsApp, Google/Microsoft OAuth. **`TOKEN_ENCRYPTION_KEY` cannot simply be rotated**: sealed calendar tokens, Razorpay keys and notes would become unreadable. If the key itself leaked, plan a re-seal with both keys before switching.
- [ ] Evidence preserved (server and Coolify logs, database snapshot, access logs): ____
- [ ] Incident lead: ____ Second person: ____

## 2. What happened

| Item | Answer |
| --- | --- |
| Nature (unauthorised access, disclosure, loss, alteration, unavailability) | |
| When it started / when it ended | |
| Where (server, database, backup, third party) | |
| Data affected (host accounts, guest bookings, answers, notes, payments, invoices) | |
| Were private notes affected? Was `TOKEN_ENCRYPTION_KEY` exposed? (Sealed notes are unreadable without it.) | |
| Hosts affected (count) / guests affected (count) | |
| Likely consequences for the people affected | |
| Cause, and who caused it if known | |

## 3. Who to tell

Hosts are the data fiduciaries for their guests' data; Hourhand is their processor and must tell each affected host without delay (terms: "Your clients' data").

| To | When | Status |
| --- | --- | --- |
| CERT-In (incident@cert-in.org.in) | within 6 hours of noticing (CERT-In Directions, 28 Apr 2022) | |
| Each affected host | without delay, with section 4 filled in so they can inform their guests | |
| Data Protection Board, intimation (Rule 7(2)(a)) | without delay (from May 2027) | |
| Data Protection Board, detailed report (Rule 7(2)(b)) | within 72 hours of becoming aware, or longer if the Board allows in writing (from May 2027) | |
| Affected hosts as Hourhand's own data principals (Rule 7(1)) | without delay | |
| Affected guests | by their host as fiduciary, or by Hourhand on the host's request (see clause 6 for the lawyer) | |

## 4. Message to affected people (Rule 7(1) contents)

> On [date] we found that [what happened, plainly]. It affected [what data] between [dates]. This could mean [likely consequences]. We have [what we did to stop it and reduce harm]. You can [steps they can take, e.g. watch for phishing emails that use your booking details]. For questions, contact Yuvaraj G S, grievance officer, Yuvarajgs@marvice.in, +91 78456 67204.

## 5. Board detailed report (Rule 7(2)(b) contents)

- Updated description of the nature, extent, timing and location
- Facts and circumstances, and the reasons it happened
- Measures taken or proposed to mitigate the risk
- Findings on who caused it
- Remedial steps to stop it happening again
- Report on the intimations given to affected people

## 6. Afterwards

- [ ] Root cause written up, fix merged, test added
- [ ] Keep this note and the logs for at least one year (DPDP Rules r.8(3) and Seventh Schedule)
- [ ] Review: what would have caught this sooner?
