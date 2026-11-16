// Host dashboard words used on many pages. English is the source; see docs/i18n-host.md.
export const common = {
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.remove": "Remove",
  "common.edit": "Edit",
  "common.delete": "Delete",
  "common.optional": "{label} (optional)",
  "common.copyLink": "Copy link",
  "common.copied": "Copied",
  "common.copyFailed": "Couldn't copy",
  "common.minutes": "{n} min",
  "common.themeLegend": "Appearance",
  "common.themeDevice": "Device",
  "common.themeLight": "Light",
  "common.themeDark": "Dark",
  // For hosts paid through Stripe in another currency; rupee hosts keep the rupee wording.
  "common.errPriceOther": "Enter a price in {currency}, like 49 or 49.50 (at least {min}).",
} as const;
