// The client file page and its actions with the real session check: a Duo second person managing the owner's account
// sees the timeline but no note text, and can't save notes or change "keep versions". Next's request APIs are stubbed;
// the data is the in-memory store with Priya's demo bookings.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../data/memory-store";
import type { DataStore } from "../data/types";

const MEMBER = { id: "22222222-2222-4222-8222-222222222222", email: "member@example.com", name: "Member", slug: "member", timezone: "Asia/Kolkata", timeFormat: "12h", locale: "en" };
const state = { signedIn: "", acting: undefined as string | undefined };
const SECRET_CLIENT = "Client secret: discussed panic attacks";
const SECRET_SESSION = "Session secret: grounding exercise";

const real: DataStore = createMemoryStore();
const noteCalls: string[] = [];
// The real store, with note reads and writes recorded so a test can say they never happened.
const store = new Proxy(real, {
  get(t, p) {
    if (p === "getUser") return async (id: string) => (id === MEMBER.id ? MEMBER : t.getUser(id));
    const v = Reflect.get(t, p);
    if (typeof p === "string" && /note/i.test(p) && typeof v === "function") return (...a: unknown[]) => { noteCalls.push(p); return (v as (...x: unknown[]) => unknown).apply(t, a); };
    return v;
  },
});

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: (name: string) => (name === "hh_acting" && state.acting ? { value: state.acting } : undefined) }),
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/auth", () => ({
  authEnabled: () => true,
  resolveBaseUrl: () => "https://hourhand.test",
  getAuth: () => ({ api: { getSession: async () => ({ user: { id: state.signedIn } }) } }),
}));
// No Postgres here: the page falls back to the memory store's bookings (getPool returns null).
vi.mock("@/lib/data/pg-store", () => ({ getPool: () => null }));
vi.mock("@/lib/seats", () => ({ canActFor: async (_db: unknown, member: string, owner: string) => member === MEMBER.id && owner === state.acting }));
vi.mock("@/lib/data", () => ({ store }));

const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

/** Every string a rendered server component tree carries, in text or in props (element types and functions skipped). */
function flatten(node: unknown, seen = new Set<unknown>()): string {
  if (typeof node === "string" || typeof node === "number") return `${node} `;
  if (!node || typeof node !== "object" || seen.has(node)) return "";
  seen.add(node);
  if (Array.isArray(node)) return node.map((n) => flatten(n, seen)).join("");
  if ("$$typeof" in node && "props" in node) return flatten((node as { props: unknown }).props, seen);
  if (node instanceof Date) return `${node.toISOString()} `;
  return Object.values(node).map((v) => flatten(v, seen)).join("");
}

describe("client file: notes are the owner's alone", () => {
  let ownerId: string;
  let key: string;
  let bookingId: string;

  beforeAll(async () => {
    const owner = (await real.getCurrentUser())!;
    ownerId = owner.id;
    const b = (await real.listBookings(ownerId)).find((x) => x.status === "confirmed")!;
    bookingId = b.id;
    const { clientKey } = await import("@/lib/clients");
    key = clientKey(b.invitee.email);
    await real.saveClientNote(ownerId, b.invitee.email, SECRET_CLIENT);
    await real.saveBookingNote(ownerId, bookingId, SECRET_SESSION);
  });
  beforeEach(() => { noteCalls.length = 0; vi.resetModules(); });

  const render = async () => {
    const { default: Page } = await import("@/app/dashboard/clients/[key]/page");
    return flatten(await Page({ params: Promise.resolve({ key }), searchParams: Promise.resolve({}) }));
  };

  it("shows the owner their client note and session notes", async () => {
    state.signedIn = ownerId; state.acting = undefined;
    const html = await render();
    expect(html).toContain(SECRET_CLIENT);
    expect(html).toContain(SECRET_SESSION);
  });

  it("shows a Duo second person the timeline but never reads or renders a note", async () => {
    state.signedIn = MEMBER.id; state.acting = ownerId;
    const html = await render();
    expect(html).toContain(bookingId);
    expect(html).toContain("private to the account owner");
    expect(html).not.toContain("panic");
    expect(html).not.toContain("grounding");
    expect(noteCalls).toEqual([]);
  });

  it("sends a Duo second person away from saving notes or changing versions", async () => {
    state.signedIn = MEMBER.id; state.acting = ownerId;
    const { saveSessionNoteFromFile, setKeepVersionsAction, saveClientNoteAction } = await import("@/app/dashboard/clients/actions");
    await expect(saveSessionNoteFromFile(form({ key, bookingId, note: "x" }))).rejects.toThrow("REDIRECT /dashboard/bookings");
    await expect(setKeepVersionsAction(form({ key, keep: "1" }))).rejects.toThrow("REDIRECT /dashboard/bookings");
    await expect(saveClientNoteAction(form({ key, note: "x" }))).rejects.toThrow("REDIRECT /dashboard/bookings");
    expect(noteCalls).toEqual([]);
    expect(await real.getBookingNote(ownerId, bookingId)).toBe(SECRET_SESSION);
    expect(await real.getKeepNoteVersions(ownerId)).toBe(false);
  });

  it("lets the owner save a session note from the file, with a history line naming them", async () => {
    state.signedIn = ownerId; state.acting = undefined;
    const { saveSessionNoteFromFile } = await import("@/app/dashboard/clients/actions");
    await expect(saveSessionNoteFromFile(form({ key, bookingId, note: "Updated from the file" }))).rejects.toThrow(`REDIRECT /dashboard/clients/${key}?saved=session#b-${bookingId}`);
    expect(await real.getBookingNote(ownerId, bookingId)).toBe("Updated from the file");
    const [latest] = await real.listNoteRevisions(ownerId, { bookingIds: [bookingId] });
    expect([latest.action, latest.actorId]).toEqual(["saved", ownerId]);
  });

  it("refuses a session note on a booking that isn't the owner's", async () => {
    state.signedIn = ownerId; state.acting = undefined;
    const { saveSessionNoteFromFile } = await import("@/app/dashboard/clients/actions");
    await expect(saveSessionNoteFromFile(form({ key, bookingId: "someone-elses", note: "x" }))).rejects.toThrow("REDIRECT /dashboard/clients?error=not_found");
  });
});
