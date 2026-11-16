// Host dashboard words: feedback, Hindi. Draft: needs native-speaker review (see docs/i18n-host.md).
import type { feedback as en } from "../en/feedback";
export const feedback: Record<keyof typeof en, string> = {
  "feedback.title": "फ़ीडबैक",
  "feedback.intro": "सेशन के बाद मेहमानों की दी हुई रेटिंग और कमेंट। इन्हें सिर्फ़ आप देखते हैं। फ़ीडबैक फ़ॉर्म हर इवेंट टाइप में “सेशन के बाद” के अंदर चालू करें।",
  "feedback.average": "5 में से {average}",
  "feedback.summaryOne": "{count} जवाब के आधार पर {average}",
  "feedback.summaryMany": "{count} जवाबों के आधार पर {average}",
  "feedback.none": "अभी कोई फ़ीडबैक नहीं।",
  "feedback.rating": "{rating} / 5",
  "feedback.entry": "{rating} · {guest} · {event}, {date}",
  "feedback.openBooking": "बुकिंग खोलें",
};
