// The custom-domain refusals (DOMAIN_ERRORS, DOMAIN_SERVICE_MESSAGES) and DNS reasons (DNS_MESSAGES) each have a host
// line with the same English.
import { describe, expect, it } from "vitest";
import { ADDON_PRICES, addonPriceLine, GST_RATE } from "../../billing/plans";
import { checkDomainDns, DNS_MESSAGES, type Resolver } from "../../domains/dns";
import { DOMAIN_SERVICE_MESSAGES } from "../../domains/service";
import { DOMAIN_ERRORS, normalizeDomain } from "../../domains/validate";
import { HOST_CATALOGS, type HostKey } from "./index";
import { makeHostI18n } from "./format";
import { decode } from "./lib-messages";

const REFUSALS = { ...DOMAIN_ERRORS, ...DOMAIN_SERVICE_MESSAGES };
// Same maps as src/app/dashboard/domain/actions.ts and page.tsx.
const REFUSAL_KEYS: Record<keyof typeof REFUSALS, HostKey> = {
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
};
const DNS_KEYS: Record<keyof typeof DNS_MESSAGES, HostKey> = {
  ourRecordMissing: "domain.dnsOurRecordMissing",
  ourLookupFailed: "domain.dnsOurLookupFailed",
  lookupFailed: "domain.dnsLookupFailed",
  cnameElsewhere: "domain.dnsCnameElsewhere",
  aElsewhere: "domain.dnsAElsewhere",
  noRecord: "domain.dnsNoRecord",
};

const TARGET = "domains.hourhand.cloud";
const err = (code: string) => Object.assign(new Error(code), { code });
function fake(cname: Record<string, string[] | string>, a: Record<string, string[] | string>): Resolver {
  const pick = (table: Record<string, string[] | string>, host: string) => {
    const v = table[host];
    if (v === undefined) return Promise.reject(err("ENODATA"));
    return typeof v === "string" ? Promise.reject(err(v)) : Promise.resolve(v);
  };
  return { resolveCname: (h) => pick(cname, h), resolve4: (h) => pick(a, h) };
}
const reason = async (r: Resolver) => {
  const c = await checkDomainDns("book.coach.com", r);
  if (c.ok) throw new Error("expected a failed check");
  return c.reason;
};

describe("domain messages", () => {
  it("has a host line with the same English for every code", () => {
    for (const [code, template] of Object.entries(REFUSALS)) expect(HOST_CATALOGS.en[REFUSAL_KEYS[code as keyof typeof REFUSAL_KEYS]]).toBe(template);
    for (const [code, template] of Object.entries(DNS_MESSAGES)) expect(HOST_CATALOGS.en[DNS_KEYS[code as keyof typeof DNS_KEYS]]).toBe(template);
  });

  it("words the add-on price as addonPriceLine does", () => {
    const { t, inr } = makeHostI18n("en");
    const base = ADDON_PRICES.domain.month.INR;
    expect(t("domain.addonPrice", { base: inr(base), total: inr(Math.round(base * (1 + GST_RATE))) })).toBe(addonPriceLine("domain"));
  });

  it("decodes real refusals", () => {
    const ip = normalizeDomain("10.0.0.1");
    expect(ip.ok).toBe(false);
    if (!ip.ok) expect(decode(REFUSALS, DOMAIN_ERRORS[ip.error])).toEqual({ code: "ip", vars: {} });
    expect(decode(REFUSALS, DOMAIN_SERVICE_MESSAGES.taken)).toEqual({ code: "taken", vars: {} });
  });

  it("decodes real DNS reasons", async () => {
    const ours = { [TARGET]: ["203.0.113.7"] };
    expect(decode(DNS_MESSAGES, await reason(fake({ "book.coach.com": ["elsewhere.example.net"] }, ours))))
      .toEqual({ code: "cnameElsewhere", vars: { domain: "book.coach.com", cname: "elsewhere.example.net", target: TARGET } });
    expect(decode(DNS_MESSAGES, await reason(fake({}, { ...ours, "book.coach.com": ["198.51.100.1", "198.51.100.2"] }))))
      .toEqual({ code: "aElsewhere", vars: { domain: "book.coach.com", ips: "198.51.100.1, 198.51.100.2", target: TARGET } });
    expect(decode(DNS_MESSAGES, await reason(fake({}, ours)))).toEqual({ code: "noRecord", vars: { domain: "book.coach.com" } });
    expect(decode(DNS_MESSAGES, await reason(fake({}, {})))).toEqual({ code: "ourRecordMissing", vars: { target: TARGET } });
    expect(decode(DNS_MESSAGES, await reason(fake({}, { [TARGET]: "ETIMEOUT" })))).toEqual({ code: "ourLookupFailed", vars: { target: TARGET, why: "ETIMEOUT" } });
    expect(decode(DNS_MESSAGES, await reason(fake({ "book.coach.com": "ESERVFAIL" }, ours))))
      .toEqual({ code: "lookupFailed", vars: { domain: "book.coach.com", why: "ESERVFAIL" } });
  });
});
