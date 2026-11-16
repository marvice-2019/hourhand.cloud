import Link from "next/link";
import { EventTypeEditor } from "@/components/EventTypeEditor";
import { NEW_EVENT_TYPE_FORM } from "@/lib/event-types";
import { requireHost } from "@/lib/auth/session";
import { authEnabled } from "@/lib/auth/auth";
import { getPool } from "@/lib/data/pg-store";
import { paymentAccount, priceCurrency } from "@/lib/payments/host-payments";
import { templateChoices, templatesEnabled } from "@/lib/intake/options";
import { getHostI18n } from "@/lib/i18n/host/server";
import { zoomSetupFor } from "@/lib/zoom/connection";

export const dynamic = "force-dynamic";

export default async function NewEventTypePage() {
  const user = await requireHost();
  const { t } = await getHostI18n();
  const account = authEnabled() ? await paymentAccount(getPool(process.env.DATABASE_URL as string), user.id) : null;
  return (
    <div>
      <Link href="/dashboard/event-types" className="inline-flex min-h-11 items-center font-semibold text-accent underline">{t("eventTypes.backToList")}</Link>
      <h1 className="mt-2 font-display text-xl text-text">{t("eventTypes.new")}</h1>
      <p className="mt-2 text-text-muted">{t("eventTypes.newIntro")}</p>
      <EventTypeEditor id={null} userSlug={user.slug} initial={NEW_EVENT_TYPE_FORM} initialQuestions={[]} currency={priceCurrency(account)} provider={account?.provider ?? null} zoomSetup={await zoomSetupFor(() => getPool(process.env.DATABASE_URL as string), user.id)}
        templates={await templateChoices(user.id, t)} canSaveTemplates={templatesEnabled()} />
    </div>
  );
}
