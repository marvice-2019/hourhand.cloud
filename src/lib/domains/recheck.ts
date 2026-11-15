import type pg from "pg";
import { checkDomainDns, type Resolver } from "./dns";
import { domainsDue, recordCheck } from "./store";
import { reconcileTraefik, type TraefikSetup } from "./traefik";

// The scheduled part of custom domains, run by the job runner: re-check DNS for domains that are due, then bring the
// Traefik folder in line (which also catches add-ons and plans that lapsed since the last run).

const MIN = 60_000;
export const RECHECK_AGES = { waitingMs: 5 * MIN, activeMs: 30 * MIN };

export async function recheckDomains(pool: Pick<pg.Pool, "query">, resolver: Resolver, traefik: TraefikSetup, now = new Date()): Promise<{ checked: number; written: number; removed: number }> {
  const due = await domainsDue(pool, now, RECHECK_AGES);
  for (const row of due) {
    const result = await checkDomainDns(row.domain, resolver);
    const saved = await recordCheck(pool, row, result, now);
    if (saved && saved.status !== row.status) console.info(`[domains] ${row.domain}: ${row.status} -> ${saved.status}${saved.lastError ? ` (${saved.lastError})` : ""}`);
  }
  if (!traefik.ok) return { checked: due.length, written: 0, removed: 0 };
  const files = await reconcileTraefik(pool, traefik.config, now);
  if (files.written.length || files.removed.length) console.info(`[domains] Traefik config: ${files.written.length} written, ${files.removed.length} removed`);
  return { checked: due.length, written: files.written.length, removed: files.removed.length };
}
