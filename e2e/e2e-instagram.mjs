// A guest who taps the host's Instagram bio link books inside Instagram's in-app browser (an iPhone WebView that
// names itself "Instagram" in the user agent). Checks: the tagged link loads fast enough on a phone, the page carries
// the host's share card, and the whole booking runs in the one tab with no popup window (in-app browsers block those).
// Usage: NODE_PATH=$(npm root -g) node e2e/e2e-instagram.mjs <port>   (server in memory mode: HOURHAND_ALLOW_MEMORY=1)
// Playwright isn't a project dependency; NODE_PATH points require() at a global install.
import { createRequire } from "node:module";

const { chromium, devices } = createRequire(import.meta.url)("playwright");

const B = `http://localhost:${process.argv[2]}`;
let fail = 0;
const check = (ok, label) => { if (!ok) fail++; console.log(`${ok ? "OK  " : "FAIL"} ${label}`); };
const IG_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 389.0.0.29.87 (iPhone15,2; iOS 18_5; en_IN; en; scale=3.00; 1179x2556; 712512094)";

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["iPhone 14"], userAgent: IG_UA, locale: "en-IN", timezoneId: "Asia/Kolkata" });
const page = await context.newPage();
const popups = [];
context.on("page", (p) => p !== page && popups.push(p.url()));
const dialogs = [];
page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
let bytes = 0;
page.on("response", async (r) => { try { bytes += (await r.body()).length; } catch { /* redirects have no body */ } });

const started = Date.now();
await page.goto(`${B}/priya?utm_source=instagram&utm_medium=social`, { waitUntil: "load" });
const loadMs = Date.now() - started;
check(loadMs < 5000, `profile page loads in ${loadMs} ms`);
check(bytes < 1_500_000, `profile page weighs ${(bytes / 1024).toFixed(0)} KB`);
const og = await page.locator('meta[property="og:image"]').getAttribute("content");
check(Boolean(og && og.includes("/priya/opengraph-image")), "page names the host's share card as og:image");
const img = await page.request.get(og.replace(/^https?:\/\/[^/]+/, B));
check(img.status() === 200 && img.headers()["content-type"] === "image/png", "share card serves as PNG");

await page.getByRole("link", { name: /coaching session/i }).first().click();
await page.waitForURL(/\/priya\/coaching/);
const firstDay = page.locator('button[aria-label]:not([disabled])').filter({ hasText: /^\d+$/ }).first();
await firstDay.waitFor({ timeout: 15000 });
await firstDay.click();
const slot = page.locator("section button").filter({ hasText: /\d{1,2}:\d{2}/ }).first();
await slot.waitFor({ timeout: 15000 });
await slot.click();
await page.getByLabel(/name/i).first().fill("Insta Guest");
await page.getByLabel(/email/i).first().fill("insta.guest@example.in");
// The seeded coaching type asks one required question.
const question = page.getByLabel(/work on/i);
if (await question.count()) await question.first().fill("Planning my first quarter as a manager");
const terms = page.getByRole("checkbox");
for (let i = 0; i < await terms.count(); i++) if (await terms.nth(i).isVisible()) await terms.nth(i).check();
await page.getByRole("button", { name: /book this time/i }).click();
await page.waitForURL(/\/booked\//, { timeout: 15000 }).catch(async (e) => { console.log((await page.locator("main").innerText()).slice(0, 1500)); throw e; });
check(/\/priya\/coaching\/booked\//.test(page.url()), "booking completes and lands on the confirmation page");
check(popups.length === 0, `no popup windows opened (${popups.length})`);
check(dialogs.length === 0, `no blocking dialogs (${dialogs.join(" | ")})`);

await browser.close();
console.log(fail ? `${fail} FAILED` : "ALL OK");
process.exit(fail ? 1 : 0);
