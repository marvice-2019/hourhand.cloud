// Host dashboard words: feedback, Hindi. Draft: needs native-speaker review (see docs/i18n-host.md).
import type { feedback as en } from "../en/feedback";
export const feedback: Record<keyof typeof en, string> = {
  "feedback.title": "फ़ीडबैक",
  "feedback.intro": "सेशन के बाद मेहमानों की दी हुई रेटिंग और कमेंट। इन्हें सिर्फ़ आप देखते हैं, जब तक कोई मेहमान अपना रिव्यू दिखाने की अनुमति न दे और आप उसे न चुनें। फ़ीडबैक फ़ॉर्म हर इवेंट टाइप में “सेशन के बाद” के अंदर चालू करें।",
  "feedback.average": "5 में से {average}",
  "feedback.summaryOne": "{count} जवाब के आधार पर {average}",
  "feedback.summaryMany": "{count} जवाबों के आधार पर {average}",
  "feedback.none": "अभी कोई फ़ीडबैक नहीं।",
  "feedback.rating": "{rating} / 5",
  "feedback.entry": "{rating} · {guest} · {event}, {date}",
  "feedback.openBooking": "बुकिंग खोलें",
  "feedback.showOnPage": "मेरे बुकिंग पेज पर रिव्यू दिखाएँ",
  "feedback.showOnPageHint": "सिर्फ़ वही रिव्यू दिखेंगे जिनके मेहमान ने अनुमति दी है और जिन्हें आप नीचे चुनते हैं।",
  "feedback.savePage": "सेव करें",
  "feedback.pageOn": "अब आपके बुकिंग पेज पर रिव्यू दिख रहे हैं।",
  "feedback.pageOff": "आपके बुकिंग पेज से रिव्यू छिपा दिए गए हैं।",
  "feedback.consentedNamed": "मेहमान ने इसे आपके पेज पर {name} के नाम से दिखाने की अनुमति दी है।",
  "feedback.consentedAnon": "मेहमान ने इसे आपके पेज पर बिना नाम के दिखाने की अनुमति दी है।",
  "feedback.show": "मेरे पेज पर दिखाएँ",
  "feedback.hide": "मेरे पेज से छिपाएँ",
  "feedback.shown": "आपके पेज पर दिख रहा है।",
};
