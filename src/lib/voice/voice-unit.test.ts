import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bearer, mintToolKey, readToolKey, verifyElevenLabsSignature, voiceToolsKey } from "./auth";
import { callCostPaise, DEFAULT_RATES, perMinutePaise, voiceRates } from "./cost";
import { screen } from "./guardrails";
import { monthOf } from "./store";

const KEY = Buffer.alloc(32, 7);
const HOST_A = "11111111-1111-4111-8111-111111111111";
const HOST_B = "22222222-2222-4222-8222-222222222222";

describe("tool keys", () => {
  it("round-trips the host and version it was made for", () => {
    expect(readToolKey(KEY, mintToolKey(KEY, HOST_A, 3))).toEqual({ hostId: HOST_A, version: 3 });
  });

  it("can't be moved to another host, version or server key", () => {
    const k = mintToolKey(KEY, HOST_A, 1);
    const [p, , v, mac] = k.split(".");
    expect(readToolKey(KEY, [p, HOST_B, v, mac].join("."))).toBeNull();
    expect(readToolKey(KEY, [p, HOST_A, "2", mac].join("."))).toBeNull();
    expect(readToolKey(Buffer.alloc(32, 8), k)).toBeNull();
    expect(readToolKey(KEY, `${k}x`)).toBeNull();
    expect(readToolKey(KEY, "")).toBeNull();
    expect(readToolKey(KEY, null)).toBeNull();
  });

  it("reads Bearer headers and needs a 32-byte hex server key", () => {
    expect(bearer("Bearer abc.def")).toBe("abc.def");
    expect(bearer("Basic abc")).toBeNull();
    expect(voiceToolsKey({})).toBeNull();
    expect(() => voiceToolsKey({ VOICE_TOOLS_KEY: "short" })).toThrow();
    expect(voiceToolsKey({ VOICE_TOOLS_KEY: "ab".repeat(32) })?.length).toBe(32);
  });
});

describe("ElevenLabs webhook signature", () => {
  const body = '{"type":"post_call_transcription"}';
  const now = new Date("2026-11-15T10:00:00Z");
  const t = Math.floor(now.getTime() / 1000);
  const sig = (secret: string, ts = t) => `t=${ts},v0=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;

  it("accepts its own signature and rejects others, edits and stale ones", () => {
    expect(verifyElevenLabsSignature("s3cret", body, sig("s3cret"), now)).toBe(true);
    expect(verifyElevenLabsSignature("s3cret", body, sig("other"), now)).toBe(false);
    expect(verifyElevenLabsSignature("s3cret", `${body} `, sig("s3cret"), now)).toBe(false);
    expect(verifyElevenLabsSignature("s3cret", body, sig("s3cret", t - 31 * 60), now)).toBe(false);
    expect(verifyElevenLabsSignature("s3cret", body, null, now)).toBe(false);
  });
});

describe("guardrail screening", () => {
  it("spots requests for clinical advice in English, Hindi and Hinglish", () => {
    expect(screen("What dose of my medicine should I take?").kind).toBe("advice");
    expect(screen("mujhe kaunsi dawai leni chahiye").kind).toBe("advice");
    expect(screen("सिर में दर्द है, क्या करूँ").kind).toBe("advice");
  });

  it("treats risk of self-harm as a crisis", () => {
    expect(screen("I want to end my life").kind).toBe("crisis");
    expect(screen("मैं आत्महत्या के बारे में सोच रहा हूँ").kind).toBe("crisis");
  });

  it("leaves ordinary booking talk alone", () => {
    expect(screen("Please ask her to call me about moving my Tuesday session").kind).toBe("ok");
  });
});

describe("call cost", () => {
  it("prices a minute from the published rates", () => {
    // ($0.08 + $0.005) × 94.26 + ₹1.00 = ₹9.01
    expect(perMinutePaise(DEFAULT_RATES)).toBe(901);
  });

  it("charges the agent by the second and telephony by the started minute", () => {
    expect(callCostPaise(0)).toBe(0);
    expect(callCostPaise(60)).toBe(901);
    // 90 s: agent ₹12.02 (1.5 min) + telephony ₹2 (2 pulses)
    expect(callCostPaise(90)).toBe(Math.round((0.085 * 94.26 * 1.5 + 2) * 100));
    expect(callCostPaise(180)).toBe(2704); // a typical 3-minute call: ₹27.04
  });

  it("takes overrides from the environment, ignoring junk", () => {
    expect(voiceRates({ VOICE_TELEPHONY_INR_PER_MIN: "0.5", VOICE_USD_INR: "abc" })).toEqual({ ...DEFAULT_RATES, telephonyInrPerMin: 0.5 });
  });
});

describe("billing month", () => {
  it("starts at local midnight on the 1st in the host's zone", () => {
    const m = monthOf(new Date("2026-11-30T19:00:00Z"), "Asia/Kolkata"); // 1 Dec, 00:30 IST
    expect(m.key).toBe("2026-12");
    expect(m.start.toISOString()).toBe("2026-11-30T18:30:00.000Z");
  });
});
