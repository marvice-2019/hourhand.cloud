// The host's join page reads the booking id from its route folder (/dashboard/bookings/[id]/video). A param name that
// doesn't match the folder arrives as undefined and every host link would say "not found", which no unit test of the
// join rules would notice, so this calls the page itself.
import { describe, expect, it, vi } from "vitest";

const resolveHostJoin = vi.fn();
vi.mock("@/lib/video/join", () => ({ resolveHostJoin: (...a: unknown[]) => resolveHostJoin(...a) }));
vi.mock("@/lib/video/server", () => ({ joinDeps: () => ({}) }));
vi.mock("@/lib/i18n/host/server", () => ({ getHostI18n: async () => ({ t: (k: string) => k, locale: "en" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw new Error(`redirect:${url}`); },
  notFound: () => { throw new Error("notFound"); },
}));

describe("the host's join page", () => {
  it("passes the booking id from its [id] folder to the join check", async () => {
    resolveHostJoin.mockResolvedValue({ ok: true, role: "host", url: "https://meet.example.test/room?jwt=x" });
    const { default: HostJoinPage } = await import("../../app/dashboard/bookings/[id]/video/page");
    await expect(HostJoinPage({ params: Promise.resolve({ id: "11111111-1111-1111-1111-111111111111" }) })).rejects.toThrow("redirect:https://meet.example.test/room?jwt=x");
    expect(resolveHostJoin).toHaveBeenCalledWith(expect.anything(), "11111111-1111-1111-1111-111111111111");
  });
});
