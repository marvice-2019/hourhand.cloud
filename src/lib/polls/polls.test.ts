// Meeting polls. The rules and signed links are plain unit tests; everything that touches the database runs only with
// TEST_DATABASE_URL, against its own database <name>_poll, dropped and recreated on every run.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../../scripts/migrate";
import { seed } from "../../../scripts/seed";
import { LIMITS } from "../billing/plans";
import { freeSlots, isIanaTimeZone } from "../booking";
import { createPgStore } from "../data/pg-store";
import type { DataStore, EventType, User } from "../data/types";
import { POLL_CATALOGS, type PollKey } from "../i18n/poll";
import { LOCALES } from "../i18n/guest";
import { processDueNotifications } from "../jobs/worker";
import type { Mail } from "../mail/mailer";
import {
  cancelPoll, checkPoll, closeDuePolls, confirmPoll, createPoll, pollByToken, pollForHost, signEditToken, submitVotes, tally, validateVote, verifyEditToken,
  voterForEdit, type PollInput, type PollAnswer, type VoteRequest,
} from "./polls";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const key = Buffer.alloc(32, 7);
const otherKey = Buffer.alloc(32, 8);
const at = (iso: string) => new Date(iso);

const input = (times: Date[], extra: Partial<PollInput> = {}): PollInput => ({
  title: "Batch 3 kickoff", durationMinutes: 30, location: { kind: "google_meet" }, times, holdTimes: true, deadline: null, ...extra,
});

describe("poll rules", () => {
  const now = at("2030-06-01T00:00:00Z");
  const t = (d: number) => new Date(now.getTime() + d * DAY);

  it("takes 2 to 8 distinct future times, earliest first", () => {
    expect(checkPoll(input([t(3), t(2)]), now).times).toEqual([t(2), t(3)]);
    expect(() => checkPoll(input([t(2)]), now)).toThrow(/2 to 8/);
    expect(() => checkPoll(input(Array.from({ length: 9 }, (_, i) => t(i + 1))), now)).toThrow(/2 to 8/);
    expect(() => checkPoll(input([t(2), t(2)]), now)).toThrow(/once/);
    expect(() => checkPoll(input([t(-1), t(2)]), now)).toThrow(/future/);
    expect(() => checkPoll(input([t(2), t(3)], { location: { kind: "in_person", value: " " } }), now)).toThrow(/address/);
  });

  it("closes voting after 7 days by default, or at the first proposed time if that is sooner", () => {
    expect(checkPoll(input([t(10), t(12)]), now).deadline).toEqual(t(7));
    expect(checkPoll(input([t(3), t(12)]), now).deadline).toEqual(t(3));
    expect(checkPoll(input([t(10), t(12)], { deadline: t(2) }), now).deadline).toEqual(t(2));
    expect(() => checkPoll(input([t(3), t(12)], { deadline: t(4) }), now)).toThrow(/first proposed time/);
    expect(() => checkPoll(input([t(3), t(12)], { deadline: now }), now)).toThrow(/future/);
  });

  it("tallies yes, if-needed and no per time, and marks the time most people can make", () => {
    const options = [{ id: "a", startAt: t(1), endAt: t(1) }, { id: "b", startAt: t(2), endAt: t(2) }, { id: "c", startAt: t(3), endAt: t(3) }];
    const v = (a: PollAnswer, b: PollAnswer, c: PollAnswer) => ({ votes: { a, b, c } });
    const rows = tally(options, [v("yes", "if_needed", "no"), v("yes", "yes", "no"), v("no", "if_needed", "yes")]);
    expect(rows.map(({ id, yes, ifNeeded, no, best }) => ({ id, yes, ifNeeded, no, best }))).toEqual([
      { id: "a", yes: 2, ifNeeded: 0, no: 1, best: false },
      { id: "b", yes: 1, ifNeeded: 2, no: 0, best: true },
      { id: "c", yes: 1, ifNeeded: 0, no: 2, best: false },
    ]);
    // A tie on who can make it goes to the clearer yeses; nothing is best while nobody can make anything.
    expect(tally(options, [v("yes", "if_needed", "no")]).map((r) => r.best)).toEqual([true, false, false]);
    expect(tally(options, [v("no", "no", "no")]).some((r) => r.best)).toBe(false);
  });

  it("needs a name, an email, a time zone and an answer for every time", () => {
    const body = { name: "Asha", email: "asha@example.com", timezone: "Asia/Kolkata", locale: "ta", votes: { a: "yes", b: "no" } };
    expect(validateVote(body, ["a", "b"], isIanaTimeZone)).toMatchObject({ ok: true, value: { locale: "ta", phone: null, editToken: null, votes: { a: "yes", b: "no" } } });
    const bad = validateVote({ ...body, name: "", email: "x", timezone: "Mars/Base", votes: { a: "maybe", z: "yes" } }, ["a", "b"], isIanaTimeZone);
    expect(bad).toEqual({ ok: false, fields: { name: "errName", email: "errEmail", timezone: "errTimezone", "votes.a": "errAnswer", "votes.b": "errAnswer", votes: "errStale" } });
    // Every error names a line the voting page can show in each language.
    for (const k of Object.values((bad as { fields: Record<string, string> }).fields)) expect(POLL_CATALOGS.en[k as PollKey]).toBeTruthy();
  });

  it("caps Free at one open poll; Solo and Duo have no cap", () => {
    expect(LIMITS.free.openPolls).toBe(1);
    expect(LIMITS.solo.openPolls).toBe(Infinity);
    expect(LIMITS.duo.openPolls).toBe(Infinity);
  });
});

