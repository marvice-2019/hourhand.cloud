import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { channelLink, hostMetadata, pageUrl, qrSvg, shareCard, shareDescription } from "./share-links";

/** Reads the QR code back out of the SVG qrSvg makes: its dark modules are horizontal strokes "Mx y.5h…m…". */
function decodeSvg(svg: string): string | null {
  const size = Number(/viewBox="0 0 (\d+) \1"/.exec(svg)?.[1]);
  const d = /<path stroke="[^"]+" d="([^"]+)"/.exec(svg)?.[1] ?? "";
  const scale = 8, px = size * scale;
  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  let x = 0, y = 0;
  for (const [, cmd, a, b] of d.matchAll(/([MmHh])(-?[\d.]+)(?:\s(-?[\d.]+))?/g)) {
    if (cmd === "M") { x = Number(a); y = Number(b) - 0.5; } else if (cmd === "m") { x += Number(a); y += Number(b); } else {
      for (let i = 0; i < Number(a); i++, x++) {
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          const o = ((y * scale + dy) * px + x * scale + dx) * 4;
          rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
        }
      }
    }
  }
  return jsQR(rgba, px, px)?.data ?? null;
}

describe("channel links", () => {
  it("tags each channel with its own utm_source and medium", () => {
    expect(channelLink("https://hourhand.cloud/", "priya", "instagram")).toBe("https://hourhand.cloud/priya?utm_source=instagram&utm_medium=social");
    expect(channelLink("https://hourhand.cloud", "priya", "google_business")).toBe("https://hourhand.cloud/priya?utm_source=google_business&utm_medium=organic");
    expect(channelLink("https://hourhand.cloud", "priya", "qr")).toBe("https://hourhand.cloud/priya?utm_source=qr&utm_medium=offline");
  });

  it("keeps the slug inside the path", () => {
    expect(pageUrl("https://hourhand.cloud", "a/../b?x")).toBe("https://hourhand.cloud/a%2F..%2Fb%3Fx");
    expect(new URL(channelLink("https://hourhand.cloud", "a?utm_source=x", "instagram")).searchParams.getAll("utm_source")).toEqual(["instagram"]);
  });
});

describe("QR code", () => {
  it("scans back to exactly the tagged link", async () => {
    const link = channelLink("https://hourhand.cloud", "priya", "qr");
    const svg = await qrSvg(link);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(decodeSvg(svg)).toBe(link);
    expect(decodeSvg(await qrSvg(channelLink("https://hourhand.cloud", "arun-k", "qr")))).toBe("https://hourhand.cloud/arun-k?utm_source=qr&utm_medium=offline");
  });
});

describe("meta tags", () => {
  const profile = { headline: "Career coach for first-time managers", bio: "Ten years coaching." };

  it("gives link previews a title, description, URL and a large image card", () => {
    const m = hostMetadata({ slug: "priya", name: "Priya Raman", profile });
    expect(m.title).toBe("Priya Raman · Career coach for first-time managers");
    expect(m.description).toBe(profile.headline);
    expect(m.alternates?.canonical).toBe("/priya");
    expect(m.openGraph).toMatchObject({ type: "profile", siteName: "Hourhand", url: "/priya", title: "Book Priya Raman", description: profile.headline });
    expect(m.twitter).toMatchObject({ card: "summary_large_image", title: "Book Priya Raman" });
  });

  it("falls back to the bio, then a plain line, and keeps descriptions short", () => {
    expect(shareDescription("Arun", { headline: null, bio: "x".repeat(400) })).toHaveLength(158);
    expect(shareDescription("Arun", null)).toBe("Book a time with Arun.");
    expect(hostMetadata({ slug: "arun", name: "Arun", profile: null, description: "अरुण के साथ समय बुक करें।" }).openGraph?.description).toBe("अरुण के साथ समय बुक करें।");
  });
});

describe("share card", () => {
  const svc = (name: string, more: Partial<{ priceMinor: number | null; active: boolean; hidden: boolean; kind: string; position: number }> = {}) =>
    ({ name, durationMinutes: 45, priceMinor: 150000, active: true, hidden: false, kind: "one_on_one", position: 0, ...more });

  it("shows the first three public services, the area and the photo", () => {
    const card = shareCard({
      base: "https://hourhand.cloud", host: { name: "Priya Raman", slug: "priya" },
      profile: { headline: "Coach", area: "Indiranagar, Bengaluru" }, photo: { mime: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff]) },
      services: [svc("Fourth", { position: 4 }), svc("Intro", { priceMinor: null, position: 1 }), svc("Coaching", { position: 0 }), svc("Review", { position: 2 })],
    });
    expect(card).toMatchObject({ name: "Priya Raman", initials: "PR", headline: "Coach", area: "Indiranagar, Bengaluru", link: "hourhand.cloud/priya", photo: "data:image/jpeg;base64,/9j/" });
    expect(card.services.map((s) => s.name)).toEqual(["Coaching", "Intro", "Review"]);
    expect(card.services[1].detail).toBe("45 min · Free");
  });

  it("leaves out hidden, paused and one-off services, and photos it can't draw", () => {
    const card = shareCard({
      base: "https://hourhand.cloud", host: { name: "Arun", slug: "arun" }, profile: null, photo: { mime: "image/webp", data: new Uint8Array([1]) },
      services: [svc("Secret VIP", { hidden: true }), svc("Paused", { active: false }), svc("One-off with Ravi", { kind: "one_off" })],
    });
    expect(card.services).toEqual([]);
    expect(card.photo).toBeNull();
    expect(card.initials).toBe("AR");
  });
});
