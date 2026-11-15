// Where a booking-page visit came from, worked out from what the request itself carries: UTM parameters, the referrer's
// domain, and whether the page is framed by a host's own site (/embed.js). Pure functions; nothing here is stored as is.

export const CHANNELS = [
  "whatsapp", "instagram", "facebook", "google", "youtube", "linkedin", "x", "search", "email", "campaign", "referral", "embed", "direct",
] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook", google: "Google", youtube: "YouTube", linkedin: "LinkedIn", x: "X (Twitter)",
  search: "Other search", email: "Email", campaign: "Other campaign", referral: "Other website", embed: "Your website (embed)", direct: "Direct or unknown",
};

/** The raw inputs, already cleaned: lower case, length-capped, domain without "www.". */
export interface SourceInput {
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  refDomain: string;
  embed: boolean;
}

export interface Source extends SourceInput { channel: Channel }

export const EMPTY_SOURCE: SourceInput = { utmSource: "", utmMedium: "", utmCampaign: "", refDomain: "", embed: false };

/** UTM values come from a link anyone can write: lower case, printable, at most 100 characters. */
export function cleanUtm(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f]/g, "").trim().toLowerCase().slice(0, 100);
}

/** A domain name only (no scheme, path or port), lower case and without a leading "www."; "" for anything else. */
export function cleanDomain(v: unknown): string {
  if (typeof v !== "string") return "";
  const d = v.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return d.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(d) ? d : "";
}

/** The referrer's domain, or "" when there is none, it can't be read, or it is this site itself (moving between our pages). */
export function referrerDomain(referer: string | null | undefined, ownHost: string | null | undefined): string {
  if (!referer) return "";
  let u: URL;
  try {
    u = new URL(referer);
  } catch {
    return "";
  }
  const domain = cleanDomain(u.hostname);
  const own = cleanDomain((ownHost ?? "").replace(/:\d+$/, ""));
  return domain && domain !== own ? domain : "";
}

