import Link from "next/link";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { Input, Label } from "@/components/ui/Input";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { hostPlan } from "@/lib/billing/account";
import { parseKey } from "@/lib/crypto/seal";
import { getPool } from "@/lib/data/pg-store";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { maskKeyId, razorpayStatus } from "@/lib/payments/host-razorpay";
import { APPLICATION_FEE_BP, maskAccountId, STRIPE_COUNTRIES, stripeConnectFromEnv, stripeStatus } from "@/lib/payments/stripe-connect";
import { whatsappBookingOn } from "@/lib/whatsapp-booking";
import { zoomDeps, zoomStatus } from "@/lib/zoom/connection";
import { connectRazorpay, connectStripe, disconnectRazorpayAction, disconnectStripeAction, disconnectZoomAction } from "./actions";
import { WhatsAppBookingCard } from "./WhatsAppBookingCard";
import { WebhooksCard } from "./WebhooksCard";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, HostKey> = {
  format: "integrations.errorFormat",
  rejected: "integrations.errorRejected",
  unreachable: "integrations.errorUnreachable",
  not_configured: "integrations.errorNotConfigured",
  demo: "integrations.errorDemo",
  busy: "integrations.errorBusy",
  other_provider: "integrations.errorStripeConnected",
};

const STRIPE_ERRORS: Record<string, HostKey> = {
  not_configured: "integrations.stripeErrorNotConfigured",
  demo: "integrations.stripeErrorDemo",
  country: "integrations.stripeErrorCountry",
  unreachable: "integrations.stripeErrorUnreachable",
  not_connected: "integrations.stripeErrorNotConnected",
  other_provider: "integrations.stripeErrorRazorpayConnected",
  busy: "integrations.errorBusy",
};

const STRIPE_RETURN: Record<string, HostKey> = {
  active: "integrations.stripeReturnActive",
  pending: "integrations.stripeReturnPending",
  restricted: "integrations.stripeReturnRestricted",
};

/** True when the server can encrypt stored keys; a missing or malformed TOKEN_ENCRYPTION_KEY means it can't. */
function encryptionReady(): boolean {
  try {
    parseKey(process.env.TOKEN_ENCRYPTION_KEY);
    return true;
  } catch {
    return false;
  }
}

