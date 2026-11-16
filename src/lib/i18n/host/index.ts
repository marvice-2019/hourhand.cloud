// Words in the host's own dashboard and in the emails Hourhand sends the host, separate from the guest catalogue
// (../guest.ts). English is the source of truth. Each page (namespace) has its own file in ./en, so features add
// strings without touching each other's files; keys carry the namespace: "bookings.title". See docs/i18n-host.md.
import { Fragment, createElement, type ReactNode } from "react";
import { availability } from "./en/availability";
import { bookings } from "./en/bookings";
import { calendars } from "./en/calendars";
import { clients } from "./en/clients";
import { common } from "./en/common";
import { domain } from "./en/domain";
import { earnings } from "./en/earnings";
import { eventTypes } from "./en/eventTypes";
import { feedback } from "./en/feedback";
import { getBooked } from "./en/getBooked";
import { integrations } from "./en/integrations";
import { invoices } from "./en/invoices";
import { links } from "./en/links";
import { mail } from "./en/mail";
import { memberships } from "./en/memberships";
import { nav } from "./en/nav";
import { offers } from "./en/offers";
import { packages } from "./en/packages";
import { plan } from "./en/plan";
import { polls } from "./en/polls";
import { profile } from "./en/profile";
import { seat } from "./en/seat";
import { settings } from "./en/settings";
import { voice } from "./en/voice";
import { hi } from "./hi";
import { ta } from "./ta";

const en = {
  ...common, ...nav, ...bookings, ...clients, ...profile, ...eventTypes, ...links, ...packages, ...earnings, ...invoices,
  ...availability, ...calendars, ...integrations, ...domain, ...plan, ...seat, ...settings, ...mail, ...polls, ...getBooked, ...memberships, ...feedback, ...offers, ...voice,
};

export type HostKey = keyof typeof en;
export type HostCatalog = Record<HostKey, string>;

/** The languages a host can run their dashboard in. */
export const HOST_LOCALES = ["en", "hi", "ta"] as const;
export type HostLocale = (typeof HOST_LOCALES)[number];

/** Each language in its own script, for the settings picker. */
export const HOST_LOCALE_NAMES: Record<HostLocale, string> = { en: "English", hi: "हिन्दी", ta: "தமிழ்" };

export const HOST_CATALOGS: Record<HostLocale, HostCatalog> = { en, hi, ta };

export const isHostLocale = (v: unknown): v is HostLocale => typeof v === "string" && (HOST_LOCALES as readonly string[]).includes(v);

/** A saved preference, or English when there is none or it isn't a dashboard language. */
export const hostLocaleOf = (user: { hostLocale?: string | null } | null | undefined): HostLocale =>
  isHostLocale(user?.hostLocale) ? user.hostLocale : "en";

export type Vars = Record<string, string | number>;

const fill = (line: string, vars: Vars) => line.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));

/** The line for `key` in `locale` (English if a line is missing), with each `{name}` replaced from `vars`. */
export function ht(locale: HostLocale, key: HostKey, vars: Vars = {}): string {
  return fill(HOST_CATALOGS[locale]?.[key] ?? en[key], vars);
}

/** Like ht, but placeholders can be elements (a link, a bold name). */
export function htNodes(locale: HostLocale, key: HostKey, nodes: Record<string, ReactNode>): ReactNode[] {
  return splitNodes(HOST_CATALOGS[locale]?.[key] ?? en[key], nodes);
}

export function splitNodes(line: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return line.split(/(\{\w+\})/).map((part, i) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    return createElement(Fragment, { key: i }, name && name in nodes ? nodes[name] : part);
  });
}
