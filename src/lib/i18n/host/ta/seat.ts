// Host dashboard words: seat, Tamil. Draft: needs native-speaker review (see docs/i18n-host.md).
import type { seat as en } from "../en/seat";
export const seat: Record<keyof typeof en, string> = {
  "seat.errorNotDuo": "இரண்டாவது நபரைச் சேர்க்கும் வசதி Duo பிளானில் கிடைக்கும்.",
  "seat.errorInvalidEmail": "சரியான ஈமெயில் முகவரியை உள்ளிடுங்கள்.",
  "seat.errorOwnEmail": "இது உங்கள் சொந்த ஈமெயில். மற்றவரின் ஈமெயிலை உள்ளிடுங்கள்.",
  "seat.errorTaken": "அவர் ஏற்கனவே வேறொரு Duo பிளானில் இரண்டாவது நபராக இருக்கிறார்.",
  "seat.errorTooMany": "இன்று 3 அழைப்புகளை அனுப்பிவிட்டீர்கள். நாளை மீண்டும் முயற்சி செய்யுங்கள்.",
  "seat.errorDemo": "டெமோ பதிப்பில் நபர்களைச் சேர்க்க முடியாது.",
  "seat.isSecondPerson": "{name} ({email}) உங்கள் இரண்டாவது நபர்.",
  "seat.invitationPending": "{email}-க்கு அழைப்பு அனுப்பப்பட்டது. அவர் அந்த ஈமெயிலுடன் சைன் இன் செய்ததும் இது வேலை செய்யும்.",
  "seat.inviteSomeoneElse": "அதற்குப் பதிலாக வேறொருவரை அழை",
  "seat.theirEmail": "அவரது ஈமெயில்",
  "seat.invited": "அழைப்பு அனுப்பப்பட்டது.",
  "seat.sendInvitation": "அழைப்பை அனுப்பு",
};
