// Host dashboard words: phone alerts, Tamil. Draft: needs native-speaker review (see docs/i18n-host.md).
import type { push as en } from "../en/push";
export const push: Record<keyof typeof en, string> = {
  "push.title": "தொலைபேசி அறிவிப்புகள்",
  "push.intro": "யாராவது ஒரு அமர்வை முன்பதிவு செய்தால், மாற்றினால் அல்லது ரத்து செய்தால் இந்த தொலைபேசி அல்லது கணினியில் அறிவிப்பு பெறுங்கள்.",
  "push.notSetUp": "இந்த சர்வரில் தொலைபேசி அறிவிப்புகள் இன்னும் அமைக்கப்படவில்லை.",
  "push.unsupported": "இந்த உலாவியால் அறிவிப்புகளைக் காட்ட முடியாது. Chrome, Edge, Firefox அல்லது Safari பயன்படுத்துங்கள்.",
  "push.installFirst": "iPhone, iPad-இல் முதலில் Hourhand-ஐ முகப்புத் திரையில் சேருங்கள் (Share, பிறகு Add to Home Screen). அங்கிருந்து திறந்து அறிவிப்புகளை இயக்குங்கள்.",
  "push.blocked": "இந்த உலாவியில் Hourhand அறிவிப்புகள் தடுக்கப்பட்டுள்ளன. இந்தத் தளத்திற்கான உலாவி அமைப்புகளில் அனுமதித்து, இந்தப் பக்கத்தை மீண்டும் ஏற்றுங்கள்.",
  "push.on": "இந்த சாதனத்தில் இயக்கத்தில் உள்ளது.",
  "push.devices": "அறிவிப்புகள் இயக்கிய சாதனங்கள்: {n}",
  "push.turnOn": "இந்த சாதனத்தில் அறிவிப்புகளை இயக்கு",
  "push.turnOff": "இந்த சாதனத்தில் நிறுத்து",
  "push.test": "சோதனை அறிவிப்பு அனுப்பு",
  "push.testSent": "சோதனை அனுப்பப்பட்டது. சில வினாடிகளில் தெரியும்.",
  "push.error": "அது வேலை செய்யவில்லை. சிறிது நேரத்தில் மீண்டும் முயலுங்கள்.",
  "push.titleBooked": "புதிய முன்பதிவு",
  "push.titleMoved": "முன்பதிவு நேரம் மாற்றப்பட்டது",
  "push.titleCancelled": "முன்பதிவு ரத்து செய்யப்பட்டது",
  "push.titleRequest": "புக்கிங் கோரிக்கை",
  "push.body": "{guest} · {event} · {when}",
  "push.testTitle": "தொலைபேசி அறிவிப்புகள் இயக்கத்தில் உள்ளன",
  "push.testBody": "ஒவ்வொரு புதிய, மாற்றிய அல்லது ரத்து செய்த முன்பதிவுக்கும் இங்கே அறிவிப்பு வரும்.",
};
