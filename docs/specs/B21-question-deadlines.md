# B21: Question deadlines

Topmate refunds a Priority DM the creator never answers. Before B21 an overdue Hourhand question stayed open for ever: the
guest had paid and nothing happened unless the host acted.

## What it does

- **Reminder.** A day before an open question is due, the host gets one email (`question_due_host`, in their language)
  with the question and the due date, saying it will be closed a day after it's due.
- **Close.** A question still open a day after its due date is closed by the job runner: a paid one goes to
  `refund_pending` (the B19 refund pass then refunds it in full on the account that took the money, `reverse_all` for a
  Route split), a free one to `declined`. `declined_at` and `expired_at` are set.
- **Told.** The guest gets `question_expired_guest` ("didn't answer your question in time", with the refund when paid);
  the host gets `question_expired_host`.
- **Shown.** The dashboard says "Not answered in time" (closed, refund on its way, or refunded); the guest's page says the
  question was closed and why. The ask page and the guest's page tell a paying guest up front that an unanswered
  question is refunded a day after it's due. The offer form explains the reminder and the close.
- Earnings (PR 88) already counts the refund in the month it was made (`declined_at`).

## How

`runQuestionDeadlines(pool, now)` runs on every job-runner tick, before the question payment pass so a paid question
closed in a run is refunded in the same run. Each step is one conditional `update … for update skip locked` in its own
transaction with its emails, so two runners never remind or close a question twice, and an email is never queued for a
change that rolled back. Emails are rendered from the question's state when sent; a reminder for a question answered in
the meantime is skipped. A question whose due date passed without a run inside the reminder window gets no reminder.

Migration 0082 adds `questions.host_reminded_at`, `questions.expired_at` and a partial index on open questions' `due_at`.

## Not built

The grace day and the reminder lead time are fixed (a day each), not per host. No WhatsApp or push reminder.
