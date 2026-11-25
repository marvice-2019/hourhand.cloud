-- Reviews on the host's public booking page (Topmate shows ratings and testimonials on a profile). Off by default on
-- both sides: a review is shown only when the guest ticked "show my review" on the feedback form (recorded here with
-- the words they saw), the host chose to show that review, and the host switched reviews on for their page. Erasing the
-- client (src/lib/privacy/rights.ts) clears the consent, so their review stops showing.
alter table booking_feedback
  add column public_consent_at timestamptz,                                   -- when the guest agreed to show it
  add column public_statement text check (length(public_statement) <= 500),  -- the words they agreed to, in their language
  add column public_name text check (length(public_name) <= 60),             -- "Meera I."; null = shown without a name
  add column host_shown boolean not null default false;
create index booking_feedback_public_idx on booking_feedback (host_id, created_at desc) where host_shown and public_consent_at is not null;

alter table profiles add column show_reviews boolean not null default false;
