# Host dashboard strings (i18n)

The host dashboard and the emails Hourhand sends hosts read from their own message catalogue, separate from the
guest booking pages (`src/lib/i18n/guest.ts`, `src/lib/i18n/mail.ts`). A host picks the dashboard language in
Settings; it is saved in `users.host_locale` (`en`, `hi`, `ta`; default `en`). `users.locale` is a different thing:
the language guests see first on the host's booking pages.

English is the source of truth. Hindi and Tamil follow the English keys.

**Hindi (`hi/`) and Tamil (`ta/`) are drafts that need native-speaker review.** They were written for a working
coach or tutor: plain everyday wording, common English loanwords where Indians use them in apps (बुकिंग, सेशन,
புக்கிங், லிங்க்), product and brand names in Latin script. When a reviewer changes a line, keep its `{placeholders}`.

## Where strings live

`src/lib/i18n/host/en/<namespace>.ts`, one file per dashboard area (`bookings`, `eventTypes`, `plan`, `mail`, ...).
Keys carry the namespace: `"bookings.title"`. Translations sit in `src/lib/i18n/host/hi/` and `.../ta/` with the same
file names. `src/lib/i18n/host/index.ts` merges the files.

## Adding strings for a new page

1. Make `src/lib/i18n/host/en/<yourPage>.ts`:

   ```ts
   export const yourPage = {
     "yourPage.title": "Reminders",
     "yourPage.sent": "Sent to {name} at {time}.",
   } as const;
   ```

   Then add it to the spread in `src/lib/i18n/host/index.ts` (one import, one spread).

2. In a server component, page, layout or server action:

   ```ts
   import { getHostI18n } from "@/lib/i18n/host/server";
   const { t, tNodes, date, time, inr, number } = await getHostI18n();
   <h1>{t("yourPage.title")}</h1>
   ```

   In a client component (anything under the dashboard layout):

   ```ts
   import { useHostI18n } from "@/components/HostI18nProvider";
   const { t } = useHostI18n();
   ```

3. Rules that keep translation possible:
   - One whole sentence per key. Never glue fragments (`"Made " + date`); use placeholders: `"Made {date}"`.
   - Placeholders are `{name}`. For a link or bold word inside a sentence use `tNodes("key", { name: <b>{x}</b> })`.
   - Singular and plural are separate keys (`"x.oneSession"`, `"x.sessions"`), chosen in code.
   - Dates, times, numbers and rupees go through `date`, `shortDate`, `month`, `time`, `number`, `inr` from the same
     object, never `toLocaleString` or a hard-coded `"en-IN"`.
   - Brand and product names stay as written (Hourhand, Google Calendar, WhatsApp, Razorpay, GST, UPI).
   - Server action error messages are host-visible too: build them with `t(...)` inside the action.

4. Hindi and Tamil: add the same keys to `hi/<yourPage>.ts` and `ta/<yourPage>.ts` (typed
   `Record<keyof typeof en, string>`, so the compiler lists what is missing) and add the file to `hi/index.ts` and
   `ta/index.ts`. Mark new lines for native-speaker review in your PR. If you can't translate yet, copy the English:
   the parity test passes and a translator can find the English lines later. Never leave a key out.

## The test that checks this

`src/lib/i18n/host/scan.test.ts` reads every file under `src/app/dashboard` and every component those files import,
and fails on any word typed into the code (JSX text, `aria-label`, `placeholder`, `label:` in option lists, error
messages returned from actions). Run it with:

```sh
npx vitest run src/lib/i18n/host
```

If a page must ship before its strings are extracted, add its path to `PENDING` in `scan.test.ts` with a reason and
extract them in a follow-up. For a single string that really is not copy (a code, a sample value), put
`// i18n-ignore` on the line or the line above.

Host emails (new booking, cancellation, moved, running late, calendar alerts, renewal, earnings, package sold) take
the host's language from `users.host_locale` in the mail worker; their lines are in `en/mail.ts`.

CSV exports (`earnings/export`, `invoices/export`) keep English column headers on purpose, so spreadsheets and
accounting imports keep working.
