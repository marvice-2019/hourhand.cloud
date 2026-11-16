// Host dashboard words: settings. English is the source; see docs/i18n-host.md.
export const settings = {
  "settings.title": "Settings",
  "settings.intro": "Change your name, booking page address, time zone and time format.",
  "settings.eventTypes": "Event types",
  "settings.appearance": "Appearance",
  "settings.appearanceIntro": "Dark mode is easier on the eyes at night. Device follows your phone or computer setting.",
  "settings.dashboardLanguage": "Your language",
  "settings.dashboardLanguageIntro": "The language of your dashboard and of the emails Hourhand sends you. Your booking pages keep their own language, set below.",
  "settings.dashboardLanguageSaved": "Saved. Your dashboard and emails are now in this language.",
  "settings.bookingLanguage": "Booking page language",
  "settings.bookingLanguageIntro": "What guests see first on your booking pages. They can switch to another language at the top of the page.",
  "settings.language": "Language",
  "settings.languageSaved": "Saved. New guests see your booking pages in this language.",
  "settings.signedInAs": "Signed in as {email}",
  "settings.signOutIntro": "Lost a phone or used a shared computer? Sign out everywhere, including this browser.",
  "settings.signOutAll": "Sign out of all devices",
  "settings.demoSessions": "This copy runs on demo data, so there are no sessions to end.",
  "settings.deleteTitle": "Delete your account",
  "settings.deleteIntro":
    "Your booking links stop working straight away and upcoming bookings are cancelled. We keep your data for 30 days in case you change your mind, then delete it for good.",
  "settings.deleteConfirm": "Type {email} to confirm",
  "settings.deleteButton": "Delete my account",
  // deleteMyAccount (src/lib/auth/actions.ts) words its errors in English; the form swaps each for these.
  "settings.errDeleteDemo": "The demo data can't be deleted.",
  "settings.errDeleteEmail": "Type your email exactly as shown to confirm.",
} as const;
