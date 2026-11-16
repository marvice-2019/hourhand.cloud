// A Duo second person managing an owner's account can't read or write the owner's private notes, export or erase a
// client, or answer data requests. Runs the real
// session check (getHostContext / requireOwnAccount) and server actions, with Next's request APIs stubbed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com", name: "Owner", slug: "owner", timezone: "Asia/Kolkata", timeFormat: "12h", locale: "en" };
const MEMBER = { id: "22222222-2222-4222-8222-222222222222", email: "member@example.com", name: "Member", slug: "member", timezone: "Asia/Kolkata", timeFormat: "12h", locale: "en" };
const state = { signedIn: MEMBER.id, acting: OWNER.id as string | undefined };
const calls: string[] = [];

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: (name: string) => (name === "hh_acting" && state.acting ? { value: state.acting } : undefined) }),
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/auth", () => ({
  authEnabled: () => true,
  getAuth: () => ({ api: { getSession: async () => ({ user: { id: state.signedIn } }) } }),
}));
vi.mock("@/lib/data/pg-store", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/seats", () => ({ canActFor: async (_db: unknown, member: string, owner: string) => member === MEMBER.id && owner === OWNER.id }));
vi.mock("@/lib/privacy/rights", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rights")>()),
  eraseClient: async (_db: unknown, host: string) => { calls.push(`eraseClient:${host}`); return { erasureId: "e1" }; },
  exportClient: async (_db: unknown, host: string) => { calls.push(`exportClient:${host}`); return null; },
  resolveRequest: async (_db: unknown, host: string) => { calls.push(`resolveRequest:${host}`); return true; },
}));
vi.mock("@/lib/data", () => ({
  store: {
    getUser: async (id: string) => [OWNER, MEMBER].find((u) => u.id === id) ?? null,
    listBookings: async () => [{ id: "b1", invitee: { email: "client@example.com" } }],
    saveClientNote: async (host: string) => { calls.push(`saveClientNote:${host}`); },
    saveBookingNote: async (host: string) => { calls.push(`saveBookingNote:${host}`); },
  },
}));

const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("private notes are the owner's alone", () => {
  beforeEach(() => { calls.length = 0; vi.resetModules(); });

  it("sends a Duo second person away from saving the owner's client or session notes", async () => {
    state.signedIn = MEMBER.id; state.acting = OWNER.id;
    const { clientKey } = await import("@/lib/clients");
    const { saveClientNoteAction } = await import("@/app/dashboard/clients/actions");
    const { saveSessionNote } = await import("@/app/dashboard/bookings/[id]/actions");
    await expect(saveClientNoteAction(form({ key: clientKey("client@example.com"), note: "x" }))).rejects.toThrow("REDIRECT /dashboard/bookings");
    await expect(saveSessionNote(form({ bookingId: "b1", note: "x" }))).rejects.toThrow("REDIRECT /dashboard/bookings");
    expect(calls).toEqual([]);
  });

  it("lets the owner save them", async () => {
    state.signedIn = OWNER.id; state.acting = undefined;
    const { clientKey } = await import("@/lib/clients");
    const { saveClientNoteAction } = await import("@/app/dashboard/clients/actions");
    const { saveSessionNote } = await import("@/app/dashboard/bookings/[id]/actions");
    await expect(saveClientNoteAction(form({ key: clientKey("client@example.com"), note: "x" }))).rejects.toThrow(/REDIRECT \/dashboard\/clients\/.*saved=1/);
    await expect(saveSessionNote(form({ bookingId: "b1", note: "x" }))).rejects.toThrow("REDIRECT /dashboard/bookings/b1?done=note_saved");
    expect(calls).toEqual([`saveClientNote:${OWNER.id}`, `saveBookingNote:${OWNER.id}`]);
  });

  it("sends a Duo second person away from exporting, erasing or answering requests", async () => {
    state.signedIn = MEMBER.id; state.acting = OWNER.id;
    const { clientKey } = await import("@/lib/clients");
    const key = clientKey("client@example.com");
    const { eraseClientAction, resolveRequestAction } = await import("@/app/dashboard/clients/privacy-actions");
    const { GET } = await import("@/app/dashboard/clients/[key]/export/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest(`http://localhost/dashboard/clients/${key}/export?format=json&notes=1`), { params: Promise.resolve({ key }) });
    expect(res.status).toBe(403);
    await expect(eraseClientAction(form({ key, confirm: "client@example.com" }))).rejects.toThrow("REDIRECT /dashboard/bookings");
    await expect(resolveRequestAction(form({ id: "33333333-3333-4333-8333-333333333333", status: "done" }))).rejects.toThrow("REDIRECT /dashboard/bookings");
    expect(calls).toEqual([]);
  });

  it("lets the owner export and, with the email typed exactly, erase", async () => {
    state.signedIn = OWNER.id; state.acting = undefined;
    const { clientKey } = await import("@/lib/clients");
    const key = clientKey("client@example.com");
    const { eraseClientAction } = await import("@/app/dashboard/clients/privacy-actions");
    const { GET } = await import("@/app/dashboard/clients/[key]/export/route");
    const { NextRequest } = await import("next/server");
    expect((await GET(new NextRequest(`http://localhost/x?format=json`), { params: Promise.resolve({ key }) })).status).toBe(404); // the stub has no data
    await expect(eraseClientAction(form({ key, confirm: "someone else" }))).rejects.toThrow("confirm_mismatch");
    expect(calls).toEqual([`exportClient:${OWNER.id}`]);
    await expect(eraseClientAction(form({ key, confirm: " CLIENT@example.com " }))).rejects.toThrow("REDIRECT /dashboard/clients?erased=1");
    expect(calls).toEqual([`exportClient:${OWNER.id}`, `eraseClient:${OWNER.id}`]);
  });
});
