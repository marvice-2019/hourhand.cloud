import Link from "next/link";
import { ProfileForm, ProfilePhotoForm } from "@/components/ProfileForm";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { getProfile } from "@/lib/profile";
import { resolveBaseUrl } from "@/lib/auth/auth";
import type { HostI18n } from "@/lib/i18n/host/format";
import { getHostI18n } from "@/lib/i18n/host/server";

export const dynamic = "force-dynamic";

export default async function ProfileSettingsPage() {
  const user = await requireHost();
  const i18n = await getHostI18n();
  const { t, tNodes } = i18n;
  const db = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const profile = db ? await getProfile(db, user.id) : null;
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("profile.title")}</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        {t("profile.intro")}{" "}
        {tNodes("profile.shareAs", { link: <Link href={`/${user.slug}`} className="font-semibold text-accent underline">/{user.slug}</Link> })}{" "}
        {tNodes("profile.getBookedHint", { link: <Link href="/dashboard/get-booked" className="font-semibold text-accent underline">{t("nav.getBooked")}</Link> })}
      </p>
      {!profile ? <p className="mt-6 text-text-muted">{t("profile.noDatabase")}</p> : (
        <>
          <Card className="mt-6 max-w-xl"><ProfilePhotoForm photoUrl={profile.hasPhoto ? `/api/photo/${user.slug}?v=${profile.photoVersion}` : null} /></Card>
          <Card className="mt-6 max-w-xl"><ProfileForm profile={profile} /></Card>
        </>
      )}
      <EmbedCard base={(resolveBaseUrl() ?? "").replace(/\/+$/, "")} slug={user.slug} i18n={i18n} />
    </div>
  );
}

/** Copy-and-paste code for the host's own website: the page inline, or a button that opens it. */
function EmbedCard({ base, slug, i18n: { t, tNodes } }: { base: string; slug: string; i18n: HostI18n }) {
  const page = `${base}/${slug}`;
  const inline = `<div data-hourhand-inline="${page}"></div>\n<script src="${base}/embed.js" async></script>`;
  // i18n-ignore: sample code for the host's own site
  const popup = `<button data-hourhand-popup="${page}">Book a session</button>\n<script src="${base}/embed.js" async></script>`;
  const code = "mt-2 block overflow-x-auto whitespace-pre rounded-md bg-surface p-3 font-mono text-sm text-text";
  return (
    <Card className="mt-6 max-w-xl">
      <h2 className="font-semibold text-text">{t("profile.embedTitle")}</h2>
      <p className="mt-1 text-text-muted">
        {t("profile.embedPaste")} {t("profile.embedOneService", { page })}{" "}
        {/* i18n-ignore: query parameters, not words */}
        {tNodes("profile.embedPrefill", { name: <code>?name=</code>, email: <code>?email=</code> })}
      </p>
      <h3 className="mt-4 text-sm font-semibold text-text">{t("profile.embedInline")}</h3>
      <code className={code}>{inline}</code>
      <h3 className="mt-4 text-sm font-semibold text-text">{t("profile.embedButton")}</h3>
      <code className={code}>{popup}</code>
    </Card>
  );
}
