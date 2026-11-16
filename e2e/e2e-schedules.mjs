// Roadmap 2.3, several named availability schedules, over HTTP with the no-JavaScript forms: plan limit, create, name
// clash, weekly hours, picking a schedule on an event type, guest slots following it, and the delete guard.
// Usage: node e2e/e2e-schedules.mjs <port> <server-log> <database-url>
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
const ip = "203.0.113.96";

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
const unescape = (v) => v.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The markup of the form on `html` whose contents include `marker`. */
const formIn = (html, marker) => [...html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]).find((f) => f.includes(marker)) ?? null;
/** Posts a form's server-action fields (as the browser does without JavaScript) plus `fields`. */
async function post(j, path, form, fields) {
  const fd = new FormData();
  for (const m of form.matchAll(/<input[^>]*name="([^"]+)"(?:\s+value="([^"]*)")?[^>]*>/g)) if (m[1].startsWith("$ACTION")) fd.append(m[1], unescape(m[2] ?? ""));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(B + path, { method: "POST", body: fd, redirect: "manual", headers: { cookie: j.header(), origin: B, "x-forwarded-for": ip }, signal: t() });
  j.take(res);
  return res;
}
async function submit(j, path, marker, fields) {
  const form = formIn(await (await get(path, j)).text(), marker);
  return form ? post(j, path, form, fields) : null;
}
const PAGE = "/dashboard/availability";
const londonTime = (iso) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
async function slots(event) {
  const now = Date.now();
  const res = await fetch(`${B}/api/slots?slug=priya&event=${event}&from=${new Date(now).toISOString()}&to=${new Date(now + 21 * 86400000).toISOString()}&tz=Europe/London`, { headers: { "x-forwarded-for": ip }, signal: t() });
  return (await res.json()).slots ?? [];
}

await sleep(2500);
const pool = new pg.Pool({ connectionString: databaseUrl });
const { rows: [priya] } = await pool.query("select id, email from users where slug = 'priya'");
const coaching = (await pool.query("select id from event_types where user_id = $1 and slug = 'coaching'", [priya.id])).rows[0].id;
// Keep the seeded calendar fresh so slots aren't held back for a stale sync.
await pool.query("update calendar_connections set status = 'ok', last_synced_at = now() where user_id = $1", [priya.id]);
const pj = await signIn(priya.email);

// Free: one schedule, and the page says how to get more.
let html = await (await get(PAGE, pj)).text();
check(html.includes("Schedules") && html.includes("Upgrade to Solo or Duo") && !html.includes('id="new-schedule-name"'), "Free host sees the limit, not the add form");

await pool.query("insert into subscriptions (user_id, plan, status) values ($1, 'solo', 'active') on conflict (user_id) do update set plan = 'solo', status = 'active'", [priya.id]);
html = await (await get(PAGE, pj)).text();
const addForm = formIn(html, 'id="new-schedule-name"');
check(Boolean(addForm), "Solo host gets the add form");

let res = await post(pj, PAGE, addForm, { "schedule-name": "  UK   clients ", "schedule-timezone": "Europe/London" });
const where = res.headers.get("location") ?? "";
const ukId = new URL(where, B).searchParams.get("schedule");
check(res.status === 303 && Boolean(ukId), `creating a schedule opens it (${res.status} ${where})`);
const uk = (await pool.query("select name, timezone, is_default from availability_schedules where id = $1 and user_id = $2", [ukId, priya.id])).rows[0];
check(uk?.name === "UK clients" && uk?.timezone === "Europe/London" && uk?.is_default === false, "stored with a tidied name, its zone, not default");

res = await submit(pj, PAGE, 'id="new-schedule-name"', { "schedule-name": "uk CLIENTS", "schedule-timezone": "Asia/Kolkata" });
check(res?.status === 200 && (await res.text()).includes("You already have a schedule with that name"), "the same name in another case is refused");

const hours = { schedule: ukId };
for (const d of [1, 2, 3, 4, 5]) Object.assign(hours, { [`w${d}-on`]: "on", [`w${d}-0-from`]: "09:00", [`w${d}-0-to`]: "10:00" });
res = await submit(pj, `${PAGE}?schedule=${ukId}`, 'name="w1-on"', hours);
const weekly = (await pool.query("select weekday from availability_rules where schedule_id = $1 and kind = 'weekly' order by weekday", [ukId])).rows.map((r) => r.weekday);
check(res?.status === 200 && weekly.join() === "1,2,3,4,5", `weekly hours saved on that schedule (${weekly})`);

const before = await slots("coaching");
res = await submit(pj, `/dashboard/event-types/${coaching}`, 'name="event-type"', { "event-type": coaching, schedule: ukId });
const moved = (await pool.query("select schedule_id from event_types where id = $1", [coaching])).rows[0].schedule_id;
check(res?.status === 303 && moved === ukId, "the event type now books against UK clients");

const after = await slots("coaching");
check(after.length > 0 && after.every((s) => londonTime(s) === "09:00"), `guest slots follow its schedule: 09:00 London only (${after.length} slots)`);
check(before.some((s) => londonTime(s) !== "09:00"), "before the switch the same event offered other times");
check((await slots("intro")).some((s) => londonTime(s) !== "09:00"), "an event type on the default schedule is unaffected");

html = await (await get(`${PAGE}?schedule=${ukId}`, pj)).text();
const delForm = formIn(html, 'name="move-to"');
check(Boolean(delForm) && html.includes("uses this schedule. Move it to"), "delete names the event type and asks where it goes");
res = await post(pj, `${PAGE}?schedule=${ukId}`, delForm, { schedule: ukId });
check(res.status === 303 && (res.headers.get("location") ?? "").includes("error=in_use"), "deleting without a destination is refused");
check((await pool.query("select 1 from availability_schedules where id = $1", [ukId])).rowCount === 1, "the schedule is still there");

const def = (await pool.query("select id from availability_schedules where user_id = $1 and is_default", [priya.id])).rows[0].id;
res = await post(pj, `${PAGE}?schedule=${ukId}`, delForm, { schedule: ukId, "move-to": def });
const back = (await pool.query("select schedule_id from event_types where id = $1", [coaching])).rows[0].schedule_id;
check(res.status === 303 && (res.headers.get("location") ?? "").includes("notice=deleted") && back === def, "move and delete: the event type goes back to the default");
check((await pool.query("select 1 from availability_schedules where id = $1", [ukId])).rowCount === 0, "the schedule is gone");

// Back on Free, the server refuses a second schedule even from a form rendered while on Solo.
await pool.query("delete from subscriptions where user_id = $1", [priya.id]);
res = await post(pj, PAGE, addForm, { "schedule-name": "Evenings", "schedule-timezone": "Asia/Kolkata" });
check(res.status === 200 && (await res.text()).includes("Your plan includes one schedule"), "Free limit is enforced on the server");
check((await pool.query("select count(*)::int as n from availability_schedules where user_id = $1", [priya.id])).rows[0].n === 1, "still one schedule");

await pool.end();
console.log(fail ? `${fail} FAILED` : "ALL OK");
process.exit(fail ? 1 : 0);
