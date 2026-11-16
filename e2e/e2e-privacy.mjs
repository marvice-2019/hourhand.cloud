// Roadmap 3.10 end to end: consent log, sealed notes, client export, guest data requests, erasure, and the Duo second person kept out.
// Usage: node e2e/e2e-privacy.mjs <port> <server-log> <database-url>
import { readFileSync } from "node:fs";
import pg from "pg";

const lastLink = (text, email) => [...text.matchAll(/\[dev\] email to ([^:]+): Your Hourhand sign-in link\n[\s\S]*?\nSign in: (\S+)/g)]
  .filter((m) => m[1] === email).at(-1)?.[2];
const [port, logPath, databaseUrl] = process.argv.slice(2);
const B = `http://localhost:${port}`;
let fail = 0;
const check = (ok, label) => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const t = () => AbortSignal.timeout(15000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = () => readFileSync(logPath, "utf8");
async function waitFor(pred, ms = 25000) { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(500); } return pred(); }
const ip = "203.0.113.94";

function jar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    take(res) {
      for (const raw of res.headers.getSetCookie()) {
        const [pair] = raw.split(";"); const i = pair.indexOf("=");
        const name = pair.slice(0, i), value = pair.slice(i + 1);
        if (/max-age=0/i.test(raw) || value === "") cookies.delete(name); else cookies.set(name, value);
      }
    },
  };
}
const get = async (path, j) => {
  const res = await fetch(B + path, { redirect: "manual", headers: { "x-forwarded-for": ip, ...(j ? { cookie: j.header() } : {}) }, signal: t() });
  j?.take(res);
  const text = res.text.bind(res);
  res.text = async () => (await text()).replace(/<!-- -->/g, "");
  return res;
};
async function signIn(email) {
  await fetch(`${B}/api/auth/sign-in/magic-link`, { method: "POST", headers: { "content-type": "application/json", origin: B, "x-forwarded-for": ip }, body: JSON.stringify({ email, callbackURL: "/dashboard" }), signal: t() });
  await sleep(300);
  const j = jar();
  await get(lastLink(log(), email).replace(/^https?:\/\/[^/]+/, ""), j);
  return j;
}
/** Posts the no-JavaScript form on `path` whose markup contains `marker`, with `fields` filled in. */
async function submitForm(j, path, marker, fields) {
  const html = await (await get(path, j)).text();
  const form = [...html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]).find((f) => f.includes(marker));
  if (!form) return null;
  const fd = new FormData();
  for (const m of form.matchAll(/<input[^>]*name="([^"]+)"(?:\s+value="([^"]*)")?[^>]*>/g)) if (m[1].startsWith("$ACTION")) fd.append(m[1], (m[2] ?? "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(B + path, { method: "POST", body: fd, redirect: "manual", headers: { cookie: j.header(), origin: B, "x-forwarded-for": ip }, signal: t() });
  j.take(res);
  return res;
}
await sleep(2500);
const pool = new pg.Pool({ connectionString: databaseUrl });
const { rows: [priya] } = await pool.query("select id, email, name from users where slug = 'priya'");
const { rows: [arun] } = await pool.query("select id, email, name from users where slug = 'arun'");
const { rows: [et] } = await pool.query("select id from event_types where user_id = $1 and slug = 'coaching'", [priya.id]);
const questions = (await pool.query("select id, required from custom_questions where event_type_id = $1", [et.id])).rows;

// A guest books through the real API, ticking WhatsApp updates: the consent log is written with the booking.
const from = new Date(Date.now() + 2 * 86400000), to = new Date(Date.now() + 16 * 86400000);
const slots = (await (await fetch(`${B}/api/slots?${new URLSearchParams({ slug: "priya", event: "coaching", from: from.toISOString(), to: to.toISOString(), tz: "Asia/Kolkata" })}`, { headers: { "x-forwarded-for": ip } })).json()).slots;
const guestEmail = "nila.privacy@example.com";
const booked = await fetch(`${B}/api/bookings`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({
  slug: "priya", event: "coaching", start: slots[0], name: "Nila Raman", email: guestEmail, phone: "+91 98765 11111", whatsappOptIn: true, timezone: "Asia/Kolkata", locale: "ta",
  answers: Object.fromEntries(questions.filter((q) => q.required).map((q) => [q.id, "Sleep and stress"])), idempotencyKey: "e2e-privacy-0001" }) });
const { bookingId, manageToken } = await booked.json();
check(booked.status === 201, `guest books (${booked.status})`);
const consent = (await pool.query("select purpose, granted, locale, channel from consent_records where booking_id = $1 order by purpose", [bookingId])).rows;
check(consent.length === 2 && consent[0].purpose === "booking" && consent[1].purpose === "whatsapp_updates" && consent.every((c) => c.locale === "ta" && c.channel === "booking_page"), "consent log written with the booking");

// The owner sees the log, saves a sealed session note.
const pj = await signIn(priya.email);
const key = /href="\/dashboard\/clients\/([0-9a-f]{20})"[^>]*>Nila Raman/.exec(await (await get("/dashboard/clients", pj)).text())?.[1];
check(Boolean(key), "client is listed");
let html = await (await get(`/dashboard/clients/${key}`, pj)).text();
check(html.includes("Consent log") && html.includes("WhatsApp updates") && html.includes("Export everything"), "client page shows the consent log and the data tools");
let res = await submitForm(pj, `/dashboard/bookings/${bookingId}`, "Save session note", { bookingId, note: "Sleep hygiene plan, week 1." });
check(res?.status === 303 && (res.headers.get("location") ?? "").includes("note_saved"), `owner saves a session note (${res?.status} ${res?.headers.get("location")})`);
const sealed = (await pool.query("select note_sealed from booking_notes where booking_id = $1", [bookingId])).rows[0]?.note_sealed;
check(Buffer.isBuffer(sealed) && !sealed.toString("utf8").includes("Sleep hygiene"), "session note is sealed at rest");
check((await (await get(`/dashboard/bookings/${bookingId}`, pj)).text()).includes("Sleep hygiene plan"), "owner reads the session note");

