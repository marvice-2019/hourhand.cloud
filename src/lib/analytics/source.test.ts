import { describe, expect, it } from "vitest";
import { carryQuery, classify, cleanDomain, cleanUtm, EMPTY_SOURCE, inAppChannel, isBot, optedOut, referrerDomain, sourceFromBody, sourceFromRequest } from "./source";
import { analyticsWindow } from "./window";

const h = (o: Record<string, string>) => new Headers(o);
const src = (o: Partial<typeof EMPTY_SOURCE>) => ({ ...EMPTY_SOURCE, ...o });

describe("source classification", () => {
  it("lets a UTM tag win over the referrer", () => {
    expect(classify(src({ utmSource: "whatsapp", refDomain: "google.com" })).channel).toBe("whatsapp");
    expect(classify(src({ utmSource: "ig", utmMedium: "bio" })).channel).toBe("instagram");
    expect(classify(src({ utmSource: "Google Business Profile".toLowerCase() })).channel).toBe("google");
    expect(classify(src({ utmSource: "newsletter" })).channel).toBe("email");
    expect(classify(src({ utmSource: "partner-blog", utmMedium: "email" })).channel).toBe("email");
    expect(classify(src({ utmSource: "diwali-flyer" })).channel).toBe("campaign");
    expect(classify(src({ utmCampaign: "diwali" })).channel).toBe("campaign");
  });

  it("reads WhatsApp, Instagram, Google and others from the referrer", () => {
    expect(classify(src({ refDomain: "wa.me" })).channel).toBe("whatsapp");
    expect(classify(src({ refDomain: "web.whatsapp.com" })).channel).toBe("whatsapp");
    expect(classify(src({ refDomain: "l.instagram.com" })).channel).toBe("instagram");
    expect(classify(src({ refDomain: "lm.facebook.com" })).channel).toBe("facebook");
    expect(classify(src({ refDomain: "google.co.in" })).channel).toBe("google");
    expect(classify(src({ refDomain: "google.com" })).channel).toBe("google");
    expect(classify(src({ refDomain: "mail.google.com" })).channel).toBe("email");
    expect(classify(src({ refDomain: "com.google.android.gm" })).channel).toBe("email");
    expect(classify(src({ refDomain: "t.co" })).channel).toBe("x");
    expect(classify(src({ refDomain: "duckduckgo.com" })).channel).toBe("search");
    // Look-alikes are just websites.
    expect(classify(src({ refDomain: "notwhatsapp.com" })).channel).toBe("referral");
    expect(classify(src({ refDomain: "googleblog.example" })).channel).toBe("referral");
  });

  it("tells embed from direct", () => {
    expect(classify(src({ embed: true, refDomain: "priyacoaching.in" })).channel).toBe("embed");
    expect(classify(src({ embed: true })).channel).toBe("embed");
    expect(classify(src({ refDomain: "priyacoaching.in" })).channel).toBe("referral");
    expect(classify(src({})).channel).toBe("direct");
    // An embedded page reached from a tagged link keeps its tag's channel, and the embed flag.
    expect(classify(src({ embed: true, utmSource: "whatsapp" }))).toMatchObject({ channel: "whatsapp", embed: true });
  });

  it("falls back to in-app browsers that send no referrer", () => {
    const igUa = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 Instagram 312.0.0.32.112 Android";
    const fbUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1.15 Mobile/15E148 [FBAN/FBIOS;FBAV/440.0]";
    expect(inAppChannel(igUa)).toBe("instagram");
    expect(inAppChannel(fbUa)).toBe("facebook");
    expect(classify(src({}), inAppChannel(igUa)).channel).toBe("instagram");
    expect(classify(src({ refDomain: "wa.me" }), "instagram").channel).toBe("whatsapp");
  });

  it("reads a request's query and headers, ignoring our own pages as referrer", () => {
    const params = { utm_source: " WhatsApp ", utm_medium: "status", utm_campaign: ["diwali", "x"] };
    expect(sourceFromRequest(params, h({ referer: "https://hourhand.cloud/priya", host: "hourhand.cloud" })))
      .toEqual({ utmSource: "whatsapp", utmMedium: "status", utmCampaign: "diwali", refDomain: "", embed: false });
    // From the profile page: the original referrer and embed flag arrive as ?ref= and ?embed=1.
    expect(sourceFromRequest({ ref: "wa.me", embed: "1" }, h({ referer: "https://hourhand.cloud/priya", host: "hourhand.cloud" })))
      .toMatchObject({ refDomain: "wa.me", embed: true });
    // A real outside referrer beats ?ref=, and a framed page says so in Sec-Fetch-Dest.
    expect(sourceFromRequest({ ref: "evil.example" }, h({ referer: "https://www.instagram.com/", host: "hourhand.cloud", "sec-fetch-dest": "iframe" })))
      .toMatchObject({ refDomain: "instagram.com", embed: true });
  });

  it("carries a source on to the next page", () => {
    expect(carryQuery(src({ utmSource: "ig", utmCampaign: "bio link", refDomain: "l.instagram.com", embed: true })))
      .toBe("utm_source=ig&utm_campaign=bio+link&ref=l.instagram.com&embed=1");
    expect(carryQuery(EMPTY_SOURCE)).toBe("");
  });

  it("cleans what anyone can send", () => {
    expect(cleanUtm("A\u0000B\nC")).toBe("abc");
    expect(cleanUtm("x".repeat(500))).toHaveLength(100);
    expect(cleanUtm(42)).toBe("");
    expect(cleanDomain("WWW.Example.COM")).toBe("example.com");
    expect(cleanDomain("example.com/path")).toBe("");
    expect(cleanDomain("<script>")).toBe("");
    expect(referrerDomain("not a url", "hourhand.cloud")).toBe("");
    expect(referrerDomain("https://hourhand.cloud:443/x", "hourhand.cloud:443")).toBe("");
    expect(sourceFromBody({ utmSource: "=HYPERLINK(1)", refDomain: "bad domain", embed: "yes" }))
      .toEqual({ utmSource: "=hyperlink(1)", utmMedium: "", utmCampaign: "", refDomain: "", embed: false });
    expect(sourceFromBody("nope")).toEqual(EMPTY_SOURCE);
  });
});

