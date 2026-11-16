// Host dashboard words: seat, Hindi. Draft: needs native-speaker review (see docs/i18n-host.md).
import type { seat as en } from "../en/seat";
export const seat: Record<keyof typeof en, string> = {
  "seat.errorNotDuo": "दूसरा व्यक्ति जोड़ने की सुविधा Duo प्लान में मिलती है।",
  "seat.errorInvalidEmail": "सही ईमेल पता डालें।",
  "seat.errorOwnEmail": "यह आपका अपना ईमेल है। दूसरे व्यक्ति का ईमेल डालें।",
  "seat.errorTaken": "यह व्यक्ति पहले से किसी और Duo प्लान में दूसरा व्यक्ति है।",
  "seat.errorTooMany": "आज आप 3 न्योते भेज चुके हैं। कल फिर से कोशिश करें।",
  "seat.errorDemo": "डेमो कॉपी में लोग नहीं जोड़े जा सकते।",
  "seat.isSecondPerson": "{name} ({email}) आपके दूसरे व्यक्ति हैं।",
  "seat.invitationPending": "{email} पर न्योता भेजा गया। उस ईमेल से साइन इन करते ही यह काम करेगा।",
  "seat.inviteSomeoneElse": "इसके बजाय किसी और को न्योता दें",
  "seat.theirEmail": "उनका ईमेल",
  "seat.invited": "न्योता भेज दिया गया।",
  "seat.sendInvitation": "न्योता भेजें",
};
