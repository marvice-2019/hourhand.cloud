// Host dashboard words: feedback, Tamil. Draft: needs native-speaker review (see docs/i18n-host.md).
import type { feedback as en } from "../en/feedback";
export const feedback: Record<keyof typeof en, string> = {
  "feedback.title": "கருத்துகள்",
  "feedback.intro": "செஷனுக்குப் பிறகு விருந்தினர்கள் கொடுத்த மதிப்பீடுகளும் கருத்துகளும். அவற்றை நீங்கள் மட்டுமே பார்க்க முடியும். கருத்துப் படிவத்தை ஒவ்வொரு நிகழ்வு வகையிலும் “செஷனுக்குப் பிறகு” பகுதியில் ஆன் செய்யுங்கள்.",
  "feedback.average": "5-க்கு {average}",
  "feedback.summaryOne": "{count} பதிலிலிருந்து {average}",
  "feedback.summaryMany": "{count} பதில்களிலிருந்து {average}",
  "feedback.none": "இன்னும் கருத்து எதுவும் இல்லை.",
  "feedback.rating": "{rating} / 5",
  "feedback.entry": "{rating} · {guest} · {event}, {date}",
  "feedback.openBooking": "புக்கிங்கைத் திற",
};
