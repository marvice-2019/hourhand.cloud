"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled, resolveBaseUrl } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { BillingActionError } from "@/lib/billing/account";
import { cancelAddon, startAddonCheckout } from "@/lib/billing/addons";
import { getPool } from "@/lib/data/pg-store";
import { systemResolver } from "@/lib/domains/dns";
import { addDomain, checkHostDomain, deleteDomain, DOMAIN_SERVICE_MESSAGES } from "@/lib/domains/service";
import { reconcileTraefik, traefikFromEnv } from "@/lib/domains/traefik";
import { DOMAIN_ERRORS, hostOf } from "@/lib/domains/validate";
import { translator } from "@/lib/i18n/host/lib-messages";
import { getHostI18n } from "@/lib/i18n/host/server";

// Each action checks the session itself and changes only the signed-in host's own domain (user_id in every query).
// A Duo second person managing someone else's account is sent away by requireOwnAccount: the domain is the owner's.

const pool = () => getPool(process.env.DATABASE_URL as string);
const appHosts = () => [hostOf(process.env.BETTER_AUTH_URL)].filter((h): h is string => Boolean(h));

/** Brings the Traefik folder in line now rather than at the next scheduled run; the job runner retries if this fails. */
async function syncTls(): Promise<void> {
  const traefik = traefikFromEnv();
  if (!traefik.ok) return;
  await reconcileTraefik(pool(), traefik.config).catch((error) => console.error("[domains] Traefik update failed; the next scheduled run retries", error));
}

export type DomainFormState = { status: "idle" } | { status: "error"; error: string };

// The service words its refusals in English; each is shown as the same line in the host's language.
const say = translator({ ...DOMAIN_ERRORS, ...DOMAIN_SERVICE_MESSAGES }, {
  empty: "domain.errorEmpty",
  invalid: "domain.errorInvalid",
  ip: "domain.errorIp",
  reserved: "domain.errorReserved",
  ours: "domain.errorOurs",
  wildcard: "domain.errorWildcard",
  too_long: "domain.errorTooLong",
  no_tld: "domain.errorNoTld",
  not_entitled: "domain.errorNotEntitled",
  taken: "domain.errorTaken",
});

export async function saveDomain(_prev: DomainFormState, form: FormData): Promise<DomainFormState> {
  const user = await requireOwnAccount();
  const { t } = await getHostI18n();
  if (!authEnabled()) return { status: "error", error: t("domain.demo") };
  const traefik = traefikFromEnv();
  if (!traefik.ok) return { status: "error", error: t("domain.errorNotSetUp") };
  const result = await addDomain(pool(), user.id, form.get("domain"), { resolver: systemResolver(), appHosts: appHosts() });
  if (!result.ok) return { status: "error", error: say(t, result.message) };
  await syncTls();
  revalidatePath("/dashboard/domain");
  redirect("/dashboard/domain?saved=1");
}

export async function checkDomainNow(): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect("/dashboard/domain");
  await checkHostDomain(pool(), user.id, systemResolver());
  await syncTls();
  revalidatePath("/dashboard/domain");
  redirect("/dashboard/domain?checked=1");
}

export async function removeDomainAction(): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect("/dashboard/domain");
  await deleteDomain(pool(), user.id);
  await syncTls();
  revalidatePath("/dashboard/domain");
  redirect("/dashboard/domain?removed=1");
}

/** Runs an add-on change and sends the host back with its outcome. redirect() must stay outside the try. */
async function runAddon(change: () => Promise<string | void>, done: string): Promise<never> {
  let target = `/dashboard/domain?done=${done}`;
  try {
    const url = await change();
    if (url) target = url;
  } catch (error) {
    if (!(error instanceof BillingActionError)) throw error;
    target = `/dashboard/domain?error=${error.code}`;
  }
  revalidatePath("/dashboard/domain");
  redirect(target);
}

export async function buyDomainAddon(): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect("/dashboard/domain");
  if (!traefikFromEnv().ok) redirect("/dashboard/domain?error=not_set_up");
  const base = (resolveBaseUrl() ?? "http://localhost:3000").replace(/\/+$/, "");
  await runAddon(() => startAddonCheckout(pool(), user, "domain", base), "checkout");
}

export async function cancelDomainAddon(): Promise<void> {
  const user = await requireOwnAccount();
  if (!authEnabled()) redirect("/dashboard/domain");
  await runAddon(async () => {
    await cancelAddon(pool(), user.id, "domain");
    await syncTls();
  }, "cancelled");
}
