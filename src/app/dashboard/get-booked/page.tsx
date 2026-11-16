import type { ReactNode } from "react";
import QRCode from "qrcode";
import Link from "next/link";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { Card } from "@/components/ui/Card";
import { buttonClasses } from "@/components/ui/Button";
import { resolveBaseUrl } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { channelLink, pageUrl, qrSvg } from "@/lib/share-links";
import { getHostI18n } from "@/lib/i18n/host/server";
import type { HostKey } from "@/lib/i18n/host";

export const dynamic = "force-dynamic";

/**
 * Put the booking page behind the link on Instagram and Google Business Profile. Both are self-serve today:
 * Instagram's profile links and Google's booking link. Instagram's "Book now" action button and Google's in-Search
 * booking need a partner integration (docs/partnerships.md), so the steps here don't promise either.
 */
export default async function GetBookedPage() {
  const user = await requireHost();
  const base = (resolveBaseUrl() ?? "https://hourhand.cloud").replace(/\/+$/, "");
  const instagram = channelLink(base, user.slug, "instagram");
  const google = channelLink(base, user.slug, "google_business");
  const qrLink = channelLink(base, user.slug, "qr");
  const svg = await qrSvg(qrLink);
  const png = await QRCode.toDataURL(qrLink, { errorCorrectionLevel: "M", margin: 2, width: 1024 });
  const { t, tNodes } = await getHostI18n();
  const b = (key: HostKey) => <b>{t(key)}</b>;
  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-xl text-text">{t("getBooked.title")}</h1>
      <p className="mt-2 text-text-muted">
        {tNodes("getBooked.intro", { link: <span className="font-semibold text-text">{pageUrl(base, user.slug)}</span> })}
      </p>

      <Card className="mt-6">
        <h2 className="font-semibold text-text">{t("getBooked.instagram")}</h2>
        <LinkRow url={instagram} />
        <Steps>
          <li>{tNodes("getBooked.igStep1", { editProfile: b("getBooked.uiEditProfile") })}</li>
          <li>{tNodes("getBooked.igStep2", { links: b("getBooked.uiLinks"), addExternal: b("getBooked.uiAddExternal") })}</li>
          <li>{tNodes("getBooked.igStep3", { bookNow: b("getBooked.uiBookNow"), done: b("getBooked.uiDone") })}</li>
          <li>{t("getBooked.igStep4")}</li>
          <li>{tNodes("getBooked.igStep5", { link: b("getBooked.uiLinkSticker") })}</li>
        </Steps>
        <p className="mt-3 text-sm text-text-muted">{t("getBooked.igNote")}</p>
      </Card>

      <Card className="mt-6">
        <h2 className="font-semibold text-text">{t("getBooked.google")}</h2>
        <LinkRow url={google} />
        <Steps>
          <li>{t("getBooked.gStep1")}</li>
          <li>{tNodes("getBooked.gStep2", { bookings: b("getBooked.uiBookings"), editProfile: b("getBooked.uiEditProfile") })}</li>
          <li>{tNodes("getBooked.gStep3", { addLink: b("getBooked.uiAddLink"), addAnother: b("getBooked.uiAddAnother"), save: b("getBooked.uiSave") })}</li>
          <li>{t("getBooked.gStep4")}</li>
          <li>{t("getBooked.gStep5")}</li>
        </Steps>
        <p className="mt-3 text-sm text-text-muted">{tNodes("getBooked.gNote", { bookings: b("getBooked.uiBookings"), website: b("getBooked.uiWebsite") })}</p>
      </Card>

      <Card className="mt-6">
        <h2 className="font-semibold text-text">{t("getBooked.qrTitle")}</h2>
        <p className="mt-1 text-text-muted">{t("getBooked.qrIntro")}</p>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center">
          <div role="img" aria-label={t("getBooked.qrAlt", { link: qrLink })} className="h-44 w-44 shrink-0 rounded-md border border-border bg-white" dangerouslySetInnerHTML={{ __html: svg }} />
          <div className="flex flex-wrap gap-2">
            <a className={buttonClasses({ variant: "secondary", size: "sm" })} href={png} download={`hourhand-${user.slug}-qr.png`}>{t("getBooked.downloadPng")}</a>
            <a className={buttonClasses({ variant: "secondary", size: "sm" })} href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} download={`hourhand-${user.slug}-qr.svg`}>{t("getBooked.downloadSvg")}</a>
            <CopyLinkButton url={qrLink} label={t("getBooked.copyQr")} />
          </div>
        </div>
      </Card>

      <Card className="mt-6">
        <h2 className="font-semibold text-text">{t("getBooked.cardTitle")}</h2>
        <p className="mt-1 text-text-muted">
          {tNodes("getBooked.cardIntro", { link: <Link href="/dashboard/profile" className="font-semibold text-accent underline">{t("nav.profile")}</Link> })}
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element -- our own generated card, already sized */}
        <img src={`/${user.slug}/opengraph-image`} alt={t("getBooked.cardAlt")} width={1200} height={630} loading="lazy" className="mt-4 h-auto w-full rounded-md border border-border" />
      </Card>
    </div>
  );
}

function LinkRow({ url }: { url: string }) {
  return (
    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      <code className="block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-surface p-3 font-mono text-sm text-text">{url}</code>
      <CopyLinkButton url={url} />
    </div>
  );
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="mt-4 list-decimal space-y-2 pl-5 text-text">{children}</ol>;
}
