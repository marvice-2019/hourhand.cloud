import Link from "next/link";
import { ImportFlow } from "@/components/ImportFlow";
import { focusRing } from "@/components/ui/focus";
import { requireOwnAccount } from "@/lib/auth/session";
import { getHostI18n } from "@/lib/i18n/host/server";

export const dynamic = "force-dynamic";

export default async function ImportEventTypesPage() {
  await requireOwnAccount();
  const { t } = await getHostI18n();
  return (
    <div className="max-w-3xl">
      <Link href="/dashboard/event-types" className={`rounded-sm text-sm text-text-muted hover:underline ${focusRing}`}>{t("eventTypes.importBack")}</Link>
      <h1 className="mt-3 font-display text-xl text-text">{t("eventTypes.importTitle")}</h1>
      <p className="mt-2 text-text-muted">{t("eventTypes.importIntro")}</p>
      <ImportFlow />
      <p className="mt-8 text-sm text-text-muted">{t("eventTypes.importUnsupported")}</p>
    </div>
  );
}
