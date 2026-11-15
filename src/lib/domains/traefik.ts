import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { domainEntitled } from "../billing/addons";
import { normalizeDomain } from "./validate";

// TLS for custom domains through Coolify's own Traefik: one dynamic-config file per serving domain, in a directory
// mounted from the host's Coolify proxy folder (/data/coolify/proxy/dynamic). Traefik watches that folder, adds a router
// for the domain and gets a Let's Encrypt certificate for it. The file is removed when the domain stops serving.
// No Cloudflare, no extra cost: the same Traefik that serves hourhand.cloud.

type Env = Record<string, string | undefined>;
type Db = Pick<pg.Pool, "query">;

export interface TraefikConfig {
  dir: string;
  /** Where Traefik sends the traffic: this app's container, e.g. http://hourhand-app:3000. */
  upstream: string;
}

/** Files Hourhand manages in the folder; everything else in it (Coolify's own files) is never touched. */
const PREFIX = "hourhand-domain-";
const OURS = /^hourhand-domain-[0-9a-f]{16}\.yaml$/;

export type TraefikSetup = { ok: true; config: TraefikConfig } | { ok: false; reason: string };

/** The Traefik setup from the environment. Unset TRAEFIK_DYNAMIC_DIR means custom domains aren't set up on this server. */
export function traefikFromEnv(env: Env = process.env): TraefikSetup {
  const dir = env.TRAEFIK_DYNAMIC_DIR?.trim();
  if (!dir) return { ok: false, reason: "Custom domains are not set up on this server (TRAEFIK_DYNAMIC_DIR is not set)." };
  const upstream = env.HOURHAND_UPSTREAM_URL?.trim();
  if (!upstream) return { ok: false, reason: "Custom domains are not set up on this server (HOURHAND_UPSTREAM_URL is not set)." };
  if (!safeUpstream(upstream)) return { ok: false, reason: "HOURHAND_UPSTREAM_URL must look like http://<app-container>:3000." };
  return { ok: true, config: { dir, upstream } };
}

/** http(s)://host[:port] and nothing else: no path, credentials, quotes or line breaks can reach the YAML. */
export function safeUpstream(url: string): boolean {
  if (!/^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/.test(url)) return false;
  try {
    const u = new URL(url);
    return !u.username && !u.password && (u.pathname === "/" || u.pathname === "");
  } catch {
    return false;
  }
}

/** The file a domain lives in: a hash, so the name never contains anything a host typed. */
export function fileNameFor(domain: string): string {
  return `${PREFIX}${createHash("sha256").update(domain).digest("hex").slice(0, 16)}.yaml`;
}

/**
 * The Traefik dynamic config for one domain: an https router with a Let's Encrypt certificate, an http router that
 * redirects to https, and the service pointing at this app. Every value is a JSON string (valid YAML), and the domain
 * is re-validated here, so nothing raw can change the file's structure.
 */
export function traefikYaml(domain: string, upstream: string): string {
  const checked = normalizeDomain(domain);
  if (!checked.ok || checked.domain !== domain) throw new Error(`Refusing to write Traefik config for an invalid domain: ${JSON.stringify(domain)}`);
  if (!safeUpstream(upstream)) throw new Error("Refusing to write Traefik config: HOURHAND_UPSTREAM_URL is not a plain http(s)://host:port");
  const id = `hourhand-${createHash("sha256").update(domain).digest("hex").slice(0, 16)}`;
  const q = (s: string) => JSON.stringify(s);
  const rule = q(`Host(\`${domain}\`)`);
  return [
    `# Managed by Hourhand for ${q(domain)}. Don't edit: it is rewritten or deleted when the domain changes.`,
    "http:",
    "  routers:",
    `    ${q(`${id}-https`)}:`,
    `      rule: ${rule}`,
    `      entryPoints: [${q("https")}]`,
    `      service: ${q(id)}`,
    "      tls:",
    `        certResolver: ${q("letsencrypt")}`,
    `    ${q(`${id}-http`)}:`,
    `      rule: ${rule}`,
    `      entryPoints: [${q("http")}]`,
    `      middlewares: [${q(`${id}-to-https`)}]`,
    `      service: ${q(id)}`,
    "  middlewares:",
    `    ${q(`${id}-to-https`)}:`,
    "      redirectScheme:",
    `        scheme: ${q("https")}`,
    "        permanent: true",
    "  services:",
    `    ${q(id)}:`,
    "      loadBalancer:",
    "        passHostHeader: true",
    "        servers:",
    `          - url: ${q(upstream.replace(/\/$/, ""))}`,
    "",
  ].join("\n");
}

/** Writes a file so Traefik never reads half of it: a temporary name it ignores, then a rename in the same folder. */
async function writeAtomic(dir: string, name: string, content: string): Promise<void> {
  const tmp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  await writeFile(tmp, content, { mode: 0o644 });
  try {
    await rename(tmp, join(dir, name));
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** The domains that should have a certificate right now: DNS verified, add-on live, host on a paid plan. */
export async function servingDomains(db: Db, now = new Date()): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string; domain: string }>(
    `select d.user_id, d.domain::text as domain from custom_domains d join users u on u.id = d.user_id
     where d.status = 'active' and u.deleted_at is null order by d.domain`);
  const out: string[] = [];
  for (const r of rows) if (await domainEntitled(db, r.user_id, now)) out.push(r.domain);
  return out;
}

/**
 * Makes the folder match the serving domains: writes a missing or changed file, deletes one whose domain no longer
 * serves (removed, failed DNS, add-on or plan lapsed). Safe to run as often as wanted.
 */
export async function reconcileTraefik(db: Db, config: TraefikConfig, now = new Date()): Promise<{ written: string[]; removed: string[] }> {
  const want = new Map<string, string>();
  for (const domain of await servingDomains(db, now)) {
    try {
      want.set(fileNameFor(domain), traefikYaml(domain, config.upstream));
    } catch (error) {
      console.error("[domains] skipped a domain that failed re-validation", error);
    }
  }
  const present = (await readdir(config.dir)).filter((f) => OURS.test(f));
  const written: string[] = [];
  const removed: string[] = [];
  for (const [name, content] of want) {
    const existing = present.includes(name) ? await readFile(join(config.dir, name), "utf8").catch(() => null) : null;
    if (existing === content) continue;
    await writeAtomic(config.dir, name, content);
    written.push(name);
  }
  for (const name of present) {
    if (want.has(name)) continue;
    await rm(join(config.dir, name), { force: true });
    removed.push(name);
  }
  return { written, removed };
}
