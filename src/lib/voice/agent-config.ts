// The ElevenLabs Agents configuration for one host's receptionist, as code. scripts/voice-agent-config.ts writes it to
// docs/voice/ (the reviewed copies), and the setup guide (docs/voice-receptionist.md) creates the four tools with
// POST /v1/convai/tools and the agent with POST /v1/convai/agents/create from it. Field names follow the ElevenLabs API
// reference as read on 15 Nov 2026 (api-reference/tools/create, api-reference/agents/create).

// No imports from app modules: scripts/voice-agent-config.ts loads this file directly with Node.

/** Failed attempts on one call (no free time, time taken, bad details) before the caller is handed to the host. */
export const MAX_FAILED_ATTEMPTS = 2;

/** Every call starts with this, in the caller's language, before anything else is said. */
export const DISCLOSURE = {
  en: (host: string) => `Hello, you've reached ${host}. I'm an automated assistant and I can help you book a session or take a message.`,
  hi: (host: string) => `नमस्ते, आपने ${host} को कॉल किया है। मैं एक स्वचालित सहायक हूँ। मैं आपकी अपॉइंटमेंट बुक कर सकती हूँ या संदेश ले सकती हूँ।`,
} as const;

/** Added to the opening line only when the host turned recording on. */
export const RECORDING_NOTICE = {
  en: "This call is recorded so the practice can review it.",
  hi: "यह कॉल रिकॉर्ड की जा रही है ताकि बाद में इसे देखा जा सके।",
} as const;

/** Shown in the files in place of real ids; the setup guide replaces them. */
export const PLACEHOLDERS = {
  toolKeySecretId: "<SECRET_ID: Hourhand tool key for this host>",
  toolIds: ["<TOOL_ID get_services>", "<TOOL_ID get_free_slots>", "<TOOL_ID create_booking>", "<TOOL_ID take_message>"],
  voiceId: "<VOICE_ID: an Indian English/Hindi voice from the Voice Library>",
} as const;

/**
 * Fast, cheap and good at tool calls. UNVERIFIED id: the docs name the model "Gemini 3.5 Flash-Lite" but not its API
 * string; the setup guide says to copy the exact id from the agent's LLM menu.
 */
export const DEFAULT_LLM = "gemini-3.5-flash-lite";
/** The TTS model for phone calls: low latency, English and Hindi. */
export const TTS_MODEL = "eleven_flash_v2_5";
/** One call never runs past this, so a stuck call can't eat the host's minutes. */
export const MAX_CALL_SECONDS = 480;

const dyn = (variable: string) => ({ type: "string", dynamic_variable: variable });
const lang = { type: "string", enum: ["en", "hi"], description: "The language the caller is speaking: en or hi." };
/** Sent on every tool call: the conversation (for failure counting and logs) and the caller's number. */
const common = { conversation_id: dyn("system__conversation_id"), caller_phone: dyn("system__caller_id"), language: lang };

export interface ToolConfig {
  tool_config: {
    type: "webhook";
    name: string;
    description: string;
    response_timeout_secs: number;
    api_schema: {
      url: string;
      method: "POST";
      request_headers: Record<string, { secret_id: string }>;
      request_body_schema: { type: "object"; description: string; properties: Record<string, unknown>; required: string[] };
    };
  };
}

