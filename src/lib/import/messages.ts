// Every message the importer shows the host (fetch errors, left-behind reasons, per-row notes, failed imports), by
// code, in English. The importer builds its English from here; the dashboard turns the English back into its code
// and shows host catalogue line IMPORT_MESSAGE_KEYS[code] instead (lib-messages-import.test.ts checks they match).
// Pure: the import page's client component uses it too.
import { EVENT_TYPE_MESSAGES } from "../event-types";
import type { HostI18n } from "../i18n/host/format";
import type { HostKey } from "../i18n/host";
import { decode, fillTemplate, translator } from "../i18n/host/lib-messages";

/** Ordered so a more specific template comes before one that could also match it. */
export const IMPORT_MESSAGES = {
  // Fetch errors. {label} is the provider's name (Calendly, Cal.com).
  timeout: "{label} took too long to answer. Try again in a minute.",
  unreachable: "Couldn't reach {label} just now. Try again in a minute.",
  rateLimited: "{label} is limiting requests right now. Wait a minute, then try again.",
  providerError: "{label} had a problem answering (error {status}). Try again in a minute.",
  unreadable: "{label} sent an answer Hourhand couldn't read. Try again, or create the event types by hand.",
  unreadableRetry: "{label} sent an answer Hourhand couldn't read. Try again in a minute.",
  calcomBadToken: "Cal.com didn't accept that API key. Make a new one in Cal.com (Settings → Developer → API keys) and paste the whole key, starting cal_.",
  calcomNotFound: "Cal.com couldn't find that username. Use the name at the end of your cal.com link, like cal.com/yourname.",
  calcomNoEventTypes: "Cal.com has no event types for \"{user}\". Check the username is yours, as in cal.com/yourname.",
  calendlyBadToken: "Calendly didn't accept that token. Make a new personal access token in Calendly (Integrations → API and webhooks) with event types read access, and paste it here.",
  calendlyNotFound: "Calendly couldn't find your account with that token. Check you copied the whole token.",
  // The preview form.
  pickProvider: "Pick Calendly or Cal.com.",
  calendlyTokenMissing: "Paste your Calendly personal access token.",
  calcomKeyMissing: "Paste your Cal.com API key.",
  calcomUsernameMissing: "Enter your Cal.com username, as in cal.com/yourname.",
  tooManyTries: "That's a lot of tries in a short time. Wait ten minutes, then try again.",
  noneFound: "No event types were found on that account.",
  fetchFailed: "Something went wrong fetching your event types. Try again in a minute.",
  previewExpired: "This preview has expired. Fetch your event types again.",
  tickOne: "Tick at least one event type to import.",
  // Left behind.
  teamCalcom: "Team event (round robin, collective or managed). Hourhand books one host per link for now.",
  teamCalendly: "Team event (round robin or collective). Hourhand books one host per link for now.",
  overLimit: "Only {max} event types come over in one import.",
  // Notes on an event type that comes over.
  calcomLengths: "Cal.com offered {options} minutes; only {n} minutes came over.",
  calendlyLengths: "Calendly offered {options} minutes; only {n} minutes came over.",
  seatsCapped: "Seats per time slot changed from {from} to {max}, Hourhand's most.",
  firstLocationOnly: "Only the first location came over.",
  locationUnknownNoMatch: "The location (unknown) has no match in Hourhand; pick one before switching it on.",
  locationNoMatch: "The location ({kind}) has no match in Hourhand; pick one before switching it on.",
  locationNoAddress: "The location had no address; add one before switching it on.",
  locationNoNumber: "The phone location had no number; add one before switching it on.",
  calendlySwitchedOff: "It was switched off in Calendly.",
  calendlyGroup: "It was a group event. Calendly doesn't share the invitee limit, so it comes over as one-on-one: set guests per session before switching it on.",
  otherChoice: "\"{label}\" had an \"Other\" write-in choice, which Hourhand doesn't have.",
  noLength: "No length was given, so it is set to 30 minutes.",
  lengthChanged: "Length changed from {from} to {to} minutes (Hourhand allows {min} to {max}).",
  bufferBeforeChanged: "Buffer before changed from {from} to {to} minutes.",
  bufferAfterChanged: "Buffer after changed from {from} to {to} minutes.",
  incrementChanged: "Start times every {from} minutes became every {to} minutes.",
  fewChoices: "\"{label}\" had fewer than two choices, so it is now a short answer.",
  nowShortText: "\"{label}\" was a {from} question; it is now a short answer.",
  nowLongText: "\"{label}\" was a {from} question; it is now a long answer.",
  nowPhone: "\"{label}\" was a {from} question; it is now a phone number.",
  nowSingleSelect: "\"{label}\" was a {from} question; it is now a single choice.",
  nowMultiSelect: "\"{label}\" was a {from} question; it is now a multiple choice.",
  nowConsent: "\"{label}\" was a {from} question; it is now a tick box.",
  questionsCapped: "Only the first {max} questions came over.",
  slugMoved: "The link {from} was taken, so it is {to}.",
  // Failed imports. A failed check from the event type editor is its messages (EVENT_TYPE_MESSAGES) joined by spaces.
  notValid: "It didn't pass Hourhand's checks.",
  questionInvalid: "One of its questions didn't pass Hourhand's checks.",
  noFreeLink: "Couldn't find a free link for it. Try again.",
} as const;

export type ImportMessageCode = keyof typeof IMPORT_MESSAGES;

