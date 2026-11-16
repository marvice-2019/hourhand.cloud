# Booking buttons on Instagram and Google: what needs a partnership

Researched 15 November 2026 from Meta's and Google's own help and developer pages (links below, read that day).
This is the follow-up plan; nothing here is built yet. What hosts can do today without any partnership is on
**Dashboard → Instagram & Google** (`src/app/dashboard/get-booked/page.tsx`).

## Summary

| Surface | Self-serve today (no partnership) | Needs partnership | Realistic for Hourhand? |
|---|---|---|---|
| Instagram profile | Up to 5 links under the bio, titled e.g. "Book now"; Story link sticker | The native **Book now** action button | Not now: no public application route |
| Google Business Profile | Booking link added by the merchant under **Bookings** (verified profiles) | Provider links that Google adds for every matched merchant (Appointments Redirect) | Yes, once Hourhand has enough hosts with a physical address |
| Google in-Search booking ("Reserve with Google" end-to-end) | — | End-to-end booking inside Google | Not offered for appointments any more (dining only) |

## Instagram: the "Book now" action button

What Meta says (Instagram Help Center, "About action buttons for Instagram Business profiles",
https://help.instagram.com/122793804938499, and Meta Business Help Center copy
https://www.facebook.com/business/help/122793804938499):

- The buttons are **Book now**, **Reserve** and **Order food**; one per profile.
- "At this time there [are] a limited number of providers for these action buttons." The business "need[s] an
  existing account with a partner to select them."

"About action button partners on Instagram" (https://help.instagram.com/313280685976255) lists the Book now partners:
Acuity Scheduling, Appointments by Square, Appointy, Avec, BeautyDate, Booksy, Fresha, GenBook, GetSquire, Gettimely,
GlossGenius, Gopanache, MyTime, Salon Iris, Schedulicity, Schedulista, Setmore, Shore, StyleSeat, SumUp, Treatwell,
Vagaro. A custom URL can't be put on the button.

How to become one: **no public application exists.** Neither page links an application form, and no Meta developer
doc for the integration turned up. The list "will continue to expand" at Meta's choosing. The only path is a business
development contact at Meta (for example through a Meta Business Partner or Meta's partnerships team).

Self-serve route, used now: "Add a website to your Instagram profile" (https://help.instagram.com/362497417173378)
allows up to five links via Edit profile → Links. The page opens in Instagram's in-app browser;
`e2e/e2e-instagram.mjs` books end to end there with no popup.

**Next step:** none to build. If Hourhand reaches meaningful volume of Instagram-led bookings (booking analytics will
show this through `utm_source=instagram`), approach Meta for partner status with those numbers.

## Google Business Profile

### Self-serve booking link (used now)

"Manage your local business links" (https://support.google.com/business/answer/6218037): in Search select
**Booking**, or in Maps **Edit profile** and the transaction type, then **Add link**, paste the URL, **Save**. Up to 10
links per category; the merchant can set a preferred one.

"Business links policies & guidelines" (https://support.google.com/business/answer/13769188):
- "Your business must be verified before you can add a link."
- Links "must allow customers to complete the designated action", so the host's page with bookable services qualifies.
- No social media, messaging, app-store or link-shortener URLs; one link per domain; at most 20 per transaction type.
- Google's crawler must reach the page: no login wall or CAPTCHA, no 403/404. `robots.ts` allows `/{slug}`.

The same help page says provider links "can automatically appear on your Business Profile through third-party
partners". That is the partnership below.

### Partnership: Actions Center, Appointments Redirect

Google's Actions Center now offers **Redirect** (and Offers) for appointments. The end-to-end "Reserve with Google"
integration, where Google calls the provider's booking server, is listed only for dining
(https://developers.google.com/actions-center, integrations index, read 15 Nov 2026). No real-time availability feed
or booking API is needed for appointments any more.

Appointments Redirect overview (https://developers.google.com/actions-center/verticals/appointments/redirect/overview):
Google shows the provider's link on matched merchants in Search and Maps and sends users to "the appointment
provider's landing page to complete the booking". To start: review eligibility, then "complete this partner interest
form or work with your Google Business Development contact". Merchants on it can also turn on a Book button in Local
Services Ads.

Eligibility (Platform policies, https://developers.google.com/actions-center/verticals/appointments/redirect/policies/platform-policies;
Integration overview, https://developers.google.com/actions-center/verticals/appointments/redirect/integration-steps/overview,
last updated 2026-04-01):
- The merchant "must have a physical location with an address that Google can match to our Maps database".
  **Online-only coaches and home-based tutors without a listed address are out.**
- Supported categories include Education (tutor, dance school, education centre), Wellness (yoga studio, personal
  trainer, massage therapist), Beauty, Healthcare (doctor, dentist, physiotherapist), Professional services (lawyer,
  accountant, photography studio), Pet and others. India (IN) is a supported country.
- Merchant name must be the legal business name and the address must be where the service happens.

What Hourhand must build (Integration policies,
https://developers.google.com/actions-center/verticals/appointments/redirect/policies/integration-policies;
Feeds, https://developers.google.com/actions-center/verticals/appointments/redirect/integration-steps/feeds;
Conversion tracking, https://developers.google.com/actions-center/verticals/appointments/redirect/integration-steps/conversion-tracking):

1. **Merchant data.** Profile fields Hourhand doesn't collect yet: legal business name, street address, phone,
   category, and an opt-in per host (Google's help page requires an opt-out within 5 business days too).
2. **Three daily feeds** (Entity, Action, Services) as JSON, uploaded at least every 24 hours to Google's SFTP
   (`partnerupload.google.com:19321`): one entity per opted-in host, the action link `/{slug}` (service-level links
   `/{slug}/{event}`), and every bookable service with name, duration, price and description as shown on the page.
   A nightly job in `src/lib/jobs`.
3. **Landing page rules.** The first screen must show bookable services, with no login or payment wall before services
   are visible. `/{slug}` already meets this.
4. **Conversion tracking.** Read `rwg_token` from the landing URL, keep it for up to 30 days (cookie plus the booking
   row), and report it to Google's conversion endpoint when a booking completes. No guest personal data goes to
   Google. This sits next to the UTM attribution in booking analytics.
5. **Attribution.** Label bookings that came this way as "Google" in the host's dashboard (a policy requirement).
6. **Process.** Interest form → Partner Portal setup → feeds and conversion tracking in sandbox → sandbox review →
   production feeds → production review → launch. Merchant matching to Maps listings happens in the Partner Portal.

Effort estimate (ours, not Google's): about 6–8 developer days for data fields, opt-in, feeds job, SFTP upload and
`rwg_token` tracking, plus Google's review cycles, which run for weeks and aren't in our control.

**Next step:** count hosts with a physical, Maps-listed address in supported categories. If there are enough to
matter, submit the partner interest form linked from the overview page and build items 1–5 in that order.
