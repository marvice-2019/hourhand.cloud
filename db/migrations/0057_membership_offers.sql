-- Offers on memberships: a code or campaign takes money off the FIRST month only; renewals are at the plan's price.
-- Razorpay Subscriptions can't apply a one-month discount through the API (its offers are made in the dashboard), so a
-- discounted membership starts its subscription one month later and the client pays the discounted first month as the
-- subscription's one-time upfront amount when they approve the mandate. That payment buys month one's credits.

alter table offer_applications drop constraint offer_applications_item_kind_check;
alter table offer_applications add constraint offer_applications_item_kind_check check (item_kind in ('event_type', 'package', 'membership'));

-- Which membership plans a code or campaign covers. As with event types and packages, all lists empty means everything.
alter table offer_coupons add column membership_plan_ids uuid[] not null default '{}';
alter table offer_campaigns add column membership_plan_ids uuid[] not null default '{}';

-- Set only on a discounted membership: what the upfront first payment is, and when the first full-price charge falls.
alter table memberships add column first_charge_minor int check (first_charge_minor between 100 and 50000000);
alter table memberships add column first_period_end timestamptz;
alter table memberships add constraint memberships_first_charge_pair check ((first_charge_minor is null) = (first_period_end is null));
