# Client data rights in Hourhand (roadmap 3.10)

> **Working draft, review with a lawyer.** Citations checked against the Gazette PDFs on meity.gov.in and the CGST Act and Rules PDFs on cbic-gst.gov.in on 15 November 2026. Nothing here is legal advice.

## Who is responsible for what

A host (a coach, therapist, consultant) decides what to collect from the people who book them and why. Under the Digital Personal Data Protection Act, 2023 (Act 22 of 2023, Gazette 11 August 2023) the host is the **Data Fiduciary** for that data and Hourhand is their **Data Processor** (s.2(i) and (k)). A processor may act only under a valid contract (s.8(2)); the "Your clients' data" section of the terms is meant to be that contract until a separate data processing agreement exists.

## What is in force today (15 November 2026)

| Instrument | Notification | In force |
| --- | --- | --- |
| DPDP Act ss.1(2), 2, 18 to 26, 35, 38 to 43, 44(1) and (3) | G.S.R. 843(E), 13 Nov 2025 | 13 Nov 2025 |
| DPDP Act s.6(9), s.27(1)(d); DPDP Rules, Rule 4 (consent managers) | G.S.R. 843(E) and 846(E), 13 Nov 2025 | 13/14 Nov 2026 |
| **DPDP Act ss.3 to 5, 6(1) to (8) and (10), 7 to 17, 28 to 34, 36, 37, 44(2); DPDP Rules 3, 5 to 16, 22, 23** | same | **about 13 May 2027 (not yet in force)** |

So notice (s.5, Rule 3), consent (s.6), the fiduciary's duties (s.8), the rights of access, erasure and grievance (ss.11 to 13), breach reporting (Rule 7) and penalties (s.33) are **not yet in force**. Hourhand builds for them now so hosts are ready. Until then IT Act s.43A and the 2011 SPDI Rules presumably still apply (inference: s.44(2), which omits s.43A, isn't in force yet).

## The features and the law they serve

| Feature | Where | Law |
| --- | --- | --- |
| Consent log: per booking, per purpose, the words shown, notice version, time, channel, language | `consent_records`, client page | s.5 notice, s.6(1) consent, s.6(10) fiduciary must prove notice and consent; s.7(a) legitimate use for the booking itself |
| Export of everything held about one client (JSON and printable HTML) | client page, `/dashboard/clients/[key]/export` | s.11 right to a summary of data and processing |
| Erasure of one client, typed confirmation, logged who/when | client page, `client_erasures` | s.8(7) and s.12(3) erasure unless retention is required by law |
| Guest asks for a copy or deletion from the manage link; host emailed; deadline shown | `data_requests`, `/dashboard/clients/requests` | s.13 grievance redressal; Rule 14(1) means to make requests; Rule 14(3) response within a reasonable period of at most 90 days |
| Private client and session notes sealed (AES-256-GCM), owner-only | `client_notes.note_sealed`, `booking_notes` | s.8(5) reasonable security safeguards; Rule 6(1)(a) encryption, (b) access control |

## Retention rule on erasure

What an erasure removes: the client's name, email, phone, answers, extra guests, WhatsApp opt-in, running-late note and manage link on every booking; cancellation reasons and location values on those bookings; private client and session notes; waitlist entries; queued messages (deleted) and the address on sent ones; package purchase name, email, phone and link; the identity on consent records and requests. Calendar events already written into the host's own Google or Microsoft calendar are outside Hourhand; the host deletes those.

What it keeps, and why:

| Kept | Rule |
| --- | --- |
| Booking rows (event, times, status), now "Erased client" | Payments and invoices reference them (CGST Act s.35 accounts of supplies). No personal data remains in them. |
| Payment rows (amount, status, Razorpay payment id) | CGST Act s.35(1) and s.36; Income-tax books of account (see below). No name or contact. |
| GST invoices and credit notes: number, date, supplier, place of supply (recipient's State), description, SAC, rate, amounts | CGST Act s.36: keep for 72 months from the due date of the annual return for the year (longer during an appeal or investigation). CGST Rules r.46 particulars; proviso to r.46(f) and CBIC Circular 242/36/2024-GST para 4.5.1: the recipient's State is mandatory for online services. |
| Invoice buyer **name**, only when the taxable value is ₹50,000 or more | CGST Rules r.46(e): name and address of an unregistered recipient are mandatory at or above ₹50,000. Below that (r.46(f)) they are required only if the recipient asked, so the name is anonymised. |
| Invoice buyer **email**: always removed | Not an invoice particular under r.46. |
| A log line per changed invoice (`invoice_redactions`: fields changed, not values) | CGST Rules r.56(8): electronic records keep a log of every edit or deletion. |
| The erasure log (`client_erasures`: host, who, when) | DPDP Rules r.8(3) and Seventh Schedule: keep processing logs at least one year. It never records whom. |
| Consent records without the identity | Proof that notice was given and consent obtained (s.6(10)), without identifying anyone. |

Income tax: the Income-tax Act, 1961 s.44AA and Rule 6F (6 years) applied to earlier years; the Income-tax Act, 2025 reportedly applies from 1 April 2026 with its own rules (one secondary source says 7 tax years). **Unverified from primary sources**; Hourhand keeps no personal data in payment rows, so the erasure doesn't depend on it.

An erasure is refused while the client has an upcoming confirmed booking or a payment hold (cancel first) or a payment, refund or package payment still settling (wait), so a refund is never orphaned.

## Deadline shown to hosts and guests

`RESPONSE_DAYS = 90` in `src/lib/privacy/rights.ts`, from Rule 14(3). The Rules set no shorter limit for access or erasure requests specifically. Hosts are told to act well before; a lawyer may advise a shorter published period.

## Clauses for the lawyer

1. Whether the terms section "Your clients' data" is enough as the s.8(2) contract, or a separate DPA is needed (sub-processors, audit, deletion at end of contract).
2. Whether anonymising buyer name/email on an issued invoice (logged per r.56(8)) is acceptable, versus keeping the invoice as issued until the s.36 period ends and erasing then.
3. Notice under s.5 and Rule 3: the booking form currently links the privacy policy in its footer but shows no inline notice next to the submit button. Rule 3 asks for a standalone notice with an itemised description; decide the wording, then it goes into all five booking languages.
4. Whether the booking itself rests on s.7(a) legitimate use (as recorded) rather than consent.
5. The 90-day response period, and whether hosts must publish their own period (Rule 14(3)).
6. Who notifies affected guests after a breach of Hourhand's systems (Rule 7(1)): the host as fiduciary, with Hourhand's report, or Hourhand on the host's behalf.
7. Retention of `webhook_events` payloads from Razorpay (may hold a payer's email or phone), not touched by a client erasure.
