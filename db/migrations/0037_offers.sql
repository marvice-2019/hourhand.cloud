-- Roadmap 3.3: offers on paid event types and packages. Coupon codes, a first-session discount, sliding-scale (pay what
-- you can) pricing and dated campaigns. Exactly one adjustment applies to a booking or purchase; the server works it out
-- when the order is made (src/lib/offers) and records it in offer_applications, keyed by the request's idempotency key so
-- it joins to the booking or purchase that request made. GST is charged on the price after the discount (CGST Act s.15(3)(a)).

-- A coupon. Restricted to the listed event types and packages; both lists empty means every paid one. Uses are counted
-- from offer_applications (a payment that went through, or a checkout still under way), never stored, so nothing drifts.
create table offer_coupons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_-]{3,32}$'),
  discount_kind text not null check (discount_kind in ('percent', 'fixed')),
  discount_value int not null check (discount_value > 0 and (discount_kind <> 'percent' or discount_value <= 90)),
  expires_at timestamptz,
  max_uses int check (max_uses > 0),
  max_uses_per_email int check (max_uses_per_email > 0),
  event_type_ids uuid[] not null default '{}',
  package_ids uuid[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, code)
);

-- The host's automatic discount for a client email that has never paid for a session with them.
create table offer_first_session (
  user_id uuid primary key references users(id) on delete cascade,
  discount_kind text not null check (discount_kind in ('percent', 'fixed')),
  discount_value int not null check (discount_value > 0 and (discount_kind <> 'percent' or discount_value <= 90)),
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Pay what you can, per priced event type: the client picks an amount between min and max (paise).
create table offer_sliding_scales (
  event_type_id uuid primary key references event_types(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  min_minor int not null,
  suggested_minor int not null,
  max_minor int not null,
  note text check (note is null or length(note) <= 500),
  check (100 <= min_minor and min_minor <= suggested_minor and suggested_minor <= max_minor and max_minor <= 10000000)
);

-- A dated offer shown as a banner on the host's booking pages, live from starts_on to ends_on (both inclusive, as
-- calendar dates in the host's time zone).
create table offer_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  banner text not null check (length(banner) between 1 and 200),
  discount_kind text not null check (discount_kind in ('percent', 'fixed')),
  discount_value int not null check (discount_value > 0 and (discount_kind <> 'percent' or discount_value <= 90)),
  starts_on date not null,
  ends_on date not null check (ends_on >= starts_on),
  event_type_ids uuid[] not null default '{}',
  package_ids uuid[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index offer_campaigns_host_idx on offer_campaigns (user_id, ends_on);

-- The one adjustment a booking or purchase got. Joined to it by (host_id, idempotency_key). A row whose booking or
-- purchase doesn't exist (yet) holds its coupon use only until reserved_until.
create table offer_applications (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references users(id) on delete cascade,
  idempotency_key text not null,
  item_kind text not null check (item_kind in ('event_type', 'package')),
  item_id uuid not null,
  kind text not null check (kind in ('coupon', 'first_session', 'campaign', 'sliding_scale')),
  coupon_id uuid references offer_coupons(id) on delete restrict,
  campaign_id uuid references offer_campaigns(id) on delete set null,
  email citext not null,
  label text not null,
  list_minor int not null check (list_minor > 0),
  discount_minor int not null check (discount_minor >= 0),
  charge_minor int not null check (charge_minor >= 100),
  reserved_until timestamptz not null,
  created_at timestamptz not null default now(),
  unique (host_id, idempotency_key),
  check (charge_minor = list_minor - discount_minor),
  check ((kind = 'coupon') = (coupon_id is not null))
);
create index offer_applications_coupon_idx on offer_applications (coupon_id) where coupon_id is not null;
create index offer_applications_email_idx on offer_applications (host_id, email);

-- An invoice for a discounted price shows the value before the discount and the discount itself (both excluding GST),
-- so taxable value = gross - discount, as CGST Rule 46 asks.
alter table invoices
  add column gross_minor int check (gross_minor is null or gross_minor > 0),
  add column discount_minor int check (discount_minor is null or discount_minor > 0),
  add column discount_label text,
  add constraint invoices_discount_adds_up check (
    (gross_minor is null) = (discount_minor is null) and (gross_minor is null) = (discount_label is null)
    and (gross_minor is null or gross_minor - discount_minor = taxable_minor));
