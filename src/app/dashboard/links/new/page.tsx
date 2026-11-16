import Link from "next/link";
import { OneOffForm } from "@/components/LinkForms";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { zoomSetupFor } from "@/lib/zoom/connection";
import { getHostI18n } from "@/lib/i18n/host/server";

export const dynamic = "force-dynamic";

export default async function NewOneOffPage() {
  const user = await requireHost();
  const { t } = await getHostI18n();
  return (
    <div>
      <Link href="/dashboard/links" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("links.title")}</Link>
      <h1 className="font-display text-xl text-text">{t("links.newOneOff")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        {t("links.newOneOffIntro")}
      </p>
      <div className="mt-6"><OneOffForm timeZone={user.timezone} zoomSetup={await zoomSetupFor(() => getPool(process.env.DATABASE_URL as string), user.id)} /></div>
    </div>
  );
}