describe("who isn't counted", () => {
  it("skips bots, link previews and scripts", () => {
    for (const ua of [
      "", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "facebookexternalhit/1.1", "WhatsApp/2.23.20.0 A",
      "Mozilla/5.0 (compatible; bingbot/2.0)", "curl/8.4.0", "python-requests/2.31", "Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0",
      "Slackbot-LinkExpanding 1.0", "TelegramBot (like TwitterBot)", "Mozilla/5.0",
    ]) expect(isBot(ua), ua).toBe(true);
  });
  it("counts people, in-app browsers included", () => {
    for (const ua of [
      "Mozilla/5.0 (Linux; Android 14; SM-A146B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36 Instagram 312.0.0.32.112 Android",
      "Mozilla/5.0 (Linux; Android 12; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Mobile Safari/537.36",
    ]) expect(isBot(ua), ua).toBe(false);
  });
  it("respects Do Not Track and Global Privacy Control", () => {
    expect(optedOut(h({ dnt: "1" }))).toBe(true);
    expect(optedOut(h({ "sec-gpc": "1" }))).toBe(true);
    expect(optedOut(h({ dnt: "0" }))).toBe(false);
    expect(optedOut(h({}))).toBe(false);
  });
});

describe("plan window", () => {
  it("gives Free the last 7 days and no export", () => {
    expect(analyticsWindow("free", undefined)).toEqual({ days: 7, locked: [30, 90], canExport: false });
    expect(analyticsWindow("free", "90")).toMatchObject({ days: 7 });
    expect(analyticsWindow("free", "30")).toMatchObject({ days: 7 });
  });
  it("gives Solo and Duo up to 90 days and export", () => {
    expect(analyticsWindow("solo", undefined)).toEqual({ days: 30, locked: [], canExport: true });
    expect(analyticsWindow("duo", "90")).toMatchObject({ days: 90, canExport: true });
    expect(analyticsWindow("solo", "7")).toMatchObject({ days: 7 });
    expect(analyticsWindow("solo", "365")).toMatchObject({ days: 30 });
  });
});
