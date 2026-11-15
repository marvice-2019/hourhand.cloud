import type { Locale } from "../i18n/guest";
import type { JoinRefusal } from "./join";

// The video join refusal page in the guest's language. A language without an entry falls back to English, so adding a
// guest language elsewhere never breaks this page; add its lines here when you can.

export type RefusalReason = Exclude<JoinRefusal, "not_found">;
type Lines = Record<RefusalReason, { title: string; body: string }> & { opensAt: string; seeBooking: string; pageTitle: string };

const en: Lines = {
  not_video: { title: "This booking isn't on Hourhand video", body: "Check the booking for where you meet." },
  not_set_up: { title: "Video isn't available right now", body: "Hourhand video is not set up on this server. Please contact the host." },
  plan: { title: "Video isn't available for this booking", body: "The host's plan doesn't include Hourhand video right now. Please contact the host." },
  cancelled: { title: "This booking was cancelled or moved", body: "This link no longer opens a call. If it was moved, use the link from the latest confirmation." },
  not_confirmed: { title: "This booking isn't confirmed yet", body: "The call opens once the booking is confirmed." },
  too_early: { title: "The call hasn't opened yet", body: "The room opens 15 minutes before the start. Come back then with this same link." },
  ended: { title: "This call has ended", body: "The room closed 30 minutes after the booked end time." },
  opensAt: "Opens {date} at {time} ({zone}).",
  seeBooking: "See your booking",
  pageTitle: "Join the call",
};

const hi: Lines = {
  not_video: { title: "यह बुकिंग Hourhand video पर नहीं है", body: "आप कहाँ मिलेंगे, यह बुकिंग में देखें।" },
  not_set_up: { title: "वीडियो अभी उपलब्ध नहीं है", body: "इस सर्वर पर Hourhand video सेट अप नहीं है। कृपया होस्ट से संपर्क करें।" },
  plan: { title: "इस बुकिंग के लिए वीडियो उपलब्ध नहीं है", body: "होस्ट के प्लान में अभी Hourhand video शामिल नहीं है। कृपया होस्ट से संपर्क करें।" },
  cancelled: { title: "यह बुकिंग कैंसल हो गई या इसका समय बदल गया", body: "यह लिंक अब कॉल नहीं खोलता। अगर समय बदला है, तो सबसे नए कन्फ़र्मेशन वाला लिंक इस्तेमाल करें।" },
  not_confirmed: { title: "यह बुकिंग अभी कन्फ़र्म नहीं हुई है", body: "बुकिंग कन्फ़र्म होते ही कॉल खुल जाएगी।" },
  too_early: { title: "कॉल अभी नहीं खुली है", body: "रूम शुरू होने से 15 मिनट पहले खुलता है। तब इसी लिंक से वापस आएँ।" },
  ended: { title: "यह कॉल खत्म हो चुकी है", body: "बुक किए गए समय के खत्म होने के 30 मिनट बाद रूम बंद हो गया।" },
  opensAt: "{date} को {time} बजे खुलेगा ({zone})।",
  seeBooking: "अपनी बुकिंग देखें",
  pageTitle: "कॉल जॉइन करें",
};

const ta: Lines = {
  not_video: { title: "இந்த புக்கிங் Hourhand video-வில் இல்லை", body: "எங்கே சந்திப்பது என்பதை புக்கிங்கில் பாருங்கள்." },
  not_set_up: { title: "வீடியோ இப்போது கிடைக்கவில்லை", body: "இந்த சர்வரில் Hourhand video அமைக்கப்படவில்லை. ஹோஸ்ட்டைத் தொடர்பு கொள்ளுங்கள்." },
  plan: { title: "இந்த புக்கிங்கிற்கு வீடியோ கிடைக்கவில்லை", body: "ஹோஸ்ட்டின் பிளானில் இப்போது Hourhand video இல்லை. ஹோஸ்ட்டைத் தொடர்பு கொள்ளுங்கள்." },
  cancelled: { title: "இந்த புக்கிங் ரத்து செய்யப்பட்டது அல்லது நேரம் மாற்றப்பட்டது", body: "இந்த லிங்க் இனி காலைத் திறக்காது. நேரம் மாற்றப்பட்டிருந்தால், சமீபத்திய உறுதிப்படுத்தலில் உள்ள லிங்கைப் பயன்படுத்துங்கள்." },
  not_confirmed: { title: "இந்த புக்கிங் இன்னும் உறுதியாகவில்லை", body: "புக்கிங் உறுதியானதும் கால் திறக்கும்." },
  too_early: { title: "கால் இன்னும் திறக்கவில்லை", body: "தொடங்குவதற்கு 15 நிமிடங்கள் முன்பு அறை திறக்கும். அப்போது இதே லிங்கில் வாருங்கள்." },
  ended: { title: "இந்த கால் முடிந்துவிட்டது", body: "புக் செய்த முடிவு நேரத்திலிருந்து 30 நிமிடங்களில் அறை மூடப்பட்டது." },
  opensAt: "{date} அன்று {time} மணிக்குத் திறக்கும் ({zone}).",
  seeBooking: "உங்கள் புக்கிங்கைப் பாருங்கள்",
  pageTitle: "காலில் சேருங்கள்",
};

