// Host dashboard words: feedback, Tamil. Draft: needs native-speaker review (see docs/i18n-host.md).
import type { feedback as en } from "../en/feedback";
export const feedback: Record<keyof typeof en, string> = {
  "feedback.title": "கருத்துகள்",
  "feedback.intro": "செஷனுக்குப் பிறகு விருந்தினர்கள் கொடுத்த மதிப்பீடுகளும் கருத்துகளும். ஒரு விருந்தினர் தன்னுடையதைக் காட்ட ஒப்புக்கொண்டு நீங்கள் தேர்ந்தெடுத்தால் தவிர, அவற்றை நீங்கள் மட்டுமே பார்க்க முடியும். கருத்துப் படிவத்தை ஒவ்வொரு நிகழ்வு வகையிலும் “செஷனுக்குப் பிறகு” பகுதியில் ஆன் செய்யுங்கள்.",
  "feedback.average": "5-க்கு {average}",
  "feedback.summaryOne": "{count} பதிலிலிருந்து {average}",
  "feedback.summaryMany": "{count} பதில்களிலிருந்து {average}",
  "feedback.none": "இன்னும் கருத்து எதுவும் இல்லை.",
  "feedback.rating": "{rating} / 5",
  "feedback.entry": "{rating} · {guest} · {event}, {date}",
  "feedback.openBooking": "புக்கிங்கைத் திற",
  "feedback.showOnPage": "என் புக்கிங் பக்கத்தில் ரிவ்யூக்களைக் காட்டு",
  "feedback.showOnPageHint": "விருந்தினர் ஒப்புக்கொண்டு, நீங்கள் கீழே தேர்ந்தெடுக்கும் ரிவ்யூக்கள் மட்டுமே உங்கள் பக்கத்தில் தெரியும்.",
  "feedback.savePage": "சேமி",
  "feedback.pageOn": "இப்போது உங்கள் புக்கிங் பக்கத்தில் ரிவ்யூக்கள் தெரிகின்றன.",
  "feedback.pageOff": "உங்கள் புக்கிங் பக்கத்திலிருந்து ரிவ்யூக்கள் மறைக்கப்பட்டன.",
  "feedback.consentedNamed": "இதை உங்கள் பக்கத்தில் {name} என்ற பெயரில் காட்ட விருந்தினர் ஒப்புக்கொண்டார்.",
  "feedback.consentedAnon": "இதை உங்கள் பக்கத்தில் பெயர் இல்லாமல் காட்ட விருந்தினர் ஒப்புக்கொண்டார்.",
  "feedback.show": "என் பக்கத்தில் காட்டு",
  "feedback.hide": "என் பக்கத்திலிருந்து மறை",
  "feedback.shown": "உங்கள் பக்கத்தில் தெரிகிறது.",
};
