import { createHash } from "node:crypto";
import { getMailer } from "../mail/mailer";
import { renderEmailConfirmation, renderMagicLink } from "../mail/templates";

/**
 * Emails a sign-in link straight away; it is not queued, because the person is waiting for it. Without RESEND_API_KEY
 * the development mailer logs it (and production refuses: see createMailer).
 */
export async function deliverMagicLink(to: string, url: string): Promise<void> {
  const mail = renderMagicLink(url);
  // Each link is single-use, so a hash of it is a safe idempotency key: a double submit can't send two copies.
  const idempotencyKey = `magic-${createHash("sha256").update(url).digest("hex")}`;
  await getMailer().send({ ...mail, to, idempotencyKey });
}

/** Emails the link that confirms a new address on an account (a phone sign-up adding an email). Sent at once, like sign-in links. */
export async function deliverEmailConfirmation(to: string, url: string): Promise<void> {
  const idempotencyKey = `confirm-email-${createHash("sha256").update(url).digest("hex")}`;
  await getMailer().send({ ...renderEmailConfirmation(url), to, idempotencyKey });
}
