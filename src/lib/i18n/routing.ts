// Words on a routing form's public page (/f/<token>), in every guest language. English is the source; the other
// languages are drafts pending native-speaker review, like the rest of the guest catalogs. The form's own title,
// question and answers are the host's words and are shown as written.
import type { Locale } from "./guest";

const en = {
  intro: "Pick the answer that fits and {host} will show you the right booking page.",
  noOptions: "There's nothing to pick here yet. Ask {host} for their booking link.",
  back: "Back to the question",
  notFoundTitle: "This link doesn't work",
  notFoundBody: "Check you copied all of it, or ask the person who sent it.",
};

export type RoutingKey = keyof typeof en;
type Catalog = Record<RoutingKey, string>;

const hi: Catalog = {
  intro: "जो जवाब आप पर लागू हो, उसे चुनें। {host} आपको सही बुकिंग पेज दिखाएंगे।",
  noOptions: "यहां अभी चुनने के लिए कुछ नहीं है। {host} से उनका बुकिंग लिंक मांगें।",
  back: "सवाल पर वापस जाएं",
  notFoundTitle: "यह लिंक काम नहीं कर रहा",
  notFoundBody: "देखें कि आपने पूरा लिंक कॉपी किया है, या भेजने वाले से पूछें।",
};

const ta: Catalog = {
  intro: "உங்களுக்குப் பொருந்தும் பதிலைத் தேர்ந்தெடுங்கள். {host} சரியான முன்பதிவுப் பக்கத்தைக் காட்டுவார்.",
  noOptions: "இங்கே தேர்ந்தெடுக்க இன்னும் எதுவும் இல்லை. {host} அவர்களிடம் முன்பதிவு இணைப்பைக் கேளுங்கள்.",
  back: "கேள்விக்குத் திரும்பு",
  notFoundTitle: "இந்த இணைப்பு வேலை செய்யவில்லை",
  notFoundBody: "முழு இணைப்பையும் நகலெடுத்தீர்களா என்று பாருங்கள், அல்லது அனுப்பியவரிடம் கேளுங்கள்.",
};

const te: Catalog = {
  intro: "మీకు సరిపోయే జవాబును ఎంచుకోండి. {host} మీకు సరైన బుకింగ్ పేజీని చూపిస్తారు.",
  noOptions: "ఇక్కడ ఇంకా ఎంచుకోవడానికి ఏమీ లేదు. {host} గారిని వారి బుకింగ్ లింక్ అడగండి.",
  back: "ప్రశ్నకు తిరిగి వెళ్ళండి",
  notFoundTitle: "ఈ లింక్ పని చేయడం లేదు",
  notFoundBody: "మీరు లింక్ మొత్తం కాపీ చేశారో లేదో చూడండి, లేదా పంపిన వారిని అడగండి.",
};

const kn: Catalog = {
  intro: "ನಿಮಗೆ ಹೊಂದುವ ಉತ್ತರವನ್ನು ಆರಿಸಿ. {host} ನಿಮಗೆ ಸರಿಯಾದ ಬುಕಿಂಗ್ ಪುಟವನ್ನು ತೋರಿಸುತ್ತಾರೆ.",
  noOptions: "ಇಲ್ಲಿ ಇನ್ನೂ ಆರಿಸಲು ಏನೂ ಇಲ್ಲ. {host} ಅವರಿಂದ ಬುಕಿಂಗ್ ಲಿಂಕ್ ಕೇಳಿ.",
  back: "ಪ್ರಶ್ನೆಗೆ ಹಿಂತಿರುಗಿ",
  notFoundTitle: "ಈ ಲಿಂಕ್ ಕೆಲಸ ಮಾಡುತ್ತಿಲ್ಲ",
  notFoundBody: "ನೀವು ಪೂರ್ತಿ ಲಿಂಕ್ ನಕಲಿಸಿದ್ದೀರಾ ಎಂದು ನೋಡಿ, ಅಥವಾ ಕಳುಹಿಸಿದವರನ್ನು ಕೇಳಿ.",
};

const mr: Catalog = {
  intro: "तुम्हाला लागू होणारे उत्तर निवडा. {host} तुम्हाला योग्य बुकिंग पेज दाखवतील.",
  noOptions: "इथे अजून निवडण्यासारखे काही नाही. {host} यांच्याकडे त्यांची बुकिंग लिंक मागा.",
  back: "प्रश्नाकडे परत जा",
  notFoundTitle: "ही लिंक चालत नाही",
  notFoundBody: "पूर्ण लिंक कॉपी केली आहे का ते पाहा, किंवा पाठवणाऱ्यांना विचारा.",
};

const bn: Catalog = {
  intro: "আপনার জন্য যে উত্তরটি ঠিক, সেটি বেছে নিন। {host} আপনাকে সঠিক বুকিং পেজ দেখাবেন।",
  noOptions: "এখানে এখনও বেছে নেওয়ার কিছু নেই। {host}-এর কাছে বুকিং লিংক চেয়ে নিন।",
  back: "প্রশ্নে ফিরে যান",
  notFoundTitle: "এই লিংকটি কাজ করছে না",
  notFoundBody: "পুরো লিংকটি কপি করেছেন কিনা দেখুন, অথবা যিনি পাঠিয়েছেন তাঁকে জিজ্ঞেস করুন।",
};

const ml: Catalog = {
  intro: "നിങ്ങൾക്ക് ചേരുന്ന ഉത്തരം തിരഞ്ഞെടുക്കുക. {host} നിങ്ങൾക്ക് ശരിയായ ബുക്കിംഗ് പേജ് കാണിക്കും.",
  noOptions: "ഇവിടെ ഇതുവരെ തിരഞ്ഞെടുക്കാൻ ഒന്നുമില്ല. {host} ന്റെ ബുക്കിംഗ് ലിങ്ക് ചോദിക്കുക.",
  back: "ചോദ്യത്തിലേക്ക് മടങ്ങുക",
  notFoundTitle: "ഈ ലിങ്ക് പ്രവർത്തിക്കുന്നില്ല",
  notFoundBody: "ലിങ്ക് മുഴുവനും പകർത്തിയോ എന്ന് നോക്കുക, അല്ലെങ്കിൽ അയച്ചയാളോട് ചോദിക്കുക.",
};

const gu: Catalog = {
  intro: "તમને લાગુ પડતો જવાબ પસંદ કરો. {host} તમને યોગ્ય બુકિંગ પેજ બતાવશે.",
  noOptions: "અહીં હજુ પસંદ કરવા જેવું કંઈ નથી. {host} પાસે તેમની બુકિંગ લિંક માંગો.",
  back: "પ્રશ્ન પર પાછા જાઓ",
  notFoundTitle: "આ લિંક ચાલતી નથી",
  notFoundBody: "આખી લિંક કૉપિ કરી છે કે નહીં તે જુઓ, અથવા મોકલનારને પૂછો.",
};

export const ROUTING_CATALOGS: Record<Locale, Catalog> = { en, hi, ta, te, kn, mr, bn, ml, gu };

/** The line for `key` in `locale`, with each `{name}` replaced from `vars`. */
export function rt(locale: Locale, key: RoutingKey, vars: Record<string, string | number> = {}): string {
  return (ROUTING_CATALOGS[locale] ?? ROUTING_CATALOGS.en)[key].replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}