const ZOOM_ERRORS: Record<string, HostKey> = {
  not_configured: "integrations.zoomErrorNotConfigured",
  demo: "integrations.zoomErrorDemo",
  denied: "integrations.zoomErrorDenied",
  missing_permissions: "integrations.zoomErrorMissingPermissions",
  expired: "integrations.zoomErrorExpired",
  state_mismatch: "integrations.zoomErrorStateMismatch",
  wrong_user: "integrations.zoomErrorWrongUser",
  zoom: "integrations.zoomErrorZoom",
};

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireOwnAccount();
  const params = await searchParams;
  const live = authEnabled();
  const pool = live ? getPool(process.env.DATABASE_URL as string) : null;
  const [status, plan, stripe] = pool ? await Promise.all([razorpayStatus(pool, user.id), hostPlan(pool, user.id), stripeStatus(pool, user.id)]) : [null, null, null];
  const canConnect = live && encryptionReady();
  const stripeServer = canConnect && stripeConnectFromEnv() !== null;
  const { t } = await getHostI18n();
  const zoomReady = live && zoomDeps() !== null;
  const zoom = pool ? await zoomStatus(pool, user.id) : { state: "none" as const };

  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("integrations.title")}</h1>
      <p className="mt-2 text-text-muted">{t("integrations.intro")}</p>
      <ul className="flex flex-wrap gap-x-6">
        <li><Link href="/dashboard/calendars" className="mt-4 inline-flex min-h-11 items-center font-semibold text-accent underline">{t("nav.calendars")}</Link></li>
        <li><Link href="/dashboard/settings" className="mt-4 inline-flex min-h-11 items-center font-semibold text-accent underline">{t("nav.settings")}</Link></li>
      </ul>

      {params.connected && <p role="status" className="mt-4 max-w-xl text-success">{t("integrations.connected")}</p>}
      {params.disconnected && <p role="status" className="mt-4 max-w-xl text-success">{t("integrations.disconnected")}</p>}
      {params.error && <p role="alert" className="mt-4 max-w-xl text-danger">{t((Object.hasOwn(ERRORS, params.error) && ERRORS[params.error]) || ERRORS.unreachable)}</p>}

      {params.zoom_connected && <p role="status" className="mt-4 max-w-xl text-success">{t("integrations.zoomConnected")}</p>}
      {params.zoom_disconnected && <p role="status" className="mt-4 max-w-xl text-success">{t("integrations.zoomDisconnected")}</p>}
      {params.zoom_error && <p role="alert" className="mt-4 max-w-xl text-danger">{t((Object.hasOwn(ZOOM_ERRORS, params.zoom_error) && ZOOM_ERRORS[params.zoom_error]) || ZOOM_ERRORS.zoom)}</p>}

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">{t("integrations.zoomTitle")}</h2>
        <p className="mt-1 text-text-muted">{t("integrations.zoomBody")}</p>
        {zoom.state === "connected" ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-text">{zoom.email}</span>
              <span className="inline-flex items-center rounded-pill bg-success-bg px-3 py-1 text-xs text-success">{t("integrations.zoomConnectedBadge")}</span>
            </div>
            <form action={disconnectZoomAction}>
              <Button type="submit" variant="secondary" size="sm">{t("integrations.disconnect")}</Button>
            </form>
          </div>
        ) : zoomReady ? (
          <div className="mt-4 grid gap-3">
            {zoom.state === "disconnected" && (
              <p className="text-sm text-danger">{zoom.email ? t("integrations.zoomStopped", { email: zoom.email }) : t("integrations.zoomStoppedNoEmail")}</p>
            )}
            <div><Link prefetch={false} href="/api/integrations/zoom/connect" className={buttonClasses()}>{zoom.state === "disconnected" ? t("integrations.zoomReconnect") : t("integrations.zoomConnect")}</Link></div>
          </div>
        ) : (
          <p className="mt-4 max-w-xl text-sm text-text-muted">{live ? t(ZOOM_ERRORS.not_configured) : t(ZOOM_ERRORS.demo)}</p>
        )}
      </Card>

      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">{t("integrations.razorpayTitle")}</h2>
        <p className="mt-1 text-text-muted">{t("integrations.razorpayBody")}</p>
        {plan === "free" && (
          <p className="mt-2 text-sm text-text-muted">
            {t("integrations.needsPaidPlan")}{" "}
            <Link href="/dashboard/plan" className="font-semibold text-accent underline">{t("integrations.seePlans")}</Link>
          </p>
        )}

        {stripe ? (
          <p className="mt-4 max-w-xl text-sm text-text-muted">{t(ERRORS.other_provider)}</p>
        ) : status ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-text">{maskKeyId(status.keyId)}</span>
              <span className={`inline-flex items-center rounded-pill px-3 py-1 text-xs ${status.mode === "test" ? "bg-warning-bg text-warning" : "bg-success-bg text-success"}`}>
                {status.mode === "test" ? t("integrations.testMode") : t("integrations.live")}
              </span>
            </div>
            <form action={disconnectRazorpayAction}>
              <Button type="submit" variant="secondary" size="sm">{t("integrations.disconnect")}</Button>
            </form>
          </div>
        ) : canConnect ? (
          <form action={connectRazorpay} className="mt-4 grid max-w-md gap-4">
            <div>
              <Label htmlFor="razorpay-key-id">{t("integrations.keyId")}</Label>
              <Input id="razorpay-key-id" name="keyId" type="text" autoComplete="off" required />
            </div>
            <div>
              <Label htmlFor="razorpay-key-secret">{t("integrations.keySecret")}</Label>
              <Input id="razorpay-key-secret" name="keySecret" type="password" autoComplete="off" required />
            </div>
            <p className="text-sm text-text-muted">{t("integrations.findKeys")}</p>
            <div><Button type="submit">{t("integrations.connect")}</Button></div>
          </form>
        ) : (
          <p className="mt-4 max-w-xl text-sm text-text-muted">{live ? t(ERRORS.not_configured) : t(ERRORS.demo)}</p>
        )}
      </Card>
      <Card className="mt-6 max-w-2xl">
        <h2 className="font-semibold text-text">{t("integrations.stripeTitle")}</h2>
        <p className="mt-1 text-text-muted">
          {APPLICATION_FEE_BP === 0 ? t("integrations.stripeBodyNoCut") : t("integrations.stripeBody")}
        </p>
        {params.stripe && Object.hasOwn(STRIPE_RETURN, params.stripe) && (
          <p role="status" className={`mt-4 max-w-xl ${params.stripe === "active" ? "text-success" : "text-text"}`}>{t(STRIPE_RETURN[params.stripe])}</p>
        )}
        {params.stripe_disconnected && <p role="status" className="mt-4 max-w-xl text-success">{t("integrations.stripeDisconnected")}</p>}
        {params.stripe_error && <p role="alert" className="mt-4 max-w-xl text-danger">{t((Object.hasOwn(STRIPE_ERRORS, params.stripe_error) && STRIPE_ERRORS[params.stripe_error]) || STRIPE_ERRORS.unreachable)}</p>}
        {plan === "free" && (
          <p className="mt-2 text-sm text-text-muted">
            {t("integrations.needsPaidPlan")}{" "}
            <Link href="/dashboard/plan" className="font-semibold text-accent underline">{t("integrations.seePlans")}</Link>
          </p>
        )}

        {stripe ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-text">{maskAccountId(stripe.accountId)}</span>
              {stripe.currency && <span className="text-text-muted">{stripe.currency}</span>}
              <span className={`inline-flex items-center rounded-pill px-3 py-1 text-xs ${stripe.mode === "test" ? "bg-warning-bg text-warning" : "bg-success-bg text-success"}`}>
                {stripe.mode === "test" ? t("integrations.testMode") : t("integrations.live")}
              </span>
              <span className={`inline-flex items-center rounded-pill px-3 py-1 text-xs ${stripe.onboarding === "active" && !stripe.removed ? "bg-success-bg text-success" : "bg-warning-bg text-warning"}`}>
                {t(stripe.removed ? "integrations.stripeRemoved" : stripe.onboarding === "active" ? "integrations.stripeTakingPayments" : stripe.onboarding === "restricted" ? "integrations.stripeNeedsDetails" : "integrations.stripeSetupUnfinished")}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {stripe.onboarding !== "active" && !stripe.removed && stripeServer && (
                <form action={connectStripe}><Button type="submit" size="sm">{t("integrations.stripeContinue")}</Button></form>
              )}
              <form action={disconnectStripeAction}><Button type="submit" variant="secondary" size="sm">{t("integrations.disconnect")}</Button></form>
            </div>
          </div>
        ) : status ? (
          <p className="mt-4 max-w-xl text-sm text-text-muted">{t(STRIPE_ERRORS.other_provider)}</p>
        ) : stripeServer ? (
          <form action={connectStripe} className="mt-4 grid max-w-md gap-4">
            <div>
              <label htmlFor="stripe-country" className="block text-sm font-semibold text-text">{t("integrations.stripeCountry")}</label>
              <select id="stripe-country" name="country" required defaultValue=""
                className={`mt-1 block h-11 w-full rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
                <option value="" disabled>{t("integrations.stripeChooseCountry")}</option>
                {Object.entries(STRIPE_COUNTRIES).sort((a, b) => a[1].localeCompare(b[1])).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </div>
            <p className="text-sm text-text-muted">
              {t("integrations.stripeConnectNote")}
            </p>
            <div><Button type="submit">{t("integrations.stripeConnect")}</Button></div>
          </form>
        ) : (
          <p className="mt-4 max-w-xl text-sm text-text-muted">{live ? t(STRIPE_ERRORS.not_configured) : t(STRIPE_ERRORS.demo)}</p>
        )}
      </Card>

      <WhatsAppBookingCard slug={user.slug} plan={plan} on={pool ? await whatsappBookingOn(pool, user.id) : false} notice={params.whatsapp} />

      <WebhooksCard pool={pool} hostId={user.id} notice={params.webhook} />
    </div>
  );
}
