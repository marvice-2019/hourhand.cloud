import { promises as dnsPromises } from "node:dns";
import { DOMAIN_TARGET } from "./validate";

// Is a host's domain pointed at Hourhand? Either a CNAME to domains.hourhand.cloud, or (for a root domain, where DNS
// doesn't allow a CNAME) A records that are exactly domains.hourhand.cloud's. Nothing is served or certified for a
// domain until this passes.

/** The two lookups the check needs; node:dns in production, a fake in tests. */
export interface Resolver {
  resolveCname(host: string): Promise<string[]>;
  resolve4(host: string): Promise<string[]>;
}

export function systemResolver(timeoutMs = 5_000): Resolver {
  // A resolver of its own so a slow lookup can't hold the job runner: c-ares retries up to `tries` times per server.
  const r = new dnsPromises.Resolver({ timeout: timeoutMs, tries: 2 });
  return { resolveCname: (h) => r.resolveCname(h), resolve4: (h) => r.resolve4(h) };
}

export type DnsCheck =
  | { ok: true; via: "cname" | "a" }
  /** transient: the lookup itself failed (timeout, server failure), so the answer says nothing about the record. */
  | { ok: false; transient: boolean; reason: string };

const clean = (name: string) => name.toLowerCase().replace(/\.$/, "");
const code = (error: unknown) => (error as { code?: string } | null)?.code ?? "";
/** "No such name" and "no record of that type" are real answers; anything else is a failed lookup. */
const NO_RECORD = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN", "ENONAME"]);

async function lookup(fn: () => Promise<string[]>): Promise<{ records: string[] } | { failed: string }> {
  try {
    return { records: (await fn()).map(clean) };
  } catch (error) {
    if (NO_RECORD.has(code(error))) return { records: [] };
    return { failed: code(error) || (error as Error).message || "lookup failed" };
  }
}

export async function checkDomainDns(domain: string, resolver: Resolver, target = DOMAIN_TARGET): Promise<DnsCheck> {
  const cname = await lookup(() => resolver.resolveCname(domain));
  if ("records" in cname && cname.records.includes(clean(target))) return { ok: true, via: "cname" };

  const [mine, ours] = await Promise.all([lookup(() => resolver.resolve4(domain)), lookup(() => resolver.resolve4(target))]);
  if ("failed" in ours || ("records" in ours && ours.records.length === 0)) {
    // Our own record is missing or unreachable: never the host's fault, and never a reason to take a domain down.
    return { ok: false, transient: true, reason: `Couldn't look up ${target} (${"failed" in ours ? ours.failed : "no A record"}). This is on Hourhand's side; we'll check again.` };
  }
  if ("failed" in mine || "failed" in cname) {
    const why = "failed" in mine ? mine.failed : (cname as { failed: string }).failed;
    return { ok: false, transient: true, reason: `The DNS lookup for ${domain} didn't answer (${why}). We'll check again.` };
  }
  const a = mine.records;
  if (a.length > 0 && a.every((ip) => ours.records.includes(ip))) return { ok: true, via: "a" };

  if (cname.records.length > 0) return { ok: false, transient: false, reason: `${domain} points to ${cname.records[0]}, not ${target}. Change the CNAME record's value to ${target}.` };
  if (a.length > 0) {
    const stray = a.filter((ip) => !ours.records.includes(ip));
    return { ok: false, transient: false, reason: `${domain} points to ${stray.join(", ")}, which isn't Hourhand. Use a CNAME record to ${target} instead.` };
  }
  return { ok: false, transient: false, reason: `No DNS record found for ${domain} yet. Add the CNAME record below; it can take up to an hour to show up.` };
}
