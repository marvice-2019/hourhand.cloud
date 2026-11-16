// What a receptionist call costs Hourhand, in paise. Rates as checked on 15 Nov 2026 (see docs/voice-receptionist.md
// for sources); override with env when a contract or invoice says otherwise. GST is not included (input credit).
//
//   ElevenLabs Agents      $0.08 a minute on every plan beyond included minutes (elevenlabs.io/pricing/agents)
//   LLM pass-through       ~$0.005 a minute for a Flash-Lite class model (estimate; the dashboard shows the real figure)
//   Exotel inbound + AgentStream  ₹1.00 a minute, a deliberately high placeholder until Exotel quotes AgentStream
//   USD→INR                94.26 (15 Nov 2026)

type Env = Record<string, string | undefined>;

export interface VoiceRates {
  agentUsdPerMin: number;
  llmUsdPerMin: number;
  telephonyInrPerMin: number;
  usdInr: number;
}

export const DEFAULT_RATES: VoiceRates = { agentUsdPerMin: 0.08, llmUsdPerMin: 0.005, telephonyInrPerMin: 1.0, usdInr: 94.26 };

const num = (v: string | undefined, fallback: number) => {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function voiceRates(env: Env = process.env): VoiceRates {
  return {
    agentUsdPerMin: num(env.VOICE_AGENT_USD_PER_MIN, DEFAULT_RATES.agentUsdPerMin),
    llmUsdPerMin: num(env.VOICE_LLM_USD_PER_MIN, DEFAULT_RATES.llmUsdPerMin),
    telephonyInrPerMin: num(env.VOICE_TELEPHONY_INR_PER_MIN, DEFAULT_RATES.telephonyInrPerMin),
    usdInr: num(env.VOICE_USD_INR, DEFAULT_RATES.usdInr),
  };
}

/** Paise per minute, all in. */
export function perMinutePaise(r: VoiceRates = DEFAULT_RATES): number {
  return Math.round(((r.agentUsdPerMin + r.llmUsdPerMin) * r.usdInr + r.telephonyInrPerMin) * 100);
}

/** One call's cost: the agent and LLM by the second, telephony by each started minute (Indian carriers bill per pulse). */
export function callCostPaise(durationSecs: number, r: VoiceRates = DEFAULT_RATES): number {
  if (durationSecs <= 0) return 0;
  const agent = ((r.agentUsdPerMin + r.llmUsdPerMin) * r.usdInr * durationSecs) / 60;
  const telephony = r.telephonyInrPerMin * Math.ceil(durationSecs / 60);
  return Math.round((agent + telephony) * 100);
}
