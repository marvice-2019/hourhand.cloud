// Host dashboard words: phone alerts, Hindi. Draft: needs native-speaker review (see docs/i18n-host.md).
import type { push as en } from "../en/push";
export const push: Record<keyof typeof en, string> = {
  "push.title": "फ़ोन अलर्ट",
  "push.intro": "जब कोई सेशन बुक करे, बदले या रद्द करे, तो इस फ़ोन या कंप्यूटर पर सूचना पाएँ।",
  "push.notSetUp": "इस सर्वर पर फ़ोन अलर्ट अभी सेट नहीं हैं।",
  "push.unsupported": "यह ब्राउज़र अलर्ट नहीं दिखा सकता। Chrome, Edge, Firefox या Safari आज़माएँ।",
  "push.installFirst": "iPhone और iPad पर पहले Hourhand को होम स्क्रीन पर जोड़ें (Share, फिर Add to Home Screen)। वहीं से खोलें और अलर्ट चालू करें।",
  "push.blocked": "इस ब्राउज़र में Hourhand की सूचनाएँ बंद हैं। इस साइट की ब्राउज़र सेटिंग में उन्हें अनुमति दें, फिर यह पेज दोबारा लोड करें।",
  "push.on": "इस डिवाइस पर चालू है।",
  "push.devices": "अलर्ट वाले डिवाइस: {n}",
  "push.turnOn": "इस डिवाइस पर अलर्ट चालू करें",
  "push.turnOff": "इस डिवाइस पर बंद करें",
  "push.test": "टेस्ट अलर्ट भेजें",
  "push.testSent": "टेस्ट भेजा गया। कुछ सेकंड में दिखना चाहिए।",
  "push.error": "यह नहीं हो सका। थोड़ी देर में फिर कोशिश करें।",
  "push.titleBooked": "नई बुकिंग",
  "push.titleMoved": "बुकिंग का समय बदला",
  "push.titleCancelled": "बुकिंग रद्द हुई",
  "push.body": "{guest} · {event} · {when}",
  "push.testTitle": "फ़ोन अलर्ट चालू हैं",
  "push.testBody": "हर नई, बदली या रद्द बुकिंग की सूचना यहाँ आएगी।",
};