// Export: JSON and the printable copy, notes only when asked.
res = await get(`/dashboard/clients/${key}/export?format=json&notes=1`, pj);
const x = res.status === 200 ? await res.json() : null;
check(x?.bookings?.[0]?.sessionNote === "Sleep hygiene plan, week 1." && x.consentLog.length === 2 && x.client.email === guestEmail, `owner exports JSON with notes (${res.status})`);
res = await get(`/dashboard/clients/${key}/export?format=html`, pj);
html = await res.text();
check(res.status === 200 && html.includes("Data held about Nila Raman") && !html.includes("Sleep hygiene"), "printable copy leaves notes out unless asked");
check((await get(`/dashboard/clients/${key}/export?format=json`)).status === 401, "export needs sign-in");

// The guest asks from their manage link; the host is emailed without the guest's details; the deadline shows.
res = await fetch(`${B}/api/b/${manageToken}/data-request`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ kind: "erasure" }) });
const req = await res.json();
check(res.status === 201 && Math.round((new Date(req.dueAt) - Date.now()) / 86400000) === 90, `guest asks for deletion, due in 90 days (${res.status})`);
check(await waitFor(() => log().includes(`[dev] email to ${priya.email}: A client asked you to delete their data`)), "host is emailed");
check(!/email to [^:]+: A client asked[\s\S]{0,1500}Nila/.test(log()), "the email doesn't name the guest");
check((await (await get(`/b/${manageToken}?lang=ta`)).text()).includes("உங்கள் தரவு"), "manage page shows the data section in the guest's language");
html = await (await get("/dashboard/clients/requests", pj)).text();
check(html.includes("Delete their data") && html.includes("Respond by"), "requests page lists it with the deadline");

// A Duo second person managing Priya's account can't read notes, export or erase.
await pool.query("insert into subscriptions (user_id, plan, status) values ($1, 'duo', 'active') on conflict (user_id) do update set plan = 'duo', status = 'active'", [priya.id]);
await pool.query("insert into seats (owner_id, member_email, member_id, accepted_at) values ($1, $2, $3, now())", [priya.id, arun.email, arun.id]);
const aj = await signIn(arun.email);
res = await submitForm(aj, "/dashboard/event-types", `Manage ${priya.name}`, {});
check(res?.status === 303, `member switches to the owner's account (${res?.status})`);
html = await (await get(`/dashboard/bookings/${bookingId}`, aj)).text();
check(html.includes("private to the account owner") && !html.includes("Sleep hygiene"), "member can't read the session note");
html = await (await get(`/dashboard/clients/${key}`, aj)).text();
check(!html.includes("Erase for good") && !html.includes("Export everything"), "member sees no export or erase");
check((await get(`/dashboard/clients/${key}/export?format=json&notes=1`, aj)).status === 403, "member's export is refused");
res = await get("/dashboard/clients/requests", aj);
check(res.status === 307 || res.status === 303, `member is sent away from requests (${res.status})`);

// Erasure: refused while upcoming, then done with the typed email; logged who and when only.
res = await submitForm(pj, `/dashboard/clients/${key}`, 'name="confirm"', { key, confirm: guestEmail });
check((res?.headers.get("location") ?? "").includes("erase_upcoming"), `erasing is refused while a booking is upcoming (${res?.status} ${res?.headers.get("location")})`);
await pool.query("update bookings set status = 'cancelled', cancelled_at = now(), cancelled_by = 'host' where id = $1", [bookingId]);
res = await submitForm(pj, `/dashboard/clients/${key}`, 'name="confirm"', { key, confirm: "wrong@example.com" });
check((res?.headers.get("location") ?? "").includes("confirm_mismatch"), "a mistyped email erases nothing");
res = await submitForm(pj, `/dashboard/clients/${key}`, 'name="confirm"', { key, confirm: guestEmail.toUpperCase() });
check((res?.headers.get("location") ?? "").includes("erased=1"), `owner erases the client (${res?.status})`);
const left = (await pool.query("select name, email, phone, answers from invitees where booking_id = $1", [bookingId])).rows[0];
check(left.name === "Erased client" && left.email.endsWith("@erased.invalid") && left.phone === null && left.answers.length === 0, "booking kept, client gone");
check((await pool.query("select count(*)::int as n from booking_notes where booking_id = $1", [bookingId])).rows[0].n === 0, "session note gone");
const erasures = (await pool.query("select * from client_erasures")).rows;
check(erasures.length === 1 && erasures[0].actor_id === priya.id && !JSON.stringify(erasures).includes("nila"), "erasure logged: who and when, not whom");
check((await pool.query("select status from data_requests")).rows.every((r) => r.status === "done"), "the guest's request is closed by the erasure");
check((await get(`/b/${manageToken}`)).status === 404, "the old manage link no longer works");
await pool.end();
console.log(fail ? `${fail} FAILED` : "ALL OK");
process.exit(fail ? 1 : 0);
