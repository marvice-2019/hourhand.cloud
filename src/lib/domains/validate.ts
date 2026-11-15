import { isIP } from "node:net";
import { domainToASCII } from "node:url";

// What a host may type as their booking domain. The stored form is lowercase ASCII (punycode for international
// names), with no scheme, port, path or trailing dot, so one domain has exactly one spelling in the database.

/** The hostname hosts point their CNAME at. The owner creates its A record (docs/deploy.md). */
export const DOMAIN_TARGET = "domains.hourhand.cloud";

/** Hourhand's own domain: neither it nor anything under it can be a host's domain. */
const APP_DOMAIN = "hourhand.cloud";

/** Names that never resolve on the public internet (RFC 2606, 6761, 6762, 7686) or that we never want to serve. */
const RESERVED_TLDS = new Set(["localhost", "local", "internal", "test", "invalid", "example", "onion", "home", "lan", "corp", "arpa"]);

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export type DomainError = "empty" | "invalid" | "ip" | "reserved" | "ours" | "wildcard" | "too_long" | "no_tld";

export const DOMAIN_ERRORS: Record<DomainError, string> = {
  empty: "Enter the domain you want guests to use, for example book.yourname.com.",
  invalid: "That isn't a valid domain. Use letters, numbers and hyphens, like book.yourname.com.",
  ip: "Use a domain name, not an IP address.",
  reserved: "That domain can't be reached on the internet. Use a domain you own.",
  ours: "That's a Hourhand address. Use a domain you own.",
  wildcard: "Wildcards aren't supported. Enter one exact domain, like book.yourname.com.",
  too_long: "That domain is too long.",
  no_tld: "Enter the full domain, including the ending, like book.yourname.com.",
};

export type DomainResult = { ok: true; domain: string } | { ok: false; error: DomainError };

/**
 * Normalises and checks a domain a host typed. Accepts a pasted URL ("https://Book.Coach.com/") and keeps only the
 * hostname. `appHosts` are extra hostnames this server answers to (from BETTER_AUTH_URL), refused like hourhand.cloud.
 */
export function normalizeDomain(input: unknown, appHosts: readonly string[] = []): DomainResult {
  if (typeof input !== "string") return { ok: false, error: "empty" };
  let raw = input.trim().toLowerCase();
  if (!raw) return { ok: false, error: "empty" };
  if (raw.length > 300) return { ok: false, error: "too_long" };
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  raw = raw.replace(/[/?#].*$/, ""); // path, query, fragment
  if (raw.includes("@")) return { ok: false, error: "invalid" }; // user:pass@host
  if (raw.includes("*")) return { ok: false, error: "wildcard" };
  // IPv6 literals come bracketed in URLs; a bare one has several colons.
  const unbracketed = raw.replace(/^\[(.*)\](:\d+)?$/, "$1");
  if (isIP(unbracketed) || isIP(raw)) return { ok: false, error: "ip" };
  raw = raw.replace(/:\d{1,5}$/, ""); // port
  raw = raw.replace(/\.$/, ""); // the root dot
  if (!raw || raw.includes(":") || /\s/.test(raw)) return { ok: false, error: "invalid" };
  if (isIP(raw)) return { ok: false, error: "ip" };

  // IDNA: "bücher.de" becomes "xn--bcher-kva.de". An empty result means the name can't be encoded.
  const ascii = domainToASCII(raw);
  if (!ascii) return { ok: false, error: "invalid" };
  if (ascii.length > 253) return { ok: false, error: "too_long" };
  if (isIP(ascii)) return { ok: false, error: "ip" };

  const labels = ascii.split(".");
  if (labels.some((l) => !LABEL.test(l))) return { ok: false, error: "invalid" };
  if (labels.length < 2) return { ok: false, error: "no_tld" };
  const tld = labels[labels.length - 1];
  // A real top-level domain is letters, or an IDN in punycode; "1.2.3.4" style names were caught above.
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return { ok: false, error: "invalid" };
  if (RESERVED_TLDS.has(tld) || labels.includes("localhost")) return { ok: false, error: "reserved" };

  const ours = [APP_DOMAIN, DOMAIN_TARGET, ...appHosts.map((h) => h.toLowerCase().replace(/^www\./, ""))];
  if (ours.some((o) => o && (ascii === o || ascii.endsWith(`.${o}`)))) return { ok: false, error: "ours" };
  return { ok: true, domain: ascii };
}

/** The hostname part of a URL, or null. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
