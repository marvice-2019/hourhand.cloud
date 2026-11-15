// Batch A smoke over HTTP: theme script and switch render, ?at= is safe. Usage: node e2e/e2e-batch-a.mjs <port>
const B = `http://localhost:${process.argv[2]}`;
let fail = 0;
const check = (ok, label) => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 40; i++) { try { await fetch(B); break; } catch { await sleep(500); } }
const page = async (p) => { const r = await fetch(B + p, { headers: { "x-forwarded-for": "203.0.113.50" } }); return { status: r.status, html: (await r.text()).replace(/<!-- -->/g, "") }; };
const a = await page("/priya/coaching");
check(a.status === 200, "booking page loads");
check(/<head>[\s\S]*<script>try\{var t=localStorage\.getItem\("hourhand\.theme"\)/.test(a.html), "theme script runs in head before paint");
check(a.html.includes("Appearance</legend>") && a.html.includes(">Device"), "booking footer has the appearance switch");
for (const at of ["2099-01-01T04:00:00Z", "garbage", "<script>x</script>"]) {
  const r = await page(`/priya/coaching?at=${encodeURIComponent(at)}`);
  check(r.status === 200 && !r.html.includes("<script>x</script>"), `?at=${at.slice(0, 12)} renders safely`);
}
// "/" is now the static marketing page with its own styling; the app's theme script lives in the app layout.
const signIn = await page("/sign-in");
check(signIn.html.includes('"hourhand.theme"'), "theme script on app pages too (sign-in)");
console.log(fail ? `${fail} FAILED` : "ALL OK");
process.exit(fail ? 1 : 0);