const te: Lines = {
  not_video: { title: "ఈ బుకింగ్ Hourhand videoలో లేదు", body: "ఎక్కడ కలవాలో బుకింగ్‌లో చూడండి." },
  not_set_up: { title: "వీడియో ప్రస్తుతం అందుబాటులో లేదు", body: "ఈ సర్వర్‌లో Hourhand video సెటప్ చేయలేదు. దయచేసి హోస్ట్‌ను సంప్రదించండి." },
  plan: { title: "ఈ బుకింగ్‌కు వీడియో అందుబాటులో లేదు", body: "హోస్ట్ ప్లాన్‌లో ప్రస్తుతం Hourhand video లేదు. దయచేసి హోస్ట్‌ను సంప్రదించండి." },
  cancelled: { title: "ఈ బుకింగ్ రద్దయింది లేదా సమయం మారింది", body: "ఈ లింక్ ఇక కాల్‌ను తెరవదు. సమయం మారితే, తాజా కన్ఫర్మేషన్‌లోని లింక్ వాడండి." },
  not_confirmed: { title: "ఈ బుకింగ్ ఇంకా కన్ఫర్మ్ కాలేదు", body: "బుకింగ్ కన్ఫర్మ్ అయిన వెంటనే కాల్ తెరుచుకుంటుంది." },
  too_early: { title: "కాల్ ఇంకా తెరుచుకోలేదు", body: "మొదలయ్యే 15 నిమిషాల ముందు రూమ్ తెరుచుకుంటుంది. అప్పుడు ఇదే లింక్‌తో రండి." },
  ended: { title: "ఈ కాల్ ముగిసింది", body: "బుక్ చేసిన ముగింపు సమయం తర్వాత 30 నిమిషాలకు రూమ్ మూసివేయబడింది." },
  opensAt: "{date}న {time}కి తెరుచుకుంటుంది ({zone}).",
  seeBooking: "మీ బుకింగ్ చూడండి",
  pageTitle: "కాల్‌లో చేరండి",
};

const kn: Lines = {
  not_video: { title: "ಈ ಬುಕಿಂಗ್ Hourhand videoನಲ್ಲಿ ಇಲ್ಲ", body: "ಎಲ್ಲಿ ಭೇಟಿಯಾಗಬೇಕು ಎಂದು ಬುಕಿಂಗ್‌ನಲ್ಲಿ ನೋಡಿ." },
  not_set_up: { title: "ವೀಡಿಯೊ ಈಗ ಲಭ್ಯವಿಲ್ಲ", body: "ಈ ಸರ್ವರ್‌ನಲ್ಲಿ Hourhand video ಸೆಟಪ್ ಆಗಿಲ್ಲ. ದಯವಿಟ್ಟು ಹೋಸ್ಟ್ ಅನ್ನು ಸಂಪರ್ಕಿಸಿ." },
  plan: { title: "ಈ ಬುಕಿಂಗ್‌ಗೆ ವೀಡಿಯೊ ಲಭ್ಯವಿಲ್ಲ", body: "ಹೋಸ್ಟ್‌ನ ಪ್ಲಾನ್‌ನಲ್ಲಿ ಈಗ Hourhand video ಇಲ್ಲ. ದಯವಿಟ್ಟು ಹೋಸ್ಟ್ ಅನ್ನು ಸಂಪರ್ಕಿಸಿ." },
  cancelled: { title: "ಈ ಬುಕಿಂಗ್ ರದ್ದಾಗಿದೆ ಅಥವಾ ಸಮಯ ಬದಲಾಗಿದೆ", body: "ಈ ಲಿಂಕ್ ಇನ್ನು ಕಾಲ್ ತೆರೆಯುವುದಿಲ್ಲ. ಸಮಯ ಬದಲಾಗಿದ್ದರೆ, ಇತ್ತೀಚಿನ ಕನ್ಫರ್ಮೇಶನ್‌ನಲ್ಲಿರುವ ಲಿಂಕ್ ಬಳಸಿ." },
  not_confirmed: { title: "ಈ ಬುಕಿಂಗ್ ಇನ್ನೂ ಕನ್ಫರ್ಮ್ ಆಗಿಲ್ಲ", body: "ಬುಕಿಂಗ್ ಕನ್ಫರ್ಮ್ ಆದ ತಕ್ಷಣ ಕಾಲ್ ತೆರೆಯುತ್ತದೆ." },
  too_early: { title: "ಕಾಲ್ ಇನ್ನೂ ತೆರೆದಿಲ್ಲ", body: "ಆರಂಭಕ್ಕೆ 15 ನಿಮಿಷ ಮೊದಲು ರೂಮ್ ತೆರೆಯುತ್ತದೆ. ಆಗ ಇದೇ ಲಿಂಕ್‌ನಿಂದ ಬನ್ನಿ." },
  ended: { title: "ಈ ಕಾಲ್ ಮುಗಿದಿದೆ", body: "ಬುಕ್ ಮಾಡಿದ ಮುಕ್ತಾಯ ಸಮಯದ 30 ನಿಮಿಷಗಳ ನಂತರ ರೂಮ್ ಮುಚ್ಚಲಾಯಿತು." },
  opensAt: "{date} ರಂದು {time}ಕ್ಕೆ ತೆರೆಯುತ್ತದೆ ({zone}).",
  seeBooking: "ನಿಮ್ಮ ಬುಕಿಂಗ್ ನೋಡಿ",
  pageTitle: "ಕಾಲ್‌ಗೆ ಸೇರಿ",
};

const LINES: Partial<Record<Locale, Lines>> = { en, hi, ta, te, kn };

/** The refusal page's lines in `locale`, or English when there are none for it yet. */
export function refusalLines(locale: Locale): Lines {
  return LINES[locale] ?? en;
}

/** Splits "Opens {date} at {time}" into text and placeholder parts, so a component can drop a node into each slot. */
export function splitTemplate(template: string): { text: string; slot: string | null }[] {
  return template.split(/(\{\w+\})/).filter(Boolean).map((part) => {
    const slot = /^\{(\w+)\}$/.exec(part)?.[1] ?? null;
    return { text: slot ? "" : part, slot };
  });
}