describe("poll edit links", () => {
  const now = at("2030-06-01T00:00:00Z");
  const voter = "6f1c2d3e-0000-4000-8000-000000000001";
  const link = signEditToken(key, voter, new Date(now.getTime() + DAY));

  it("open for their own voter until they expire", () => {
    expect(verifyEditToken(key, link, now)).toBe(voter);
    expect(verifyEditToken(key, link, new Date(now.getTime() + DAY))).toBeNull();
  });

  it("refuse a changed voter, expiry or signature, another key, and junk", () => {
    const [, exp, sig] = link.split(".");
    expect(verifyEditToken(key, `6f1c2d3e-0000-4000-8000-000000000002.${exp}.${sig}`, now)).toBeNull();
    expect(verifyEditToken(key, `${voter}.${Number(exp) + 3600}.${sig}`, now)).toBeNull();
    expect(verifyEditToken(key, `${voter}.${exp}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`, now)).toBeNull();
    expect(verifyEditToken(otherKey, link, now)).toBeNull();
    for (const junk of ["", "abc", `${voter}..${sig}`, `${voter}.${exp}`, `${link}.x`]) expect(verifyEditToken(key, junk, now)).toBeNull();
  });
});

describe("poll catalog", () => {
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it("has every English key, non-empty, with the same placeholders, in every guest language", () => {
    for (const locale of LOCALES) {
      expect(Object.keys(POLL_CATALOGS[locale]).sort(), locale).toEqual(Object.keys(POLL_CATALOGS.en).sort());
      for (const [k, english] of Object.entries(POLL_CATALOGS.en)) {
        const line = POLL_CATALOGS[locale][k as PollKey];
        expect(line?.trim(), `${locale}.${k}`).toBeTruthy();
        expect(placeholders(line), `${locale}.${k}`).toEqual(placeholders(english));
      }
    }
  });
});

const BASE = process.env.TEST_DATABASE_URL;

