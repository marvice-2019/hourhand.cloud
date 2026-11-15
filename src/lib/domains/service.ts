import type pg from "pg";
import { hostPlan } from "../billing/account";
import { checkDomainDns, type Resolver } from "./dns";
import { getDomain, recordCheck, removeDomain, setDomain, type CustomDomain } from "./store";
import { DOMAIN_ERRORS, normalizeDomain } from "./validate";

// The host-facing custom-domain actions, each scoped to one host's own row.

type Db = Pick<pg.Pool, "query">;

export type DomainActionError = "not_entitled" | "taken" | "invalid";

export type AddResult = { ok: true; domain: CustomDomain; replaced: string | null } | { ok: false; error: DomainActionError; message: string };

/** Whether the host may add a custom domain right now: a paid plan. */
export async function mayUseCustomDomain(db: Db, userId: string): Promise<boolean> {
  return (await hostPlan(db, userId)) !== "free";
}

/** Validates and saves the host's domain, then checks its DNS straight away so the page shows where it stands. */
export async function addDomain(db: Db, userId: string, input: unknown, opts: { resolver: Resolver; appHosts?: string[]; now?: Date }): Promise<AddResult> {
  const parsed = normalizeDomain(input, opts.appHosts);
  if (!parsed.ok) return { ok: false, error: "invalid", message: DOMAIN_ERRORS[parsed.error] };
  if (!(await mayUseCustomDomain(db, userId))) return { ok: false, error: "not_entitled", message: "A custom domain needs a paid plan." };
  const saved = await setDomain(db, userId, parsed.domain, opts.now);
  if (saved.result === "taken") return { ok: false, error: "taken", message: "Another Hourhand account already uses that domain." };
  const checked = await checkHostDomain(db, userId, opts.resolver, opts.now);
  return { ok: true, domain: checked!, replaced: saved.replaced };
}

/** Runs a DNS check on the host's domain now and saves it. Null when the host has no domain. */
export async function checkHostDomain(db: Db, userId: string, resolver: Resolver, now = new Date()): Promise<CustomDomain | null> {
  const row = await getDomain(db, userId);
  if (!row) return null;
  const result = await checkDomainDns(row.domain, resolver);
  return (await recordCheck(db, row, result, now)) ?? (await getDomain(db, userId));
}

export async function deleteDomain(db: Db, userId: string): Promise<string | null> {
  return removeDomain(db, userId);
}
