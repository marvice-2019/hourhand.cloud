// Hourhand video runs on the owner's own Jitsi Meet server (docker-jitsi-meet with JWT auth), not on the app server.
// Three Runtime variables set it up. With any of them missing the option is "not set up on this server": there is no
// fallback to a public Jitsi server or to another video service.

type Env = Record<string, string | undefined>;

export interface JitsiConfig {
  /** The Jitsi server's host name, e.g. meet.hourhand.cloud (no scheme, no path). */
  domain: string;
  /** JWT_APP_ID on the Jitsi server: the token's issuer. */
  appId: string;
  /** JWT_APP_SECRET on the Jitsi server: signs the tokens (HS256). */
  secret: string;
}

/** The smallest secret accepted: HS256 keys shorter than the hash (32 bytes) are weak. */
export const MIN_SECRET_LENGTH = 32;

/** The Jitsi server settings, or null when Hourhand video isn't set up here (or is set up wrongly). */
export function jitsiConfig(env: Env = process.env): JitsiConfig | null {
  const domain = (env.JITSI_DOMAIN ?? "").trim().toLowerCase();
  const appId = (env.JITSI_APP_ID ?? "").trim();
  const secret = env.JITSI_APP_SECRET ?? "";
  if (!domain || !appId || secret.length < MIN_SECRET_LENGTH) return null;
  // A bare host name only: "https://…" or a path would build broken room links.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/.test(domain)) return null;
  return { domain, appId, secret };
}

/** Why the option can't be used on this server, for the editor and the logs. Null when it is set up. */
export function jitsiSetupProblem(env: Env = process.env): string | null {
  if (jitsiConfig(env)) return null;
  const missing = ["JITSI_DOMAIN", "JITSI_APP_ID", "JITSI_APP_SECRET"].filter((k) => !(env[k] ?? "").trim());
  if (missing.length) return `Hourhand video is not set up on this server (missing ${missing.join(", ")}).`;
  if ((env.JITSI_APP_SECRET ?? "").length < MIN_SECRET_LENGTH) return `Hourhand video is not set up on this server (JITSI_APP_SECRET must be at least ${MIN_SECRET_LENGTH} characters).`;
  return "Hourhand video is not set up on this server (JITSI_DOMAIN must be a host name like meet.example.com).";
}
