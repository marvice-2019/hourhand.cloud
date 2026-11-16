import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { voiceConfigFiles } from "../../../scripts/voice-agent-config";
import { VOICE_INCLUDED_MINUTES, addonForPriceId, addonPriceLine } from "../billing/plans";
import { agentConfig, MAX_CALL_SECONDS, PROMPT, toolConfigs } from "./agent-config";
import { validateVoiceForm } from "./settings-form";

const vars = (text: string) => [...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]).filter((v) => !v.startsWith("system__"));

describe("agent configuration as code", () => {
  it("the committed docs/voice files are what the code generates", async () => {
    for (const [name, text] of Object.entries(voiceConfigFiles())) {
      expect(await readFile(new URL(`../../../docs/voice/${name}`, import.meta.url), "utf8"), `docs/voice/${name} is stale: run node scripts/voice-agent-config.ts`).toBe(text);
    }
  });

  it("has exactly the four tools, each posting to its route with the host's secret key", () => {
    const tools = toolConfigs("https://hourhand.cloud/", "sec_1");
    expect(tools.map((t) => t.tool_config.name)).toEqual(["get_services", "get_free_slots", "create_booking", "take_message"]);
    for (const { tool_config: t } of tools) {
      expect(t.api_schema.url).toBe(`https://hourhand.cloud/api/voice/tools/${t.name}`);
      expect(t.api_schema.method).toBe("POST");
      expect(t.api_schema.request_headers).toEqual({ Authorization: { secret_id: "sec_1" } });
      expect(t.api_schema.request_body_schema.properties.conversation_id).toEqual({ type: "string", dynamic_variable: "system__conversation_id" });
      expect(t.api_schema.request_body_schema.properties.caller_phone).toEqual({ type: "string", dynamic_variable: "system__caller_id" });
      expect(t.api_schema.request_body_schema.required).toContain("conversation_id");
    }
    const book = tools[2].tool_config.api_schema.request_body_schema;
    expect(book.required).toEqual(expect.arrayContaining(["service", "start", "name", "confirmed_with_caller"]));
    // The host is never something the model can choose.
    for (const { tool_config: t } of tools) expect(Object.keys(t.api_schema.request_body_schema.properties)).not.toContain("host");
  });

  it("opens with the automated-assistant disclosure in English and Hindi, and mentions recording only when it's on", () => {
    const off = agentConfig({ hostName: "Dr Meera", hostSlug: "meera", recordingEnabled: false });
    const p = off.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders;
    expect(off.conversation_config.agent.first_message).toBe("{{opening_en}}");
    expect(off.conversation_config.language_presets.hi.overrides.agent).toEqual({ first_message: "{{opening_hi}}", language: "hi" });
    expect(p.opening_en).toMatch(/Dr Meera.*automated assistant/);
    expect(p.opening_hi).toMatch(/स्वचालित सहायक/);
    expect(p.opening_en).not.toMatch(/record/i);
    expect(off.platform_settings.privacy.record_voice).toBe(false);
    const on = agentConfig({ hostName: "Dr Meera", hostSlug: "meera", recordingEnabled: true });
    expect(on.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders.opening_en).toMatch(/recorded/);
    expect(on.platform_settings.privacy.record_voice).toBe(true);
    expect(off.conversation_config.conversation.max_duration_seconds).toBe(MAX_CALL_SECONDS);
  });

  it("gives every variable the prompt and greetings use a value", () => {
    const cfg = agentConfig({ hostName: "X", hostSlug: "x", recordingEnabled: false });
    const used = new Set([...vars(PROMPT), ...vars(cfg.conversation_config.agent.first_message), ...vars(cfg.conversation_config.language_presets.hi.overrides.agent.first_message)]);
    expect(Object.keys(cfg.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders)).toEqual(expect.arrayContaining([...used]));
  });

  it("states the guardrails in the prompt", () => {
    expect(PROMPT).toMatch(/Never give medical, psychological, therapy/);
    expect(PROMPT).toMatch(/112.*14416/);
    expect(PROMPT).toMatch(/Never share anything about other clients/);
    expect(PROMPT).toMatch(/2 failed attempts is the limit/);
    expect(PROMPT).toMatch(/Read back the name, service, date and time/);
    expect(PROMPT).toMatch(/call get_services/);
  });
});

describe("receptionist add-on and settings", () => {
  it("is priced and found by its Razorpay plan id", () => {
    expect(addonPriceLine("voice")).toBe("₹3,999 + 18% GST = ₹4,718.82 a month");
    expect(addonForPriceId("razorpay", "plan_voice", { RAZORPAY_PLAN_VOICE_MONTH: "plan_voice" })).toBe("voice");
    expect(addonForPriceId("stripe", "plan_voice", { RAZORPAY_PLAN_VOICE_MONTH: "plan_voice" })).toBeNull();
  });

  const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
  it("keeps the cap within the included minutes and checks the number and agent id", () => {
    expect(validateVoiceForm(form({ cap: "80", enabled: "on", phoneNumber: "+91 80 4567 8900", agentId: "agent_abc-1" }))).toEqual({
      ok: true, value: { enabled: true, recordingEnabled: false, monthlyMinuteCap: 80, publicNote: "", agentId: "agent_abc-1", phoneNumber: "+918045678900" },
    });
    expect(validateVoiceForm(form({ cap: String(VOICE_INCLUDED_MINUTES + 1) }))).toMatchObject({ ok: false, errors: { cap: expect.any(String) } });
    expect(validateVoiceForm(form({ cap: "-1" }))).toMatchObject({ ok: false });
    expect(validateVoiceForm(form({ cap: "10", phoneNumber: "080 4567" }))).toMatchObject({ ok: false, errors: { phoneNumber: expect.any(String) } });
    expect(validateVoiceForm(form({ cap: "10", agentId: "a b" }))).toMatchObject({ ok: false, errors: { agentId: expect.any(String) } });
    expect(validateVoiceForm(form({ cap: "10", publicNote: "x".repeat(1001) }))).toMatchObject({ ok: false });
  });
});