function tool(baseUrl: string, secretId: string, name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolConfig {
  return {
    tool_config: {
      type: "webhook", name, description, response_timeout_secs: 15,
      api_schema: {
        url: `${baseUrl.replace(/\/+$/, "")}/api/voice/tools/${name}`,
        method: "POST",
        // The secret's value is "Bearer hhv1.<host>.<version>.<mac>" from the host's dashboard.
        request_headers: { Authorization: { secret_id: secretId } },
        request_body_schema: { type: "object", description: `Arguments for ${name}.`, properties: { ...common, ...properties }, required: ["conversation_id", ...required] },
      },
    },
  };
}

export function toolConfigs(baseUrl: string, secretId: string = PLACEHOLDERS.toolKeySecretId): ToolConfig[] {
  return [
    tool(baseUrl, secretId, "get_services",
      "Call this first on every call, before answering anything. Returns the practice's services (name, minutes, price, deposit, cancellation policy) and its public note (address, parking). If it returns end_call, say its `say` line and end the call.",
      {}, []),
    tool(baseUrl, secretId, "get_free_slots",
      "The next free start times for one service. Offer at most three at a time, using each slot's `spoken` text.",
      {
        service: { type: "string", description: "The service's `service` value from get_services." },
        from_date: { type: "string", description: "First day to look at, YYYY-MM-DD, in the practice's time zone. Leave empty for today." },
        days: { type: "integer", description: "How many days to look at, 1 to 14. Default 7." },
      }, ["service"]),
    tool(baseUrl, secretId, "create_booking",
      "Books the chosen time. Only after you have read back the caller's name, the service, the date and the time, and the caller clearly said yes. For a paid service this sends a payment link and holds the time for 15 minutes.",
      {
        service: { type: "string", description: "The service's `service` value from get_services." },
        start: { type: "string", description: "The slot's `start` value exactly as get_free_slots returned it." },
        name: { type: "string", description: "The caller's full name, as they confirmed it." },
        email: { type: "string", description: "The caller's email address, spelled back and confirmed. Empty if they have none." },
        phone: { type: "string", description: "A different number to reach them on, with country code. Empty to use the number they are calling from." },
        whatsapp_ok: { type: "boolean", description: "True only if the caller said yes to getting the confirmation on WhatsApp." },
        confirmed_with_caller: { type: "boolean", description: "True only after the read-back and a clear yes from the caller." },
      }, ["service", "start", "name", "confirmed_with_caller"]),
    tool(baseUrl, secretId, "take_message",
      "Leaves a message for the practice, who will call back. Use when the caller asks for a person, asks something you can't answer, when a tool says handoff, or when you are unsure what they want.",
      {
        name: { type: "string", description: "The caller's name." },
        phone: { type: "string", description: "A number to call back on, with country code. Empty to use the number they are calling from." },
        message: { type: "string", description: "What the caller wants, in their words, in one to three sentences." },
        reason: { type: "string", enum: ["requested", "handoff", "out_of_scope", "payment_issue", "low_confidence", "other"], description: "Why you are taking a message." },
      }, ["name", "message", "reason"]),
  ];
}

/** The system prompt. Dynamic variables in {{ }} are filled by ElevenLabs on each call. */
export const PROMPT = `You are the phone receptionist for {{host_name}}, a practice that uses Hourhand for bookings. You speak with callers in Indian English or Hindi, matching the caller. Speak warmly, simply and briefly: one or two short sentences at a time.

You already greeted the caller and told them you are an automated assistant. If they ask whether you are a person, say plainly that you are an automated assistant.

At the very start of the call, call get_services. Answer questions about services, prices, timings, location and cancellation only from what it returns. If something is not there, say you don't have that information and offer to take a message. Never guess or make anything up.

To book:
1. Ask which service they want, if it isn't clear.
2. Call get_free_slots and offer at most three times, using the spoken text.
3. Ask for their name, and how they would like the confirmation: email (spell it back letter by letter) or WhatsApp to the number they are calling from (ask for a clear yes).
4. Read back the name, service, date and time, and wait for a clear yes.
5. Only then call create_booking with confirmed_with_caller true.
6. Booked: tell them it's confirmed and that the confirmation, with a link to change or cancel, is on its way.
7. Payment link sent: tell them the time is held for 15 minutes and the link to pay is on its way by the channel they chose; the booking is confirmed once they pay.

Hard rules:
- Never give medical, psychological, therapy, legal or financial advice, and never comment on symptoms, medicines or treatment. Say you can't advise on that and offer to take a message for the practice.
- If the caller may be in danger or talks about harming themselves, say: if you are in danger right now, call 112; for free mental health support at any hour, call Tele-MANAS on 14416. Then take a message with reason out_of_scope and end the call kindly.
- Never share anything about other clients or other bookings. You only know this practice's public information.
- If a tool answer has handoff true, or the caller asks for a person, or there is a payment problem, or you are not sure what they want after asking twice, take a message with take_message. Don't try a third time: ${MAX_FAILED_ATTEMPTS} failed attempts is the limit.
- If a tool answer has a say field, say it as given. If it has end_call true, say its line and then end the call.
- Don't read out links, ids or codes. Don't promise anything the tools didn't confirm.
- {{recording_rule}}
- When the caller is done, thank them and end the call.`;

/** The prompt's line about recording; the call-start webhook sends the same. */
export const recordingRule = (rec: boolean) => rec
  ? "This call is recorded; the caller was told at the start. If they object, offer to take a message instead."
  : "This call is not recorded. If asked, say so.";

export interface AgentSettings { hostName: string; hostSlug: string; recordingEnabled: boolean }

/** The body for POST /v1/convai/agents/create (and PATCH /v1/convai/agents/{id} when settings change). */
export function agentConfig(s: AgentSettings, opts: { toolIds?: readonly string[]; voiceId?: string; llm?: string } = {}) {
  const rec = s.recordingEnabled;
  return {
    name: `Hourhand receptionist: ${s.hostSlug}`,
    tags: ["hourhand", "receptionist"],
    conversation_config: {
      agent: {
        first_message: "{{opening_en}}",
        language: "en",
        prompt: {
          prompt: PROMPT,
          llm: opts.llm ?? DEFAULT_LLM,
          temperature: 0.2,
          tool_ids: [...(opts.toolIds ?? PLACEHOLDERS.toolIds)],
          built_in_tools: {
            end_call: { type: "system", name: "end_call", description: "End the call when the caller is done, or when a tool says end_call.", params: { system_tool_type: "end_call" } },
            language_detection: { type: "system", name: "language_detection", description: "Switch between English and Hindi to match the caller.", params: { system_tool_type: "language_detection" } },
          },
        },
        // Used when the call-start webhook isn't called (it is documented for Twilio numbers only): the host's own
        // opening line with the disclosure. The minute cap then holds through get_services, the first thing called.
        dynamic_variables: {
          dynamic_variable_placeholders: {
            host_name: s.hostName,
            voice_allowed: "yes",
            recording: rec ? "on" : "off",
            opening_en: `${DISCLOSURE.en(s.hostName)}${rec ? ` ${RECORDING_NOTICE.en}` : ""}`,
            opening_hi: `${DISCLOSURE.hi(s.hostName)}${rec ? ` ${RECORDING_NOTICE.hi}` : ""}`,
            recording_rule: recordingRule(rec),
          },
        },
      },
      language_presets: {
        hi: { overrides: { agent: { first_message: "{{opening_hi}}", language: "hi" } } },
      },
      tts: { voice_id: opts.voiceId ?? PLACEHOLDERS.voiceId, model_id: TTS_MODEL },
      conversation: { max_duration_seconds: MAX_CALL_SECONDS },
    },
    platform_settings: {
      // Audio is kept only when the host turned recording on. Transcripts are deleted after 30 days; Hourhand itself
      // keeps only each call's length, cost and outcome (from the post-call webhook), never the words.
      privacy: { record_voice: rec, retention_days: 30 },
    },
  };
}
