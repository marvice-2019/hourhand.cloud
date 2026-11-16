// Server-side guardrails for the phone receptionist. The agent's prompt says the same things, but these hold even if
// the model ignores it: tools only ever answer from the host's public info, refuse to book without a read-back, and
// hand the caller to the host after repeated failures.

// The opening lines and the failure limit live with the agent config (which scripts/ loads without the app's imports).
export { DISCLOSURE, MAX_FAILED_ATTEMPTS, RECORDING_NOTICE } from "./agent-config";

/** Health words (English, Hindi, Hinglish) that mean a caller wants advice the receptionist must never give. */
const ADVICE = [
  /\b(medicine|medication|tablet|dose|dosage|prescri\w*|diagnos\w*|symptom\w*|side effects?|treatment|cure|therapy advice|is it normal|should i (take|stop))\b/i,
  /\b(dawai|dawa|ilaaj|ilaj|bimari|beemari|dard|goli)\b/i,
  /(दवा|दवाई|इलाज|बीमारी|लक्षण|दर्द|गोली|खुराक)/,
];

/** Words that mean someone may be at risk right now: the agent gives emergency numbers and alerts the host at once. */
const CRISIS = [
  /\b(suicid\w*|kill (myself|me)|end my life|self[- ]harm|hurt myself|want to die|overdose)\b/i,
  /\b(marna chahta|marna chahti|khudkushi|aatmahatya)\b/i,
  /(आत्महत्या|खुदकुशी|मरना चाहता|मरना चाहती|खुद को नुकसान)/,
];

export type Screen = { kind: "ok" } | { kind: "advice" } | { kind: "crisis" };

/** Whether a caller's words ask for clinical advice (refuse, offer the host) or signal a crisis (emergency numbers). */
export function screen(text: string): Screen {
  if (CRISIS.some((r) => r.test(text))) return { kind: "crisis" };
  if (ADVICE.some((r) => r.test(text))) return { kind: "advice" };
  return { kind: "ok" };
}

/** What the agent says for each. India: 112 for emergencies, Tele-MANAS 14416 for mental health support (24x7, free). */
export const SAY = {
  advice: {
    en: "I'm sorry, I can't give medical or therapy advice. I'll pass your question to the practice and they'll call you back.",
    hi: "माफ़ कीजिए, मैं दवा या इलाज से जुड़ी सलाह नहीं दे सकती। मैं आपका सवाल प्रैक्टिस तक पहुँचा दूँगी, वे आपको वापस कॉल करेंगे।",
  },
  crisis: {
    en: "If you are in danger right now, please call 112. For free mental health support at any hour, call Tele-MANAS on 14416. I'm letting the practice know right away.",
    hi: "अगर आप अभी खतरे में हैं तो कृपया 112 पर कॉल करें। किसी भी समय मुफ़्त मानसिक स्वास्थ्य सहायता के लिए टेली-मानस 14416 पर कॉल करें। मैं अभी प्रैक्टिस को बता रही हूँ।",
  },
  handoff: {
    en: "I'm sorry I couldn't sort that out. Let me take a message, and the practice will call you back.",
    hi: "माफ़ कीजिए, मैं यह नहीं कर पाई। मैं आपका संदेश ले लेती हूँ, प्रैक्टिस आपको वापस कॉल करेगी।",
  },
  confirmFirst: {
    en: "Before booking, read back the name, service, date and time to the caller and wait for a clear yes.",
    hi: "बुक करने से पहले नाम, सेवा, तारीख और समय दोहराइए और साफ़ 'हाँ' का इंतज़ार कीजिए।",
  },
  capReached: {
    en: "Sorry, the assistant isn't available right now. Please book online or call again later. Goodbye.",
    hi: "माफ़ कीजिए, सहायक अभी उपलब्ध नहीं है। कृपया ऑनलाइन बुक करें या बाद में कॉल करें। धन्यवाद।",
  },
} as const;

export type VoiceLang = "en" | "hi";
export const voiceLang = (v: unknown): VoiceLang => (v === "hi" ? "hi" : "en");
