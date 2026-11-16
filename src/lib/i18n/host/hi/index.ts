// The host dashboard in Hindi: every namespace file in this folder, merged. Draft: needs native-speaker review.
import type { HostCatalog } from "../index";
import { availability } from "./availability";
import { bookings } from "./bookings";
import { calendars } from "./calendars";
import { clients } from "./clients";
import { common } from "./common";
import { domain } from "./domain";
import { earnings } from "./earnings";
import { eventTypes } from "./eventTypes";
import { feedback } from "./feedback";
import { getBooked } from "./getBooked";
import { integrations } from "./integrations";
import { invoices } from "./invoices";
import { links } from "./links";
import { mail } from "./mail";
import { memberships } from "./memberships";
import { nav } from "./nav";
import { offers } from "./offers";
import { referrals } from "./referrals";
import { packages } from "./packages";
import { plan } from "./plan";
import { polls } from "./polls";
import { profile } from "./profile";
import { seat } from "./seat";
import { settings } from "./settings";

export const hi: HostCatalog = {
  ...availability, ...bookings, ...calendars, ...clients, ...common, ...domain, ...earnings, ...eventTypes, ...feedback, ...getBooked, ...integrations, ...invoices, ...links, ...mail, ...memberships, ...nav, ...offers, ...packages, ...plan, ...polls, ...profile, ...referrals, ...seat, ...settings,
};
