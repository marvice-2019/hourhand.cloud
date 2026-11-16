// The per-host share card route: a real PNG for each host, a 404 for anyone else, and nothing private on the card.
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareCard } from "@/lib/share-links";

const PRIVATE = { email: "priya.private@example.in", whatsapp: "+919876543210", bio: "Private bio line that only the page body shows", hidden: "Secret VIP retainer" };

const users = [
  { id: "00000000-0000-4000-8000-000000000001", email: PRIVATE.email, name: "Priya Raman", slug: "priya", timezone: "Asia/Kolkata", timeFormat: "12h", locale: "en" },
  { id: "00000000-0000-4000-8000-000000000002", email: "arun@example.in", name: "Arun Kumar", slug: "arun", timezone: "Asia/Kolkata", timeFormat: "12h", locale: "en" },
];
const svc = (userId: string, name: string, more: object = {}) =>
  ({ userId, name, durationMinutes: 45, priceMinor: 150000, active: true, hidden: false, kind: "one_on_one", position: 0, ...more });

vi.mock("@/lib/data", () => ({
  store: {
    getUserBySlug: async (slug: string) => users.find((u) => u.slug === slug) ?? null,
    listEventTypes: async (userId: string) => [
      svc(users[0].id, "45-min coaching"), svc(users[0].id, PRIVATE.hidden, { hidden: true, position: 1 }),
      svc(users[1].id, "Maths tuition", { priceMinor: 80000 }),
    ].filter((e) => e.userId === userId),
  },
}));
vi.mock("@/lib/auth/auth", () => ({ authEnabled: () => true, resolveBaseUrl: () => "https://hourhand.cloud" }));
vi.mock("@/lib/data/pg-store", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/profile", () => ({
  getProfile: async (_db: unknown, id: string) => id === users[0].id
    ? { headline: "Career coach", bio: PRIVATE.bio, area: "Bengaluru", whatsapp: PRIVATE.whatsapp, instagram: "priya.coach", reviewsUrl: "https://g.page/r/x", hasPhoto: false, photoVersion: 0 }
    : { headline: null, bio: null, area: null, whatsapp: null, instagram: null, reviewsUrl: null, hasPhoto: false, photoVersion: 0 },
  photoBySlug: async () => null,
}));

// Records each card the route draws, then draws it for real.
const drawn: ShareCard[] = [];
vi.mock("@/components/ShareCardImage", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/components/ShareCardImage")>();
  return { ShareCardImage: ({ card }: { card: ShareCard }) => { drawn.push(card); return createElement(real.ShareCardImage, { card }); } };
});

const { default: image, size, contentType } = await import("./opengraph-image");
const get = (slug: string) => image({ params: Promise.resolve({ slug }) });
const PNG = [0x89, 0x50, 0x4e, 0x47];

describe("host share image", () => {
  beforeEach(() => { drawn.length = 0; });

  it("returns a 1200×630 PNG for each host, different per host", async () => {
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    const [a, b] = await Promise.all([get("priya"), get("arun")]);
    for (const r of [a, b]) {
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
      expect(r.headers.get("cache-control")).toContain("max-age=3600");
    }
    const [pa, pb] = [new Uint8Array(await a.arrayBuffer()), new Uint8Array(await b.arrayBuffer())];
    expect([...pa.slice(0, 4)]).toEqual(PNG);
    // PNG width and height sit in the IHDR chunk at bytes 16–23.
    const view = new DataView(pa.buffer, pa.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
    expect(Buffer.from(pa).equals(Buffer.from(pb))).toBe(false);
    expect(drawn.map((c) => c.name).sort()).toEqual(["Arun Kumar", "Priya Raman"]);
  }, 30_000);

  it("is a 404 for a slug with no host", async () => {
    const r = await get("nobody-here");
    expect(r.status).toBe(404);
    expect(drawn).toEqual([]);
  });

  it("never puts private details or hidden services on the card", async () => {
    await (await get("priya")).arrayBuffer();
    expect(drawn).toHaveLength(1);
    const text = JSON.stringify(drawn[0]);
    for (const secret of Object.values(PRIVATE)) expect(text).not.toContain(secret);
    expect(text).not.toContain("9876543210");
    expect(drawn[0]).toMatchObject({ name: "Priya Raman", headline: "Career coach", area: "Bengaluru", link: "hourhand.cloud/priya", services: [{ name: "45-min coaching" }] });
    expect(Object.keys(drawn[0]).sort()).toEqual(["area", "headline", "initials", "link", "name", "photo", "services"]);
  }, 30_000);
});
