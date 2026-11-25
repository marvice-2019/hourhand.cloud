import Link from "next/link";
import { AddEmailForm } from "@/components/AddEmailForm";
import { DeleteAccountForm } from "@/components/DeleteAccountForm";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { formatPhone, isPhonePlaceholderEmail } from "@/lib/auth/phone";
import { signOutEverywhere } from "@/lib/auth/actions";
import { requireOwnAccount } from "@/lib/auth/session";
import { focusRing } from "@/components/ui/focus";
import { LOCALES, LOCALE_NAMES, isLocale } from "@/lib/i18n/guest";
import { getHostI18n } from "@/lib/i18n/host/server";
import { HOST_LOCALES, HOST_LOCALE_NAMES, hostLocaleOf } from "@/lib/i18n/host";
import { setBookingLanguage, setDashboardLanguage, setSessionPrep } from "./actions";
import { hostPlan } from "@/lib/billing/account";
import { LIMITS } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { prepClientFromEnv, prepSettings } from "@/lib/session-prep/prep";
import { PhoneAlerts } from "@/components/PhoneAlerts";
import { countSubscriptions, pushConfig } from "@/lib/push/push";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const user = await requireOwnAccount();
  const { t } = await getHostI18n();
  const { saved, error } = await searchParams;
  const pool = authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
  const prep = pool ? await prepSettings(pool, user.id) : null;
  const prepPlan = pool ? LIMITS[await hostPlan(pool, user.id)].sessionPrep : false;
  const prepServer = prepClientFromEnv() !== null;
  const push = pushConfig();
  const pushDevices = pool && push ? await countSubscriptions(pool, user.id) : 0;
  const phone = isPhonePlaceholderEmail(user.email) ? formatPhone(`+${user.email.split("@")[0]}`) : undefined;
  return (
    <div>
      <h1 className="font-display text-xl text-text">{t("settings.title")}</h1>
      <p className="mt-2 text-text-muted">{t("settings.intro")}</p>
      <ul className="flex flex-wrap gap-x-6">
        <li><Link href="/dashboard/event-types" className="mt-4 inline-flex min-h-11 items-center font-semibold text-accent underline">{t("settings.eventTypes")}</Link></li>
      </ul>

      {saved === "email" && <p role="status" className="mt-6 max-w-xl rounded-md bg-surface p-3 text-success">{t("settings.emailSaved")}</p>}
      {phone && authEnabled() && (
        <Card className="mt-8 max-w-xl" id="add-email">
          <h2 className="font-semibold text-text">{t("settings.addEmailTitle")}</h2>
          <p className="mt-1 text-text-muted">{t("settings.addEmailIntro")}</p>
          <AddEmailForm />
        </Card>
      )}

      <Card className="mt-8 max-w-xl">
        <h2 className="font-semibold text-text">{t("settings.appearance")}</h2>
        <p className="mt-1 text-text-muted">{t("settings.appearanceIntro")}</p>
        <ThemeSwitch
          className="mt-4"
          labels={{ legend: t("common.themeLegend"), system: t("common.themeDevice"), light: t("common.themeLight"), dark: t("common.themeDark") }}
        />
      </Card>

      <Card className="mt-6 max-w-xl">
        <h2 className="font-semibold text-text">{t("settings.dashboardLanguage")}</h2>
        <p className="mt-1 text-text-muted">{t("settings.dashboardLanguageIntro")}</p>
        <form action={setDashboardLanguage} className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="host-locale" className="block text-sm font-semibold text-text">{t("settings.language")}</label>
            <select id="host-locale" name="hostLocale" defaultValue={hostLocaleOf(user)}
              className={`mt-1 block h-11 rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
              {HOST_LOCALES.map((l) => <option key={l} value={l} lang={l}>{HOST_LOCALE_NAMES[l]}</option>)}
            </select>
          </div>
          <Button type="submit">{t("common.save")}</Button>
        </form>
        {saved === "dashboard-language" && <p role="status" className="mt-2 text-success">{t("settings.dashboardLanguageSaved")}</p>}
      </Card>

      <Card className="mt-6 max-w-xl">
        <h2 className="font-semibold text-text">{t("settings.bookingLanguage")}</h2>
        <p className="mt-1 text-text-muted">{t("settings.bookingLanguageIntro")}</p>
        <form action={setBookingLanguage} className="mt-4 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="locale" className="block text-sm font-semibold text-text">{t("settings.language")}</label>
            <select id="locale" name="locale" defaultValue={isLocale(user.locale) ? user.locale : "en"}
              className={`mt-1 block h-11 rounded-md border border-border-input bg-card px-3 text-base text-text ${focusRing}`}>
              {LOCALES.map((l) => <option key={l} value={l} lang={l}>{LOCALE_NAMES[l]}</option>)}
            </select>
          </div>
          <Button type="submit">{t("common.save")}</Button>
        </form>
        {saved === "language" && <p role="status" className="mt-2 text-success">{t("settings.languageSaved")}</p>}
      </Card>

      {pool && (
        <Card id="phone-alerts" className="mt-6 max-w-xl">
          <h2 className="font-semibold text-text">{t("push.title")}</h2>
          <p className="mt-1 text-text-muted">{t("push.intro")}</p>
          {push ? (
            <PhoneAlerts publicKey={push.publicKey} initialDevices={pushDevices} labels={{
              unsupported: t("push.unsupported"), installFirst: t("push.installFirst"), blocked: t("push.blocked"), on: t("push.on"),
              devices: t("push.devices", { n: "{n}" }), turnOn: t("push.turnOn"), turnOff: t("push.turnOff"), test: t("push.test"),
              testSent: t("push.testSent"), error: t("push.error"),
            }} />
          ) : (
            <p className="mt-3 text-sm text-text">{t("push.notSetUp")}</p>
          )}
        </Card>
      )}

      {prep && (
        <Card id="session-prep" className="mt-6 max-w-xl">
          <h2 className="font-semibold text-text">{t("settings.prepTitle")}</h2>
          <p className="mt-1 text-text-muted">{t("settings.prepIntro")}</p>
          <p className="mt-2 text-sm text-text-muted">{t("settings.prepData")}</p>
          {!prepServer ? (
            <p className="mt-3 text-sm text-text">{t("settings.prepNotSetUp")}</p>
          ) : !prepPlan ? (
            <p className="mt-3 text-sm text-text">{t("settings.prepPlan")} <Link href="/dashboard/plan" className="font-semibold text-accent underline">{t("settings.prepSeePlans")}</Link></p>
          ) : prep.enabled ? (
            <form action={setSessionPrep} className="mt-4">
              <p className="text-sm text-success">{t("settings.prepOnSince", { date: prep.enabledAt?.toISOString().slice(0, 10) ?? "" })}</p>
              <Button type="submit" variant="secondary" className="mt-2">{t("settings.prepTurnOff")}</Button>
            </form>
          ) : (
            <form action={setSessionPrep} className="mt-4 grid gap-3">
              <input type="hidden" name="enabled" value="on" />
              <label className="flex items-start gap-3 text-sm text-text">
                <input type="checkbox" name="agree" required className={`mt-0.5 size-5 shrink-0 accent-accent ${focusRing}`} />
                <span>{t("settings.prepAgree")}</span>
              </label>
              <div><Button type="submit">{t("settings.prepTurnOn")}</Button></div>
            </form>
          )}
          {error === "prep_agree" && <p role="alert" className="mt-2 text-sm text-danger">{t("settings.prepErrAgree")}</p>}
          {error === "prep_plan" && <p role="alert" className="mt-2 text-sm text-danger">{t("settings.prepPlan")}</p>}
          {saved === "prep_on" && <p role="status" className="mt-2 text-sm text-success">{t("settings.prepSavedOn")}</p>}
          {saved === "prep_off" && <p role="status" className="mt-2 text-sm text-text">{t("settings.prepSavedOff")}</p>}
        </Card>
      )}

      <Card className="mt-6 max-w-xl">
        <h2 className="font-semibold text-text">
          {/* A phone sign-up's email is a placeholder made from the number: show the number. */}
          {t("settings.signedInAs", { email: phone ?? user.email })}
        </h2>
        {authEnabled() ? (
          <>
            <p className="mt-1 text-text-muted">{t("settings.signOutIntro")}</p>
            <form action={signOutEverywhere} className="mt-4">
              <Button type="submit" variant="secondary">
                {t("settings.signOutAll")}
              </Button>
            </form>
          </>
        ) : (
          <p className="mt-1 text-text-muted">{t("settings.demoSessions")}</p>
        )}
      </Card>

      {authEnabled() && (
        <Card className="mt-6 max-w-xl">
          <h2 className="font-semibold text-text">{t("settings.deleteTitle")}</h2>
          <p className="mt-1 text-text-muted">
            {t("settings.deleteIntro")}
          </p>
          <DeleteAccountForm email={user.email} phone={phone} />
        </Card>
      )}
    </div>
  );
}
