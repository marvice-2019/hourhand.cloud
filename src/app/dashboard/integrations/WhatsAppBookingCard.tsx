import Link from "next/link";
import { renderSVG } from "uqr";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { Plan } from "@/lib/billing/plans";
import { LIMITS } from "@/lib/billing/plans";
import { getHostI18n } from "@/lib/i18n/host/server";
import { hostWaLink } from "@/lib/whatsapp-booking";
import { whatsappConfig } from "@/lib/whatsapp-cloud";
import { disableWhatsAppBooking, enableWhatsAppBooking } from "./whatsapp-booking-actions";

/** Book over WhatsApp (3.4): the host turns it on and gets their wa.me link and a QR code to share. */
export async function WhatsAppBookingCard({ slug, plan, on, notice }: { slug: string; plan: Plan | null; on: boolean; notice?: string }) {
  const { t } = await getHostI18n();
  const link = whatsappConfig() ? hostWaLink(slug) : null;
  const allowed = plan !== null && LIMITS[plan].whatsappBooking;
  const qr = link ? `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(link, { border: 2 }))}` : null;

  return (
    <Card className="mt-6 max-w-2xl" id="whatsapp-booking">
      <h2 className="font-semibold text-text">{t("integrations.whatsappTitle")}</h2>
      <p className="mt-1 text-text-muted">{t("integrations.whatsappBody")}</p>
      {notice && <p role="status" className="mt-3 text-success">{t(notice === "on" ? "integrations.whatsappOn" : "integrations.whatsappOff")}</p>}

      {!link ? (
        <p className="mt-4 text-sm text-text-muted">{t("integrations.whatsappNotConfigured")}</p>
      ) : !allowed ? (
        <p className="mt-4 text-sm text-text-muted">
          {t("integrations.whatsappNeedsPlan")}{" "}
          <Link href="/dashboard/plan" className="font-semibold text-accent underline">{t("integrations.seePlans")}</Link>
        </p>
      ) : on ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-start">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text">{t("integrations.whatsappYourLink")}</p>
            <a href={link} className="block break-all font-mono text-sm text-accent underline">{link}</a>
            <p className="mt-2 text-sm text-text-muted">{t("integrations.whatsappLinkHelp", { slug })}</p>
            <form action={disableWhatsAppBooking} className="mt-4">
              <Button type="submit" variant="secondary" size="sm">{t("integrations.whatsappTurnOff")}</Button>
            </form>
          </div>
          {qr && (
            <div className="justify-self-start">
              {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URI, nothing to optimise */}
              <img src={qr} alt={t("integrations.whatsappQrAlt", { link })} width={160} height={160} className="rounded-md bg-white" />
              <a href={qr} download={`hourhand-whatsapp-${slug}.svg`} className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("integrations.whatsappDownloadQr")}</a>
            </div>
          )}
        </div>
      ) : (
        <form action={enableWhatsAppBooking} className="mt-4">
          <Button type="submit">{t("integrations.whatsappTurnOn")}</Button>
        </form>
      )}
    </Card>
  );
}
