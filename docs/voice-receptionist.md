# Phone receptionist: setup guide

An optional add-on for Duo and Clinic hosts. A caller rings the host's number and an automated assistant on ElevenLabs Agents answers in the host's name, in Indian English or Hindi. It says it is automated, answers from the host's public info, offers free times and books them. Paid sessions get a pay link and the time is held 15 minutes. For anything else it takes a message for the host.

How it is built: the agent calls four Hourhand server tools (`/api/voice/tools/*`) with a per-host key; two webhooks give the opening line and record each call's length and cost. Code: `src/lib/voice/`. Agent config as code: `src/lib/voice/agent-config.ts`, written to `docs/voice/` by `node scripts/voice-agent-config.ts`.

All sources below were read on **15 Nov 2026** unless a date says otherwise. None of the pages carries a "last updated" date.

## 1. Telephony: which numbers

**Use Exotel.** It is a licensed Indian operator, and ElevenLabs integrates with it natively ("Import number → From Exotel"). Callers dial a normal Indian ExoPhone (local, mobile or toll-free).

The other options don't fit:

- **Twilio** sells only +91 800 toll-free numbers in India, which can be reached only from within India. It has no local or mobile voice numbers ([twilio.com/en-us/guidelines/in/regulatory](https://www.twilio.com/en-us/guidelines/in/regulatory), [/in/voice](https://www.twilio.com/en-us/guidelines/in/voice)). That rules it out for a receptionist on a normal number.
- **Plain SIP from a foreign carrier** to Indian numbers isn't allowed: VoIP-to-PSTN interconnection and Indian numbering stay with licensed access providers (TRAI recommendations on Internet Telephony, 24 Oct 2017). This is our reading, not legal advice.
- **Vobiz**, an Indian SIP trunk with an ElevenLabs guide, is a fallback. Its rates are not published.

ElevenLabs Exotel guide: <https://elevenlabs.io/docs/eleven-agents/phone-numbers/telephony/exotel>. Exotel's side is the **Voicebot applet**, also called AgentStream or Voice Streaming. Exotel support has to enable it, which usually takes 1–2 business days. The applet points at `wss://api.elevenlabs.io/v1/convai/conversation/exotel`, or the India-residency URL `wss://api.in.residency.elevenlabs.io/...` if the ElevenLabs plan includes it. Use the Mumbai region (`api.in.exotel.com`).

## 2. Cost per minute and per call (INR, before GST)

| Item | Rate | ₹ per minute | Source |
|---|---|---|---|
| ElevenLabs Agents | $0.08 a minute, every plan, beyond included minutes. Silence over 10 s is billed at 5%. Burst minutes over the concurrency limit cost $0.16. | 7.54 | [elevenlabs.io/pricing/agents](https://elevenlabs.io/pricing/agents) |
| LLM (passed through at provider cost, no markup) | about $0.005 a minute for a Flash-Lite class model. **Estimate**: the agent's "Detailed costs" view shows the real figure. | 0.47 | [docs: LLM](https://elevenlabs.io/docs/eleven-agents/customization/llm) |
| Exotel inbound + AgentStream | **₹1.00 a minute, a deliberately high placeholder.** Inbound is about ₹0.30–0.50 (third-party figure, unverified). Exotel quotes AgentStream through sales only. | 1.00 | [exotel.com/pricing](https://exotel.com/pricing/business-phone-system/) |
| USD → INR | 94.26 | | open.er-api.com, 15 Nov 2026 00:02 UTC (ECB cross-check: 94.25 on 13 Nov) |
| **All in** | | **₹9.01** | `src/lib/voice/cost.ts` |

The agent and LLM are billed by the second; telephony by each started minute.

| Call | Cost |
|---|---|
| 1 minute | ₹9.01 |
| **3 minutes (typical booking call)** | **₹27.04** |
| 5 minutes | ₹45.06 |
| Hard ceiling per call (8-minute limit in the agent config) | ₹72.10 |

Fixed costs:

| Item | Cost |
|---|---|
| Exotel number rental per host | about **₹955 a month**, from the Believer plan: ₹10,499 rental over 11 months (unverified per extra number) |
| ElevenLabs workspace plan | Creator $22, Pro $99 or Scale $299 a month. These include 275, 1,238 and 3,738 minutes, so the effective rate is still about $0.08 a minute once used. Start on Creator and move up as call volume grows. |

GST: Exotel adds 18% on its prices. ElevenLabs is an import of services, so IGST is paid under reverse charge and claimed back as input credit. **Ask the CA to confirm the reverse-charge treatment.**

When Exotel quotes, set the real rates in env (`VOICE_TELEPHONY_INR_PER_MIN`, `VOICE_AGENT_USD_PER_MIN`, `VOICE_LLM_USD_PER_MIN`, `VOICE_USD_INR`). The call log and dashboard costs follow.

## 3. Price (for owner review)

**Recommended: ₹3,999 a month + 18% GST (₹4,718.82), 100 call minutes included, Duo and Clinic only.**

| Usage | Our cost (calls + number) | Gross margin |
|---|---|---|
| 100 min (cap reached) | 100 × ₹9.01 + ₹955 = ₹1,856 | (3,999 − 1,856) / 3,999 = **53.6%** |
| 60 min (about 20 calls) | 60 × ₹9.01 + ₹955 = ₹1,496 | **62.6%** |
| 100 min, after Razorpay's about 2% (₹80) | ₹1,936 | **51.6%** |

The host's cap can't go above the included 100 minutes, so usage can never push the margin below about 51.6%.

The close call is ₹2,999 with 60 minutes. At full use that costs ₹1,496, a margin of 50.1% before gateway fees, which is under 50% after them. It isn't worth the thinner cushion.

Later, not built here: extra-minute packs at ₹1,999 per 100 minutes (cost ₹901, 54.9% margin).

The biggest risk to the margin is Exotel's AgentStream price. The first move is to get the quote before launch. If it is above ₹1/min all in, raise the price or cut the included minutes before selling the add-on.

## 4. Server setup (once)

Set these in Coolify (production environment), then redeploy:

| Env | Value |
|---|---|
| `VOICE_TOOLS_KEY` | `openssl rand -hex 32`. Every host's tool key is derived from it, so changing it revokes all keys. |
| `VOICE_CALL_START_SECRET` | `openssl rand -hex 32` |
| `ELEVENLABS_WEBHOOK_SECRET` | the signing secret ElevenLabs shows when you create the post-call webhook (step 5) |
| `RAZORPAY_PLAN_VOICE_MONTH` | a Razorpay Plan for ₹3,999 monthly, created in the Razorpay dashboard. The add-on is billed like the custom domain. |
| `VOICE_*_PER_MIN`, `VOICE_USD_INR` | optional rate overrides (section 2) |

WhatsApp pay links need one more utility template approved in Meta Business Manager. The template is `hh_voice_pay_link` in English and Hindi, with a URL button to `https://hourhand.cloud/v/pay/{{1}}`; the exact text is in `src/lib/voice/notify.ts`. Until it is approved, pay links go by email only. Callers without email are then asked for one.

## 5. ElevenLabs workspace setup (once)

1. **Post-call webhook.** Workspace settings → Webhooks. Add `https://hourhand.cloud/api/webhooks/elevenlabs` for the **transcription** event (`post_call_transcription`) and turn retries on. Copy its secret into `ELEVENLABS_WEBHOOK_SECRET`. Hourhand checks the `ElevenLabs-Signature` header: `t=<unix>,v0=<hex HMAC-SHA256 of "t.body">`, within 30 minutes. That format matches `@elevenlabs/elevenlabs-js` 2.78.0 `wrapper/webhooks.js`. Hourhand stores only each call's length, cost and outcome, never the transcript. Docs: <https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks>.
2. **Call-start webhook** (conversation initiation client data). In settings, set `https://hourhand.cloud/api/voice/call-start` and create a secret whose value is `Bearer <VOICE_CALL_START_SECRET>`, sent as the `Authorization` header. Docs (written for Twilio calls): <https://elevenlabs.io/docs/eleven-agents/customization/personalization/twilio-personalization>. **Not confirmed for Exotel/SIP numbers.** That is safe either way: each agent carries its host's opening line as a default, and the minute cap and on/off switch are enforced by `get_services`, which the prompt makes the first thing on every call.

## 6. Per host (about 20 minutes)

1. The host buys the add-on and opens **Dashboard → Phone receptionist**. They fill in the public note (address, parking) and press Save, which creates their settings and tool key.
2. **Exotel:** buy an ExoPhone for the host. Add the Voicebot applet flow pointing at ElevenLabs and assign it to the number. Then in ElevenLabs, Phone Numbers → Import → From Exotel (Account SID, API key and token, Mumbai region, applet id).
3. **Secret:** in ElevenLabs Secrets, create `hourhand-<slug>`. Its value is the full `Bearer hhv1…` line from the host's dashboard (Tool key → Show key).
4. **Tools:** create the four tools with `POST /v1/convai/tools` using `docs/voice/tool.*.json`, with `<SECRET_ID…>` replaced by the secret's id. Or use the dashboard's tool editor with the same fields. Docs: <https://elevenlabs.io/docs/api-reference/tools/create>.
5. **Agent:** create it with `POST /v1/convai/agents/create` from `docs/voice/agent.example.json`. Generate the host's own copy with `agentConfig()` (name and recording setting), fill in the four tool ids and a voice id (an Indian English/Hindi voice from the Voice Library), and pick the LLM. **The LLM id `gemini-3.5-flash-lite` in the file is unverified**: the docs name the model "Gemini 3.5 Flash-Lite" without its API string, so choose it from the agent's LLM menu and keep whatever id that sets. Gemini 2.5 Flash-Lite is being retired on 30 Nov 2026. Docs: <https://elevenlabs.io/docs/api-reference/agents/create>.
6. In the agent's **Security** tab, turn on fetching conversation initiation data from the webhook, and let it override first message and language.
7. Assign the imported number to the agent.
8. Back in the host's dashboard, enter the **agent id** and **receptionist number**, tick **Answer my calls**, set the monthly limit (up to 100) and press Save.
9. **Test call checklist** (from a phone that isn't the host's):
   - The greeting says it's an automated assistant.
   - Ask for prices and the address: the answers come from the host's services and note.
   - Book a free service: you get the read-back, then the confirmation by email or WhatsApp.
   - Book a paid service: the pay link arrives and the time shows "Awaiting payment" in Bookings.
   - Ask "what medicine should I take": it refuses and a message appears in the dashboard.
   - Ask for a person: a message appears.
   - Speak Hindi: it switches.
   - The call shows in the dashboard's call log with its length and cost within a minute of hanging up.

## 7. Privacy

- Audio is recorded only when the host turns **Record calls** on (agent `platform_settings.privacy.record_voice`). The opening line then tells the caller. Update the agent after changing it.
- ElevenLabs keeps transcripts for 30 days (`retention_days: 30`). Zero Retention Mode (`zero_retention_mode`) keeps nothing; the post-call webhook still works then. Consider it for therapy and medical hosts. Its availability by plan is not verified.
- Hourhand stores no transcripts or audio. It keeps only call length, cost, outcome, the caller's number, and messages the caller asked to leave.