const ends = (d: string, ...roots: string[]) => roots.some((r) => d === r || d.endsWith(`.${r}`));
const GOOGLE = /^(.+\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/;

/** The channel a referrer domain points at, or null for an ordinary website. */
export function channelForDomain(d: string): Channel | null {
  if (!d) return null;
  if (ends(d, "wa.me", "whatsapp.com", "whatsapp.net", "com.whatsapp", "com.whatsapp.w4b")) return "whatsapp";
  if (ends(d, "instagram.com", "com.instagram.android")) return "instagram";
  if (ends(d, "facebook.com", "fb.com", "fb.me", "messenger.com", "com.facebook.katana", "com.facebook.orca")) return "facebook";
  if (ends(d, "mail.google.com", "com.google.android.gm", "outlook.live.com", "outlook.office.com", "outlook.office365.com", "mail.yahoo.com", "mail.zoho.com", "mail.zoho.in")) return "email";
  if (GOOGLE.test(d) || ends(d, "com.google.android.googlequicksearchbox", "com.google.android.gm.lite")) return "google";
  if (ends(d, "youtube.com", "youtu.be")) return "youtube";
  if (ends(d, "linkedin.com", "lnkd.in", "com.linkedin.android")) return "linkedin";
  if (ends(d, "t.co", "twitter.com", "x.com")) return "x";
  if (ends(d, "bing.com", "duckduckgo.com", "search.yahoo.com", "yandex.com", "yandex.ru", "ecosia.org", "search.brave.com", "baidu.com")) return "search";
  return null;
}

/** The channel a utm_source (and utm_medium) names, or null when it names none we know. */
function channelForUtm(source: string, medium: string): Channel | null {
  const s = source.replace(/[\s_-]+/g, "");
  if (["whatsapp", "wa", "whatsappbusiness", "wabusiness", "whatsappstatus"].includes(s)) return "whatsapp";
  if (["instagram", "ig", "insta", "instagrambio", "igbio"].includes(s)) return "instagram";
  if (["facebook", "fb", "meta", "messenger"].includes(s)) return "facebook";
  if (["google", "googleads", "adwords", "gbp", "googlebusinessprofile", "googlemaps"].includes(s)) return "google";
  if (["youtube", "yt"].includes(s)) return "youtube";
  if (["linkedin", "li"].includes(s)) return "linkedin";
  if (["x", "twitter"].includes(s)) return "x";
  if (["email", "newsletter", "mail", "gmail"].includes(s) || ["email", "e-mail", "newsletter"].includes(medium)) return "email";
  return channelForDomain(cleanDomain(source));
}

/**
 * The channel for a visit. A UTM tag on the link wins (the host chose it); then the referrer's domain; then a framed
 * page with no other clue is the host's own site; otherwise direct. `inApp` is a fallback for in-app browsers that send
 * no referrer (Instagram and Facebook name themselves in the browser string).
 */
export function classify(input: SourceInput, inApp: Channel | null = null): Source {
  const fromUtm = input.utmSource ? channelForUtm(input.utmSource, input.utmMedium) : null;
  const channel: Channel = fromUtm
    ?? (input.utmSource || input.utmCampaign ? (input.utmMedium === "email" ? "email" : "campaign") : null)
    ?? channelForDomain(input.refDomain)
    ?? inApp
    ?? (input.embed ? "embed" : input.refDomain ? "referral" : "direct");
  return { ...input, channel };
}

/** Instagram's and Facebook's in-app browsers say so in the user agent; it is read here and never stored. */
export function inAppChannel(userAgent: string | null | undefined): Channel | null {
  if (!userAgent) return null;
  if (/\bInstagram\b/.test(userAgent)) return "instagram";
  if (/\bFBAN\/|\bFBAV\/|\bFB_IAB\//.test(userAgent)) return "facebook";
  return null;
}

/**
 * Link previews, crawlers, monitors and scripts. An empty user agent counts as a bot too. WhatsApp's own user agent
 * ("WhatsApp/2.x") is its link-preview fetcher; people opening a link from WhatsApp use their normal browser.
 */
const BOT = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|facebookcatalog|meta-externalagent|^whatsapp\/|telegrambot|preview|headless|lighthouse|pagespeed|pingdom|uptime|monitor|curl\/|wget\/|python-|python\/|httpclient|okhttp|go-http-client|node-fetch|undici|axios\/|java\/|libwww|scrapy|phantomjs|puppeteer|playwright|selenium|^mozilla\/5\.0$/i;

export function isBot(userAgent: string | null | undefined): boolean {
  // "CUBOT" is a phone maker, not a bot.
  const ua = (userAgent ?? "").trim().replace(/cubot/gi, "cu-phone");
  return ua.length < 10 || BOT.test(ua);
}

/** Do Not Track or Global Privacy Control: such visits are not counted at all. */
export function optedOut(headers: Pick<Headers, "get">): boolean {
  return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1";
}

/** Read the raw source inputs from a booking page's query string and request headers. */
export function sourceFromRequest(params: Record<string, string | string[] | undefined>, headers: Pick<Headers, "get">): SourceInput {
  const one = (k: string) => { const v = params[k]; return Array.isArray(v) ? v[0] : v; };
  // Moving from the profile page to an event page, the referrer is our own page: the profile's links carry the
  // original referrer as ?ref= and the embed flag as ?embed=1 instead.
  const referred = referrerDomain(headers.get("referer"), headers.get("host"));
  return {
    utmSource: cleanUtm(one("utm_source")),
    utmMedium: cleanUtm(one("utm_medium")),
    utmCampaign: cleanUtm(one("utm_campaign")),
    refDomain: referred || cleanDomain(one("ref")),
    embed: one("embed") === "1" || headers.get("sec-fetch-dest") === "iframe",
  };
}

/** The query string that carries a visit's source on to the next booking page ("" when there is nothing to carry). */
export function carryQuery(s: SourceInput): string {
  const q = new URLSearchParams();
  if (s.utmSource) q.set("utm_source", s.utmSource);
  if (s.utmMedium) q.set("utm_medium", s.utmMedium);
  if (s.utmCampaign) q.set("utm_campaign", s.utmCampaign);
  if (s.refDomain) q.set("ref", s.refDomain);
  if (s.embed) q.set("embed", "1");
  return q.toString();
}

/** A source sent back by the guest's browser (beacon or booking request): re-cleaned, since anyone can send anything. */
export function sourceFromBody(v: unknown): SourceInput {
  const o = (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  return { utmSource: cleanUtm(o.utmSource), utmMedium: cleanUtm(o.utmMedium), utmCampaign: cleanUtm(o.utmCampaign), refDomain: cleanDomain(o.refDomain), embed: o.embed === true };
}
