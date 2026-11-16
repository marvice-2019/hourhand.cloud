import { TZDate } from "@date-fns/tz";
import type pg from "pg";
import { NotFoundError } from "../data/types";
import { parsePrice } from "../event-types";
import { couponUses, type Campaign } from "./offers";
import { fillTemplate } from "../i18n/host/lib-messages";
import { CODE_PATTERN, MAX_PERCENT, normaliseCode, type Discount, type SlidingScale } from "./pricing";

// The host's side of offers: forms checked here, and every query takes the signed-in host's id, so another host's
// coupon, campaign or event type is simply not found.

type Db = Pick<pg.Pool, "query">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type Errors = Record<string, string>;

/** Every message the offer forms show, as code -> English template (the dashboard shows the host's language). */
export const OFFER_FORM_MESSAGES = {
  percent: "Enter a whole percent from 1 to {max}.",
  fixed: "Enter the amount off in rupees, like 200 or 199.50.",
  kind: "Pick percent or a fixed amount.",
  maxUses: "Total uses: a whole number, at least 1, or leave it empty.",
  maxUsesPerEmail: "Uses per client: a whole number, at least 1, or leave it empty.",
  code: "Use 3 to 32 letters, digits, - or _, like DIWALI20.",
  expiresOn: "Pick today or a later date, or leave it empty.",
  rupees: "Enter rupees, like 500.",
  suggested: "The suggested amount has to sit between the lowest and highest.",
  note: "Keep the explanation under 500 characters.",
  name: "Give it a short name, up to 60 characters, like Diwali offer.",
  banner: "Write the banner guests see, up to 200 characters.",
  startsOn: "Pick the first day.",
  endsOn: "Pick the last day.",
  endsPassed: "The last day has already passed.",
  endsBeforeStart: "The last day can't be before the first.",
} as const;
const M = OFFER_FORM_MESSAGES;

/** "percent" with a whole 1 to 90, or "fixed" with rupees as typed. */
export function parseDiscount(kind: string, raw: string, errors: Errors): Discount | null {
  if (kind === "percent") {
    const n = /^\d{1,2}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!(n >= 1 && n <= MAX_PERCENT)) { errors.value = fillTemplate(M.percent, { max: MAX_PERCENT }); return null; }
    return { kind, value: n };
  }
  if (kind === "fixed") {
    const p = parsePrice(raw);
    if (p === null || p === "invalid") { errors.value = M.fixed; return null; }
    return { kind, value: p };
  }
  errors.kind = M.kind;
  return null;
}

const whole = (raw: string, field: "maxUses" | "maxUsesPerEmail", errors: Errors): number | null => {
  const t = raw.trim();
  if (!t) return null;
  if (!/^\d{1,6}$/.test(t) || Number(t) < 1) { errors[field] = M[field]; return null; }
  return Number(t);
};

const ids = (list: string[]) => [...new Set(list.filter((x) => UUID.test(x)))];

export interface CouponInput {
  code: string; discount: Discount; expiresOn: string | null; maxUses: number | null; maxUsesPerEmail: number | null; eventTypeIds: string[]; packageIds: string[];
  membershipPlanIds?: string[];
}

type ItemLists = { eventTypeIds: string[]; packageIds: string[]; membershipPlanIds?: string[] };
const itemLists = (form: ItemLists) => ({ eventTypeIds: ids(form.eventTypeIds), packageIds: ids(form.packageIds), membershipPlanIds: ids(form.membershipPlanIds ?? []) });

export function validateCouponForm(form: { code: string; kind: string; value: string; expiresOn: string; maxUses: string; maxUsesPerEmail: string } & ItemLists, today: string):
  { ok: true; value: CouponInput } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const code = normaliseCode(form.code);
  if (!CODE_PATTERN.test(code)) errors.code = M.code;
  const discount = parseDiscount(form.kind, form.value, errors);
  const expiresOn = form.expiresOn.trim() || null;
  if (expiresOn && (!DATE.test(expiresOn) || expiresOn < today)) errors.expiresOn = M.expiresOn;
  const maxUses = whole(form.maxUses, "maxUses", errors);
  const maxUsesPerEmail = whole(form.maxUsesPerEmail, "maxUsesPerEmail", errors);
  if (Object.keys(errors).length > 0 || !discount) return { ok: false, errors };
  return { ok: true, value: { code, discount, expiresOn, maxUses, maxUsesPerEmail, ...itemLists(form) } };
}

/** The first moment after `day` ends in the host's zone: a coupon "valid until 5 Nov" stops at midnight going into the 6th. */
export function endOfDay(day: string, timezone: string): Date {
  const [, y, m, d] = DATE.exec(day)!.map(Number);
  return new Date(new TZDate(y, m - 1, d + 1, 0, 0, 0, timezone).getTime());
}