describe.skipIf(!BASE)("meeting polls (TEST_DATABASE_URL)", () => {
  let pool: pg.Pool;
  let store: DataStore;
  let priya: User;
  let arun: User;
  let intro: EventType;

  beforeAll(async () => {
    const u = new URL(BASE!);
    const name = `${u.pathname.slice(1)}_poll`;
    if (!/^[a-z0-9_]*test[a-z0-9_]*$/.test(name)) throw new Error(`TEST_DATABASE_URL must name a test database, got "${name}"`);
    u.pathname = `/${name}`;
    const admin = new URL(BASE!);
    admin.pathname = "/postgres";
    const c = new pg.Client({ connectionString: admin.toString() });
    await c.connect();
    try {
      await c.query(`drop database if exists ${name} with (force)`);
      await c.query(`create database ${name}`);
    } finally {
      await c.end();
    }
    await migrate(u.toString());
    await seed(u.toString());
    pool = new pg.Pool({ connectionString: u.toString() });
    store = createPgStore(pool);
    priya = (await store.getUserBySlug("priya"))!;
    arun = (await store.getUserBySlug("arun"))!;
    intro = (await store.listEventTypes(priya.id)).find((e) => e.slug === "intro")!;
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** Free 15-minute intro slots of Priya's, each at least an hour clear of the next pick, from `daysAhead` on. */
  const used = new Set<number>();
  async function freeTimes(n: number, daysAhead = 8): Promise<Date[]> {
    const now = new Date();
    const from = new Date(now.getTime() + daysAhead * DAY);
    const slots = await freeSlots(store, priya, intro, from, new Date(from.getTime() + 20 * DAY), now);
    const picked: Date[] = [];
    for (const s of slots) {
      if ([...used, ...picked.map((p) => p.getTime())].some((u) => Math.abs(u - s.getTime()) < 2 * HOUR)) continue;
      picked.push(s);
      if (picked.length === n) break;
    }
    picked.forEach((p) => used.add(p.getTime()));
    return picked;
  }
  const vote = (votes: Record<string, PollAnswer>, who: Partial<VoteRequest> = {}): VoteRequest => ({
    name: "Asha", email: "asha@example.com", phone: null, timezone: "Asia/Kolkata", locale: "en", votes, editToken: null, ...who,
  });
  const offered = async (t: Date) => (await freeSlots(store, priya, intro, t, new Date(t.getTime() + MIN), new Date())).length === 1;

  it("holds the proposed times against other bookings while open, and releases them when voting closes", async () => {
    const times = await freeTimes(2);
    expect(await offered(times[0])).toBe(true);
    const now = new Date();
    const poll = await createPoll(pool, priya.id, input(times, { deadline: new Date(now.getTime() + 2 * DAY) }), "solo", now);
    expect(await offered(times[0])).toBe(false);
    expect(await offered(times[1])).toBe(false);
    // A booking request for a held time is refused like any taken time.
    const { handleCreateBooking } = await import("../booking");
    const attempt = await handleCreateBooking(store, {
      slug: "priya", event: "intro", start: times[0].toISOString(), name: "Ravi", email: "ravi@example.com", timezone: "Asia/Kolkata", idempotencyKey: `poll-hold-${Date.now()}`,
    }, new Date());
    expect(attempt.status).toBe(409);
    // The deadline passing releases them at once, before the job runner gets to it; closing makes it final.
    const later = new Date(now.getTime() + 2 * DAY + MIN);
    expect(await store.listPollHolds(priya.id, times[0], times[1], later)).toEqual([]);
    expect(await closeDuePolls(pool, later)).toBeGreaterThanOrEqual(1);
    expect((await pollForHost(pool, priya.id, poll.id))!.poll.status).toBe("closed");
    expect(await offered(times[0])).toBe(true);
  });

  it("doesn't hold times when the host says so, and cancelling releases them", async () => {
    const times = await freeTimes(2);
    const now = new Date();
    await createPoll(pool, priya.id, input(times, { holdTimes: false }), "solo", now);
    expect(await offered(times[0])).toBe(true);
    const held = await createPoll(pool, priya.id, input(times), "solo", now);
    expect(await offered(times[0])).toBe(false);
    await cancelPoll(pool, priya.id, held.id, now);
    expect(await offered(times[0])).toBe(true);
    await expect(cancelPoll(pool, arun.id, held.id, now)).rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("keeps one vote set per email: a repeat changes nothing and re-sends the link; the signed link edits it", async () => {
    const times = await freeTimes(2);
    const now = new Date();
    const poll = await createPoll(pool, priya.id, input(times), "solo", now);
    const { options } = (await pollForHost(pool, priya.id, poll.id))!;
    const [a, b] = options.map((o) => o.id);

    const first = await submitVotes(pool, poll.token, vote({ [a]: "yes", [b]: "no" }), key, now);
    expect(first).toMatchObject({ status: "saved", created: true });
    // Same address, any case, without the link: refused, nothing changes, and the link is emailed again (once an hour).
    expect(await submitVotes(pool, poll.token, vote({ [a]: "no", [b]: "no" }, { email: "ASHA@example.com", name: "Someone else" }), key, now)).toEqual({ status: "exists" });
    expect(await submitVotes(pool, poll.token, vote({ [a]: "no", [b]: "no" }), key, now)).toEqual({ status: "exists" });
    let detail = (await pollForHost(pool, priya.id, poll.id))!;
    expect(detail.voters).toHaveLength(1);
    expect(detail.voters[0]).toMatchObject({ name: "Asha", votes: { [a]: "yes", [b]: "no" } });
    const voterId = (first as { voterId: string }).voterId;
    const { rows: mails } = await pool.query("select kind, recipient from notifications where dedupe_key like $1 order by created_at", [`poll-voter:${voterId}:%`]);
    expect(mails).toEqual([{ kind: "poll_voter_link", recipient: "asha@example.com" }, { kind: "poll_voter_link", recipient: "asha@example.com" }]);

    // With the signed link: the same voter's answers are replaced.
    const editToken = signEditToken(key, voterId, poll.deadline);
    expect(await voterForEdit(pool, poll.token, editToken, key, now)).toMatchObject({ email: "asha@example.com", votes: { [a]: "yes", [b]: "no" } });
    expect(await submitVotes(pool, poll.token, vote({ [a]: "if_needed", [b]: "yes" }, { editToken, name: "Asha R" }), key, now)).toMatchObject({ status: "saved", created: false, voterId });
    detail = (await pollForHost(pool, priya.id, poll.id))!;
    expect(detail.voters).toHaveLength(1);
    expect(detail.voters[0]).toMatchObject({ name: "Asha R", votes: { [a]: "if_needed", [b]: "yes" } });
    expect(detail.options.map(({ yes, ifNeeded, no }) => ({ yes, ifNeeded, no }))).toEqual([{ yes: 0, ifNeeded: 1, no: 0 }, { yes: 1, ifNeeded: 0, no: 0 }]);
    // A forged or another key's link edits nothing.
    expect(await submitVotes(pool, poll.token, vote({ [a]: "no", [b]: "no" }, { editToken: signEditToken(otherKey, voterId, poll.deadline) }), key, now)).toEqual({ status: "bad_edit_link" });
    // The public page shows counts only.
    const pub = (await pollByToken(pool, poll.token, now))!;
    expect(pub).toMatchObject({ voterCount: 1, open: true, host: { name: "Priya Raman" } });
    expect(JSON.stringify(pub)).not.toContain("asha@example.com");
  });

  it("confirms one time for everyone who said yes or if-needed, only them, and releases the other times", async () => {
    const times = await freeTimes(3);
    const now = new Date();
    const poll = await createPoll(pool, priya.id, input(times), "solo", now);
    const [a, b, c] = (await pollForHost(pool, priya.id, poll.id))!.options.map((o) => o.id);
    await submitVotes(pool, poll.token, vote({ [a]: "yes", [b]: "no", [c]: "no" }, { email: "yes@example.com", name: "Yesha", locale: "ta" }), key, now);
    await submitVotes(pool, poll.token, vote({ [a]: "if_needed", [b]: "yes", [c]: "no" }, { email: "maybe@example.com", name: "Mayank" }), key, now);
    await submitVotes(pool, poll.token, vote({ [a]: "no", [b]: "yes", [c]: "yes" }, { email: "no@example.com", name: "Nora" }), key, now);

    // Priya's calendar can take events (the seed's connection has no stored credentials otherwise).
    await pool.query("update calendar_connections set credentials_encrypted = '\\x01'::bytea where user_id = $1", [priya.id]);
    expect(await confirmPoll(pool, arun.id, poll.id, a, now).catch((e) => e.name)).toBe("NotFoundError");
    const done = await confirmPoll(pool, priya.id, poll.id, a, now);
    expect(done.status).toBe("confirmed");
    const ids = (done as { bookingIds: string[] }).bookingIds;
    const bookings = await Promise.all(ids.map((id) => store.getBooking(priya.id, id)));
    expect(bookings.map((x) => x!.invitee.email).sort()).toEqual(["maybe@example.com", "yes@example.com"]);
    expect(bookings.every((x) => x!.status === "confirmed" && x!.startAt.getTime() === times[0].getTime() && x!.endAt.getTime() === times[0].getTime() + 30 * MIN)).toBe(true);
    expect(new Set(bookings.map((x) => x!.classKey)).size).toBe(1);
    expect(bookings.find((x) => x!.invitee.email === "yes@example.com")!.invitee.locale).toBe("ta");
    // Each attendee gets the normal confirmation; the host's calendar gets one event for the meeting; no host email per person.
    const { rows: queued } = await pool.query("select kind, count(*)::int as n from notifications where booking_id = any($1::uuid[]) and kind in ('booked_guest', 'booked_host', 'calendar_create') group by kind order by kind", [ids]);
    expect(queued).toEqual([{ kind: "booked_guest", n: 2 }, { kind: "calendar_create", n: 1 }]);

    const after = (await pollForHost(pool, priya.id, poll.id))!;
    expect(after.poll).toMatchObject({ status: "confirmed", confirmedStart: times[0] });
    expect(after.voters.filter((v) => v.bookingId).map((v) => v.name).sort()).toEqual(["Mayank", "Yesha"]);
    // The other proposed times are free again; the chosen one is now booked.
    expect(await offered(times[1])).toBe(true);
    expect(await offered(times[2])).toBe(true);
    expect(await offered(times[0])).toBe(false);
    await expect(confirmPoll(pool, priya.id, poll.id, b, now)).rejects.toMatchObject({ name: "PollStateError", status: "confirmed" });
    expect(await submitVotes(pool, poll.token, vote({ [a]: "yes", [b]: "yes", [c]: "yes" }, { email: "late@example.com" }), key, now)).toEqual({ status: "closed" });
  });

  it("shows a clash instead of booking over a time taken since it was proposed", async () => {
    const [taken, other] = await freeTimes(2);
    const now = new Date();
    const poll = await createPoll(pool, priya.id, input([taken, other], { holdTimes: false }), "solo", now);
    const [x, y] = (await pollForHost(pool, priya.id, poll.id))!.options.map((o) => o.id);
    await submitVotes(pool, poll.token, vote({ [x]: "yes", [y]: "no" }), key, now);
    // A guest books that time after the poll went out (it wasn't held).
    await store.createBooking({ eventTypeId: intro.id, startAt: taken, idempotencyKey: `clash-${Date.now()}`, invitee: { name: "Ravi", email: "ravi@example.com", timezone: "Asia/Kolkata", phone: null, answers: [] } });
    expect(await confirmPoll(pool, priya.id, poll.id, x, now)).toMatchObject({ status: "clash", clashes: [{ kind: "booking", guestName: "Ravi" }] });
    const still = (await pollForHost(pool, priya.id, poll.id))!;
    expect(still.poll.status).toBe("open");
    expect(still.voters.every((v) => v.bookingId === null)).toBe(true);

    // Busy time on the host's calendar is a clash too.
    const { rows: [cal] } = await pool.query("select id from calendars where user_id = $1 limit 1", [priya.id]);
    const third = await createPoll(pool, priya.id, input(await freeTimes(2), { holdTimes: false }), "solo", now);
    const opts = (await pollForHost(pool, priya.id, third.id))!.options;
    await submitVotes(pool, third.token, vote({ [opts[0].id]: "yes", [opts[1].id]: "yes" }), key, now);
    await pool.query("insert into busy_blocks (calendar_id, user_id, external_event_id, busy) values ($1, $2, 'poll-test', tstzrange($3, $4, '[)'))", [cal.id, priya.id, opts[0].startAt, opts[0].endAt]);
    expect(await confirmPoll(pool, priya.id, third.id, opts[0].id, now)).toMatchObject({ status: "clash", clashes: [{ kind: "calendar" }] });
    // Nobody who can make a time: nothing to book.
    await pool.query("update poll_votes set answer = 'no' where option_id = $1", [opts[1].id]);
    expect(await confirmPoll(pool, priya.id, third.id, opts[1].id, now)).toEqual({ status: "nobody" });
  });

  it("closes at the deadline: no more votes, the host is emailed to pick, and can still confirm", async () => {
    const times = await freeTimes(2);
    const now = new Date();
    const poll = await createPoll(pool, priya.id, input(times, { deadline: new Date(now.getTime() + HOUR) }), "solo", now);
    const [a, b] = (await pollForHost(pool, priya.id, poll.id))!.options.map((o) => o.id);
    await submitVotes(pool, poll.token, vote({ [a]: "yes", [b]: "no" }, { email: "kiran@example.com", name: "Kiran" }), key, now);
    expect(await closeDuePolls(pool, now)).toBe(0);
    const past = new Date(now.getTime() + HOUR + MIN);
    expect(await submitVotes(pool, poll.token, vote({ [a]: "yes", [b]: "yes" }, { email: "late@example.com" }), key, past)).toEqual({ status: "closed" });
    expect(await closeDuePolls(pool, past)).toBe(1);
    expect(await closeDuePolls(pool, past)).toBe(0);
    const { rows } = await pool.query("select kind, recipient from notifications where dedupe_key = $1", [`poll:${poll.id}:closed`]);
    expect(rows).toEqual([{ kind: "poll_host_closed", recipient: priya.email }]);
    expect((await pollByToken(pool, poll.token, past))!).toMatchObject({ open: false, poll: { status: "closed" } });
    // An hour on, the calendar must have synced since for the time to be trusted.
    expect(await confirmPoll(pool, priya.id, poll.id, a, past)).toMatchObject({ status: "clash", clashes: [{ kind: "calendar_stale" }] });
    await pool.query("update calendar_connections set last_synced_at = $2 where user_id = $1", [priya.id, past]);
    expect(await confirmPoll(pool, priya.id, poll.id, a, past)).toMatchObject({ status: "confirmed" });
  });

  it("allows Free one open poll at a time; a closed or cancelled one frees the place", async () => {
    const now = new Date();
    const times = [new Date(now.getTime() + 30 * DAY), new Date(now.getTime() + 31 * DAY)];
    const first = await createPoll(pool, arun.id, input(times, { holdTimes: false }), "free", now);
    await expect(createPoll(pool, arun.id, input(times, { holdTimes: false }), "free", now)).rejects.toMatchObject({ name: "PollLimitError", limit: 1 });
    // Paid plans aren't capped.
    await createPoll(pool, arun.id, input(times, { holdTimes: false }), "solo", now);
    await cancelPoll(pool, arun.id, first.id, now);
    const { rows: [{ n }] } = await pool.query("select count(*)::int as n from polls where user_id = $1 and status = 'open'", [arun.id]);
    expect(n).toBe(1); // the Solo one is still open, so Free stays at its cap
    await expect(createPoll(pool, arun.id, input(times, { holdTimes: false }), "free", now)).rejects.toMatchObject({ name: "PollLimitError" });
    await pool.query("update polls set status = 'cancelled' where user_id = $1", [arun.id]);
    await expect(createPoll(pool, arun.id, input(times, { holdTimes: false }), "free", now)).resolves.toMatchObject({ status: "open" });
  });

  it("gives every attendee the meeting's one video link, wherever the shared calendar event put it", async () => {
    const times = await freeTimes(2);
    const now = new Date();
    const poll = await createPoll(pool, priya.id, input(times), "solo", now);
    const [a, b] = (await pollForHost(pool, priya.id, poll.id))!.options.map((o) => o.id);
    await submitVotes(pool, poll.token, vote({ [a]: "yes", [b]: "no" }, { email: "first@example.com", name: "First" }), key, now);
    await submitVotes(pool, poll.token, vote({ [a]: "if_needed", [b]: "no" }, { email: "second@example.com", name: "Second" }), key, now);
    const { bookingIds } = (await confirmPoll(pool, priya.id, poll.id, a, now)) as { bookingIds: string[] };
    // The calendar write landed on the first seat and put the Meet link there; the second seat has none of its own.
    await pool.query("update bookings set join_url = 'https://meet.google.com/abc-defg-hij' where id = $1", [bookingIds[0]]);
    const sent: Mail[] = [];
    const mailer = { async send(m: Mail) { sent.push(m); return { id: `m${sent.length}` }; } };
    for (let i = 0; i < 30; i++) if ((await processDueNotifications(pool, mailer, { baseUrl: "https://hourhand.test", now })).claimed === 0) break;
    for (const to of ["first@example.com", "second@example.com"]) {
      const mail = sent.find((m) => m.to === to && m.subject.startsWith("Booked"));
      expect(mail?.text, to).toContain("https://meet.google.com/abc-defg-hij");
    }
  });

  it("emails the invitee a working change link in their language, and the host the tally when voting closes", async () => {
    process.env.POLL_LINK_SECRET = "test-poll-secret";
    const { pollLinkKey } = await import("./polls");
    const times = await freeTimes(2);
    const now = new Date();
    const poll = await createPoll(pool, priya.id, input(times, { deadline: new Date(now.getTime() + HOUR) }), "solo", now);
    const [a, b] = (await pollForHost(pool, priya.id, poll.id))!.options.map((o) => o.id);
    await submitVotes(pool, poll.token, vote({ [a]: "yes", [b]: "if_needed" }, { email: "meena@example.com", name: "Meena", locale: "hi" }), pollLinkKey(), now);
    const sent: Mail[] = [];
    const mailer = { async send(m: Mail) { sent.push(m); return { id: `m${sent.length}` }; } };
    for (let i = 0; i < 20; i++) if ((await processDueNotifications(pool, mailer, { baseUrl: "https://hourhand.test", now })).claimed === 0) break;
    const mine = sent.filter((m) => m.to === "meena@example.com");
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toContain("Batch 3 kickoff");
    expect(mine[0].text).toContain("नमस्ते Meena");
    const url = /https:\/\/hourhand\.test\/v\/[0-9a-f]{48}\?edit=([^&\s]+)&lang=hi/.exec(mine[0].text)!;
    expect(verifyEditToken(pollLinkKey(), decodeURIComponent(url[1]), now)).toBeTruthy();

    const past = new Date(now.getTime() + HOUR + MIN);
    await closeDuePolls(pool, past);
    sent.length = 0;
    for (let i = 0; i < 20; i++) if ((await processDueNotifications(pool, mailer, { baseUrl: "https://hourhand.test", now: past })).claimed === 0) break;
    const host = sent.find((m) => m.to === priya.email && m.subject.startsWith("Voting closed"))!;
    expect(host.text).toContain("1 yes, 0 if needed, 0 no (best)");
    expect(host.text).toContain(`https://hourhand.test/dashboard/polls/${poll.id}`);
    delete process.env.POLL_LINK_SECRET;
  });
});
