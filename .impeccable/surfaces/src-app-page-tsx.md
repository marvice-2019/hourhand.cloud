---
version: 1
slug: "src-app-page-tsx"
primary_target: "src/app/page.tsx"
related_targets: []
---

# Surface: landing page (/)

Mode: Persuade. Audience: solo coaches, tutors and therapists, mostly evaluating on a phone. Action: Start free (sign-up). Proof available: the product itself (sync light, pause-on-failure, booking page); no customer proof exists, so none is shown.

User brief (2026-10-21): "make it like linear.app", resolved by the user to Linear's craft and structure on Hourhand's existing brand (saffron, warm paper and warm dark, Fraunces + Inter), not a Linear rebrand.

## Direction contract

seed: none (roll skipped: the user pinned the direction, "Linear's craft, Hourhand's brand")

FORM: Linear-style product marketing page. Product UI is the hero and the proof; sections alternate paper and ink; each showcase pairs a short claim with the real interface doing it; hairline rules over cards.

THESIS: The page is the product working, not a description of it. Refuses the category default of a hero blurb plus a grid of same-size icon cards.

OWN-WORLD: Warm paper ground (#fffdf8) with full-bleed warm-ink showcase bands (#120e0b). Saffron is the only action colour; marigold marks the pivot and focus moments. Fraunces display, tightly tracked; Inter for UI. Hairline 1px rules and product chrome rendered as real HTML UI, never screenshots or icon tiles.

STORY: Your link only offers time it can verify → watch it pause when a calendar breaks → guests get their own zone and language → you get paid and invoiced → a person answers → plain prices → close.

FIRST VIEWPORT: Short Fraunces headline left, one line of sub-copy, Start free plus "See a real booking page". Below it a wide ink band holds a live product frame: a calendars panel with three sync lights beside the guest's booking page.

SIGNATURE: "Break a calendar". One control disconnects Outlook in the frame; the light turns red and the booking page greys its times to "Bookings paused". Reconnect restores them. Reduced motion means an instant swap.

RISK: Ink bands and a client component on low-end Android. Keep it CSS-only with a tiny client island, no images and no WebGL.
