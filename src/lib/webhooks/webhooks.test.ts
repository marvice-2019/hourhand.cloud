import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkUrl, checkUrlShape, isBlockedAddress } from "./guard";
import { signature } from "./webhooks";

describe("webhook address guard", () => {
  it("blocks private, loopback, link-local, metadata and reserved addresses, IPv4 and IPv6", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.5", "192.168.1.10", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:127.0.0.1", "not-an-ip"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });
  it("lets public addresses through", () => {
    for (const ip of ["8.8.8.8", "142.250.183.78", "2606:4700:4700::1111"]) expect(isBlockedAddress(ip), ip).toBe(false);
  });
  it("takes only https URLs, with no credentials and no private host", () => {
    expect(checkUrlShape("http://example.com/hook")).toEqual({ ok: false, problem: "not_https" });
    expect(checkUrlShape("https://user:pass@example.com/hook")).toEqual({ ok: false, problem: "bad_url" });
    expect(checkUrlShape("not a url")).toEqual({ ok: false, problem: "bad_url" });
    expect(checkUrlShape("https://127.0.0.1/hook")).toEqual({ ok: false, problem: "private_address" });
    expect(checkUrlShape("https://[::1]/hook")).toEqual({ ok: false, problem: "private_address" });
    expect(checkUrlShape("https://localhost/hook")).toEqual({ ok: false, problem: "private_address" });
    expect(checkUrlShape("https://n8n.example.com/webhook/abc").ok).toBe(true);
  });
  it("refuses a public-looking name that resolves to a private address", async () => {
    expect(await checkUrl("https://sneaky.example.com/hook", async () => ["10.0.0.7"])).toEqual({ ok: false, problem: "private_address" });
    expect(await checkUrl("https://mixed.example.com/hook", async () => ["93.184.216.34", "127.0.0.1"])).toEqual({ ok: false, problem: "private_address" });
    expect(await checkUrl("https://hooks.example.com/x", async () => ["93.184.216.34"])).toEqual({ ok: true, url: "https://hooks.example.com/x" });
    expect(await checkUrl("https://nowhere.example.com/x", async () => { throw new Error("ENOTFOUND"); })).toEqual({ ok: false, problem: "bad_url" });
  });
});

describe("webhook signature", () => {
  it("is t=<unix seconds>,v1=<HMAC-SHA256 of t.body>, so a receiver can check it", () => {
    const at = new Date("2026-11-25T10:00:00Z");
    const body = JSON.stringify({ event: "booking.created" });
    const t = at.getTime() / 1000;
    expect(signature("whsec_test", body, at)).toBe(`t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`);
    expect(signature("whsec_other", body, at)).not.toBe(signature("whsec_test", body, at));
  });
});
