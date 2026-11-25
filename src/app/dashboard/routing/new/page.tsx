import Link from "next/link";
import { RoutingFormEditor } from "@/components/RoutingFormEditor";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { getHostI18n } from "@/lib/i18n/host/server";
import { routableEventTypes } from "@/lib/routing/routing";

export const dynamic = "force-dynamic";

export default async function NewRoutingFormPage() {
  const user = await requireOwnAccount();
  const { t } = await getHostI18n();
  const eventTypes = authEnabled() ? await routableEventTypes(getPool(process.env.DATABASE_URL as string), user.id) : [];
  return (
    <div>
      <Link href="/dashboard/routing" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("routing.title")}</Link>
      <h1 className="font-display text-xl text-text">{t("routing.newForm")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">{t("routing.newIntro")}</p>
      <div className="mt-6"><RoutingFormEditor form={null} eventTypes={eventTypes.map((e) => ({ id: e.id, name: e.name }))} /></div>
    </div>
  );
}
