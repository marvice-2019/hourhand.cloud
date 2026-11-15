import { createHash } from "node:crypto";
import type { Locale } from "../i18n/guest";
import { pt } from "../i18n/portal";
import { getMailer } from "../mail/mailer";
import { render, type RenderedMail } from "../mail/templates";

/** The email with a client's portal link, in their language. */
export function renderPortalLink(locale: Locale, hostName: string, url: string): RenderedMail {
  const host = { host: hostName };
  return render(pt(locale, "mailSubject", host), {
    heading: pt(locale, "openHeading"), intro: pt(locale, "mailIntro", host), rows: [],
    link: { label: pt(locale, "openButton"), url }, note: pt(locale, "mailNote"), footer: pt(locale, "mailFooter", host),
  });
}

/** Sends it straight away (the client is waiting). Each link is single-use, so its hash is a safe idempotency key. */
export async function deliverPortalLink(to: string, locale: Locale, hostName: string, url: string): Promise<void> {
  const mail = renderPortalLink(locale, hostName, url);
  await getMailer().send({ ...mail, to, idempotencyKey: `portal-${createHash("sha256").update(url).digest("hex")}` });
}
