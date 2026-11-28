# B19: Ask a question (paid written questions, like Topmate's Priority DM)

## What it does

A host can let guests send one written question, paid or free, and answer it in writing. The guest gets the answer by email
and on a private page. Off for every host until they turn it on.

## Host settings (Dashboard → Questions)

- **On/off**, **price** (₹0 = free, up to ₹1,00,000), **reply within** 1 to 14 days, and a short **intro** (500 characters)
  shown on the ask page. One offer per host (`question_offers`).
- A paid price needs a paid plan and an account that can take the money: the host's own Razorpay, or Hourhand's under B18
  (`collectFor`). Without one, the ask page says questions can't be paid for right now.
- The page lists open questions first, oldest due date first, then answered, declined and refunded ones. Pending and failed
  (never paid) questions are hidden.

## Guest flow

1. `/<slug>/ask` (only when the host is approved, not deleted, and the offer is on): name, email, question (2,000 characters).
   `ask` is a reserved event-type slug from now on.
2. Free: the question opens at once and the host is emailed. Paid: Hourhand creates a Razorpay order on the collecting account
   (with B18's Route transfer when the host is on `split`), and the guest pays in Razorpay Checkout.
3. Confirming checks the Checkout signature against the order, then reads the payment from Razorpay (right order, right
   amount, captured; an authorized payment is captured). Only then does the question open, with its due date set to payment
   time plus the host's "reply within" days, and the host is emailed.
4. The guest's private page `/q/<token>` (48 random hex characters) shows the question, its state and, once given, the answer.

Requests are rate limited per address and per email (same limits as booking). A retry with the same idempotency key returns the
same question, never a second order.

## Answering and declining

- **Answer** (up to 5,000 characters): marks it answered and emails the guest the answer with a link to the private page.
- **Decline**: a free question is declined and the guest is told. A paid one goes to `refund_pending`; the job runner refunds the
  full amount (receipt `q-<id>`, existing refunds checked first so it never refunds twice; `reverse_all` when a Route transfer
  was made) and marks it refunded, and the guest's email says the payment is refunded.
- Every action checks the question belongs to the signed-in host and is still open.

## Background jobs

Every run, up to 20 pending or refund-pending questions not checked in the last minute: a payment found captured opens the
question (a guest who paid and closed the tab); an unpaid question older than a day is marked failed; refunds are retried.
Emails go through the notifications queue with dedupe key `question:<id>:<kind>` and are skipped if the question's state no
longer fits.

## Not built

Overdue questions are not refunded automatically (the host sees the due date; a late answer still goes out). No attachments,
no follow-up thread, no public answers, no Stripe for questions.
