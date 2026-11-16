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
import { setBookingLanguage } from "./actions";

export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const user = await requireOwnAccount();
  const { t } = await getHostI18n();
  const { saved } = await searchParams;
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