/** Keeps only ids of the host's own priced event types, packages and membership plans, so an offer can't name somebody else's. */
async function ownItems(db: Db, hostId: string, input: ItemLists): Promise<{ eventTypeIds: string[]; packageIds: string[]; membershipPlanIds: string[] }> {
  const plans = input.membershipPlanIds ?? [];
  const { rows: [r] } = await db.query(
    `select coalesce((select array_agg(id) from event_types where user_id = $1 and id = any($2::uuid[]) and price_minor is not null), '{}') as e,
            coalesce((select array_agg(id) from packages where user_id = $1 and id = any($3::uuid[])), '{}') as p,
            coalesce((select array_agg(id) from membership_plans where user_id = $1 and id = any($4::uuid[])), '{}') as m`,
    [hostId, input.eventTypeIds, input.packageIds, plans]);
  if (r.e.length !== input.eventTypeIds.length || r.p.length !== input.packageIds.length || r.m.length !== plans.length) throw new NotFoundError("Event type or package");
  return { eventTypeIds: r.e, packageIds: r.p, membershipPlanIds: r.m };
}

export class DuplicateCodeError extends Error {
  constructor() { super("That code is already in use"); this.name = "DuplicateCodeError"; }
}

export async function createCoupon(db: Db, hostId: string, timezone: string, input: CouponInput): Promise<string> {
  if (!UUID.test(hostId)) throw new NotFoundError("Host");
  const items = await ownItems(db, hostId, input);
  try {
    const { rows: [r] } = await db.query(
      `insert into offer_coupons (user_id, code, discount_kind, discount_value, expires_at, max_uses, max_uses_per_email, event_type_ids, package_ids, membership_plan_ids)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [hostId, input.code, input.discount.kind, input.discount.value, input.expiresOn ? endOfDay(input.expiresOn, timezone) : null,
        input.maxUses, input.maxUsesPerEmail, items.eventTypeIds, items.packageIds, items.membershipPlanIds]);
    return r.id as string;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new DuplicateCodeError();
    throw error;
  }
}

export interface CouponSummary {
  id: string; code: string; discount: Discount; expiresAt: Date | null; maxUses: number | null; maxUsesPerEmail: number | null;
  eventTypeIds: string[]; packageIds: string[]; membershipPlanIds: string[]; active: boolean; used: number; reserved: number;
}

export async function listCoupons(db: Db, hostId: string, now: Date): Promise<CouponSummary[]> {
  if (!UUID.test(hostId)) return [];
  const { rows } = await db.query(
    `select id, code, discount_kind, discount_value, expires_at, max_uses, max_uses_per_email, event_type_ids, package_ids, membership_plan_ids, active
     from offer_coupons where user_id = $1 order by created_at desc`, [hostId]);
  return Promise.all(rows.map(async (r) => {
    const uses = await couponUses(db, r.id, now);
    return {
      id: r.id, code: r.code, discount: { kind: r.discount_kind, value: r.discount_value }, expiresAt: r.expires_at, maxUses: r.max_uses,
      maxUsesPerEmail: r.max_uses_per_email, eventTypeIds: r.event_type_ids, packageIds: r.package_ids,
      membershipPlanIds: r.membership_plan_ids, active: r.active, used: uses.used, reserved: uses.reserved,
    };
  }));
}

/** Coupons are switched off, never deleted, so the uses already recorded keep their code. */
export async function setCouponActive(db: Db, hostId: string, couponId: string, active: boolean): Promise<void> {
  if (!UUID.test(hostId) || !UUID.test(couponId)) throw new NotFoundError("Coupon");
  const { rowCount } = await db.query("update offer_coupons set active = $3 where id = $1 and user_id = $2", [couponId, hostId, active]);
  if (!rowCount) throw new NotFoundError("Coupon");
}

export async function getFirstSession(db: Db, hostId: string): Promise<(Discount & { active: boolean }) | null> {
  if (!UUID.test(hostId)) return null;
  const { rows: [r] } = await db.query("select discount_kind, discount_value, active from offer_first_session where user_id = $1", [hostId]);
  return r ? { kind: r.discount_kind, value: r.discount_value, active: r.active } : null;
}

export async function saveFirstSession(db: Db, hostId: string, discount: Discount, active: boolean): Promise<void> {
  if (!UUID.test(hostId)) throw new NotFoundError("Host");
  await db.query(
    `insert into offer_first_session (user_id, discount_kind, discount_value, active) values ($1, $2, $3, $4)
     on conflict (user_id) do update set discount_kind = $2, discount_value = $3, active = $4, updated_at = now()`,
    [hostId, discount.kind, discount.value, active]);
}

export function validateSlidingForm(form: { min: string; suggested: string; max: string; note: string }): { ok: true; value: SlidingScale } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const money = (raw: string, field: string) => {
    const p = parsePrice(raw);
    if (p === null || p === "invalid") { errors[field] = M.rupees; return 0; }
    return p;
  };
  const minMinor = money(form.min, "min"), suggestedMinor = money(form.suggested, "suggested"), maxMinor = money(form.max, "max");
  const note = form.note.trim();
  if (!errors.min && !errors.suggested && !errors.max && !(minMinor <= suggestedMinor && suggestedMinor <= maxMinor)) {
    errors.suggested = M.suggested;
  }
  if (note.length > 500) errors.note = M.note;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { minMinor, suggestedMinor, maxMinor, note: note || null } };
}

/** Only on one of the host's own priced event types. */
export async function saveSlidingScale(db: Db, hostId: string, eventTypeId: string, s: SlidingScale): Promise<void> {
  if (!UUID.test(hostId) || !UUID.test(eventTypeId)) throw new NotFoundError("Event type");
  const { rowCount } = await db.query(
    `insert into offer_sliding_scales (event_type_id, user_id, min_minor, suggested_minor, max_minor, note)
     select e.id, e.user_id, $3, $4, $5, $6 from event_types e where e.id = $1 and e.user_id = $2 and e.price_minor is not null
     on conflict (event_type_id) do update set min_minor = $3, suggested_minor = $4, max_minor = $5, note = $6`,
    [eventTypeId, hostId, s.minMinor, s.suggestedMinor, s.maxMinor, s.note]);
  if (!rowCount) throw new NotFoundError("Event type");
}

export async function removeSlidingScale(db: Db, hostId: string, eventTypeId: string): Promise<void> {
  if (!UUID.test(hostId) || !UUID.test(eventTypeId)) return;
  await db.query("delete from offer_sliding_scales where event_type_id = $1 and user_id = $2", [eventTypeId, hostId]);
}

export async function listSlidingScales(db: Db, hostId: string): Promise<Map<string, SlidingScale>> {
  if (!UUID.test(hostId)) return new Map();
  const { rows } = await db.query("select event_type_id, min_minor, suggested_minor, max_minor, note from offer_sliding_scales where user_id = $1", [hostId]);
  return new Map(rows.map((r) => [r.event_type_id as string, { minMinor: r.min_minor, suggestedMinor: r.suggested_minor, maxMinor: r.max_minor, note: r.note ?? null }]));
}

export interface CampaignInput {
  name: string; banner: string; discount: Discount; startsOn: string; endsOn: string; eventTypeIds: string[]; packageIds: string[]; membershipPlanIds?: string[];
}

export function validateCampaignForm(form: { name: string; banner: string; kind: string; value: string; startsOn: string; endsOn: string } & ItemLists, today: string):
  { ok: true; value: CampaignInput } | { ok: false; errors: Errors } {
  const errors: Errors = {};
  const name = form.name.trim(), banner = form.banner.trim(), startsOn = form.startsOn.trim(), endsOn = form.endsOn.trim();
  if (name.length < 1 || name.length > 60) errors.name = M.name;
  if (banner.length < 1 || banner.length > 200) errors.banner = M.banner;
  const discount = parseDiscount(form.kind, form.value, errors);
  if (!DATE.test(startsOn)) errors.startsOn = M.startsOn;
  if (!DATE.test(endsOn)) errors.endsOn = M.endsOn;
  else if (endsOn < today) errors.endsOn = M.endsPassed;
  else if (DATE.test(startsOn) && endsOn < startsOn) errors.endsOn = M.endsBeforeStart;
  if (Object.keys(errors).length > 0 || !discount) return { ok: false, errors };
  return { ok: true, value: { name, banner, discount, startsOn, endsOn, ...itemLists(form) } };
}

export async function createCampaign(db: Db, hostId: string, input: CampaignInput): Promise<string> {
  if (!UUID.test(hostId)) throw new NotFoundError("Host");
  const items = await ownItems(db, hostId, input);
  const { rows: [r] } = await db.query(
    `insert into offer_campaigns (user_id, name, banner, discount_kind, discount_value, starts_on, ends_on, event_type_ids, package_ids, membership_plan_ids)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
    [hostId, input.name, input.banner, input.discount.kind, input.discount.value, input.startsOn, input.endsOn, items.eventTypeIds, items.packageIds, items.membershipPlanIds]);
  return r.id as string;
}

export async function listCampaigns(db: Db, hostId: string): Promise<Campaign[]> {
  if (!UUID.test(hostId)) return [];
  const { rows } = await db.query(
    `select id, name, banner, discount_kind, discount_value, to_char(starts_on, 'YYYY-MM-DD') as starts_on, to_char(ends_on, 'YYYY-MM-DD') as ends_on,
       event_type_ids, package_ids, membership_plan_ids, active from offer_campaigns where user_id = $1 order by starts_on desc`, [hostId]);
  return rows.map((r) => ({
    id: r.id, name: r.name, banner: r.banner, discount: { kind: r.discount_kind, value: r.discount_value }, startsOn: r.starts_on, endsOn: r.ends_on,
    eventTypeIds: r.event_type_ids, packageIds: r.package_ids, membershipPlanIds: r.membership_plan_ids, active: r.active,
  }));
}

export async function setCampaignActive(db: Db, hostId: string, campaignId: string, active: boolean): Promise<void> {
  if (!UUID.test(hostId) || !UUID.test(campaignId)) throw new NotFoundError("Campaign");
  const { rowCount } = await db.query("update offer_campaigns set active = $3 where id = $1 and user_id = $2", [campaignId, hostId, active]);
  if (!rowCount) throw new NotFoundError("Campaign");
}