/** The English line for a code, with its values filled in. */
export const importMessage = (code: ImportMessageCode, vars?: Record<string, string | number>): string =>
  fillTemplate(IMPORT_MESSAGES[code], vars);

/** Host catalogue line for each code (src/lib/i18n/host/en/eventTypes.ts). */
export const IMPORT_MESSAGE_KEYS = {
  timeout: "eventTypes.importMsgTimeout",
  unreachable: "eventTypes.importMsgUnreachable",
  rateLimited: "eventTypes.importMsgRateLimited",
  providerError: "eventTypes.importMsgProviderError",
  unreadable: "eventTypes.importMsgUnreadable",
  unreadableRetry: "eventTypes.importMsgUnreadableRetry",
  calcomBadToken: "eventTypes.importMsgCalcomBadToken",
  calcomNotFound: "eventTypes.importMsgCalcomNotFound",
  calcomNoEventTypes: "eventTypes.importMsgCalcomNoEventTypes",
  calendlyBadToken: "eventTypes.importMsgCalendlyBadToken",
  calendlyNotFound: "eventTypes.importMsgCalendlyNotFound",
  pickProvider: "eventTypes.importMsgPickProvider",
  calendlyTokenMissing: "eventTypes.importMsgCalendlyTokenMissing",
  calcomKeyMissing: "eventTypes.importMsgCalcomKeyMissing",
  calcomUsernameMissing: "eventTypes.importMsgCalcomUsernameMissing",
  tooManyTries: "eventTypes.importMsgTooManyTries",
  noneFound: "eventTypes.importMsgNoneFound",
  fetchFailed: "eventTypes.importMsgFetchFailed",
  previewExpired: "eventTypes.importMsgPreviewExpired",
  tickOne: "eventTypes.importMsgTickOne",
  teamCalcom: "eventTypes.importMsgTeamCalcom",
  teamCalendly: "eventTypes.importMsgTeamCalendly",
  overLimit: "eventTypes.importMsgOverLimit",
  calcomLengths: "eventTypes.importMsgCalcomLengths",
  calendlyLengths: "eventTypes.importMsgCalendlyLengths",
  seatsCapped: "eventTypes.importMsgSeatsCapped",
  firstLocationOnly: "eventTypes.importMsgFirstLocationOnly",
  locationUnknownNoMatch: "eventTypes.importMsgLocationUnknownNoMatch",
  locationNoMatch: "eventTypes.importMsgLocationNoMatch",
  locationNoAddress: "eventTypes.importMsgLocationNoAddress",
  locationNoNumber: "eventTypes.importMsgLocationNoNumber",
  calendlySwitchedOff: "eventTypes.importMsgCalendlySwitchedOff",
  calendlyGroup: "eventTypes.importMsgCalendlyGroup",
  otherChoice: "eventTypes.importMsgOtherChoice",
  noLength: "eventTypes.importMsgNoLength",
  lengthChanged: "eventTypes.importMsgLengthChanged",
  bufferBeforeChanged: "eventTypes.importMsgBufferBeforeChanged",
  bufferAfterChanged: "eventTypes.importMsgBufferAfterChanged",
  incrementChanged: "eventTypes.importMsgIncrementChanged",
  fewChoices: "eventTypes.importMsgFewChoices",
  nowShortText: "eventTypes.importMsgNowShortText",
  nowLongText: "eventTypes.importMsgNowLongText",
  nowPhone: "eventTypes.importMsgNowPhone",
  nowSingleSelect: "eventTypes.importMsgNowSingleSelect",
  nowMultiSelect: "eventTypes.importMsgNowMultiSelect",
  nowConsent: "eventTypes.importMsgNowConsent",
  questionsCapped: "eventTypes.importMsgQuestionsCapped",
  slugMoved: "eventTypes.importMsgSlugMoved",
  notValid: "eventTypes.importMsgNotValid",
  questionInvalid: "eventTypes.importMsgQuestionInvalid",
  noFreeLink: "eventTypes.importMsgNoFreeLink",
} as const satisfies Record<ImportMessageCode, HostKey>;

/** Event type editor message codes and their host lines ("eventTypes.err" + the code with a capital first letter). */
const eventTypeKey = (code: keyof typeof EVENT_TYPE_MESSAGES) => `eventTypes.err${code[0].toUpperCase()}${code.slice(1)}` as HostKey;

/** Event type editor messages, joined by single spaces, each shown in the host's language; null if it isn't that. */
function sayEventTypeErrors(t: HostI18n["t"], english: string): string | null {
  const one = (part: string) => {
    const found = decode(EVENT_TYPE_MESSAGES, part);
    // The editor's values are always whole numbers, which keeps a short template from swallowing the next message.
    return found && Object.values(found.vars).every((v) => /^-?\d+$/.test(v)) ? t(eventTypeKey(found.code), found.vars) : null;
  };
  const whole = one(english);
  if (whole !== null) return whole;
  for (let i = english.indexOf(" "); i !== -1; i = english.indexOf(" ", i + 1)) {
    const head = one(english.slice(0, i));
    if (head === null) continue;
    const rest = sayEventTypeErrors(t, english.slice(i + 1));
    if (rest !== null) return `${head} ${rest}`;
  }
  return null;
}

const sayTable = translator(IMPORT_MESSAGES, IMPORT_MESSAGE_KEYS);

/** Any importer message in the host's language; anything not recognised is shown as it came. */
export function sayImportMessage(t: HostI18n["t"], english: string): string {
  if (decode(IMPORT_MESSAGES, english)) return sayTable(t, english);
  return sayEventTypeErrors(t, english) ?? english;
}
