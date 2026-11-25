import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";

// A host types the webhook URL, and the server then calls it: without a guard that is a way to make the server call
// its own private network (SSRF). Only https, no user:password, and never an address that is private, loopback,
// link-local (cloud metadata), multicast or reserved. Checked when the URL is saved and again on every send, at
// connect time, so a name that changes its address (DNS rebinding) is caught too.

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32], ["64:ff9b::", 96], ["100::", 64],
] as const) blocked.addSubnet(net, bits, "ipv6");

/** True for any address the server must never call. IPv4-mapped IPv6 (::ffff:10.0.0.1) is judged as its IPv4. */
export function isBlockedAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isBlockedAddress(mapped[1]);
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) return blocked.check(ip, "ipv6");
  return true;
}

export type UrlProblem = "not_https" | "bad_url" | "private_address";

const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, "");

/** The URL's own shape: https, a real host name, no credentials. Its address is checked by checkUrl(). */
export function checkUrlShape(raw: string): { ok: true; url: URL } | { ok: false; problem: UrlProblem } {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return { ok: false, problem: "bad_url" }; }
  if (url.protocol !== "https:") return { ok: false, problem: "not_https" };
  if (url.username || url.password || !url.hostname || raw.trim().length > 500) return { ok: false, problem: "bad_url" };
  const host = bareHost(url);
  if (isIP(host) && isBlockedAddress(host)) return { ok: false, problem: "private_address" };
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) return { ok: false, problem: "private_address" };
  return { ok: true, url };
}

export type LookupAll = (host: string) => Promise<string[]>;
const systemLookup: LookupAll = (host) => new Promise((resolve, reject) =>
  dnsLookup(host, { all: true }, (err, addresses) => (err ? reject(err) : resolve(addresses.map((a) => a.address)))));

/** Saving: the name must resolve, and to public addresses only. */
export async function checkUrl(raw: string, lookupAll: LookupAll = systemLookup): Promise<{ ok: true; url: string } | { ok: false; problem: UrlProblem }> {
  const shape = checkUrlShape(raw);
  if (!shape.ok) return shape;
  const host = bareHost(shape.url);
  if (isIP(host)) return { ok: true, url: shape.url.toString() };
  try {
    const addresses = await lookupAll(host);
    if (!addresses.length || addresses.some(isBlockedAddress)) return { ok: false, problem: "private_address" };
  } catch {
    return { ok: false, problem: "bad_url" };
  }
  return { ok: true, url: shape.url.toString() };
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/** A `lookup` for https.request that refuses blocked addresses at connect time. */
export function guardedLookup(hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void {
  dnsLookup(hostname, { family: options.family, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) return callback(new Error("webhook address is not public"), "");
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}
