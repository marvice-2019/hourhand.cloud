// The booking text's short link, as the app sees it behind Coolify's proxy: the request arrives addressed to the
// container itself (https://0.0.0.0:3000), so the redirect must be relative or guests land on a dead address.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.fn<(code: string) => Promise<string | null>>();
vi.mock("@/lib/sms/manage", () => ({ manageTokenForCode: (_db: unknown, code: string) => lookup(code) }));
vi.mock("@/lib/data/pg-store", () => ({ getPool: () => ({}) }));

const { GET } = await import("./route");
const call = (code: string) =>
  GET(new NextRequest(`https://0.0.0.0:3000/m/${code}`, { headers: { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200)}` } }), { params: Promise.resolve({ code }) });

describe("GET /m/[code]", () => {
  beforeEach(() => { process.env.DATABASE_URL = "postgres://test/unused"; lookup.mockReset(); });

  it("sends a known code to its manage page with a relative redirect, never the container's own address", async () => {
    lookup.mockResolvedValue("abc123token");
    const res = await call("K7p2Qx");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/b/abc123token");
    expect(res.headers.get("location")).not.toContain("0.0.0.0");
  });

  it("says an unknown code isn't valid", async () => {
    lookup.mockResolvedValue(null);
    const res = await call("nope");
    expect(res.status).toBe(404);
  });
});
