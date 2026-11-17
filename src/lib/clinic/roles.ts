// Who may do what in a practice. Every server action and every library function that reads or changes practice data
// checks here against the database, never against what the page showed: a hidden button is not a permission.

/** The owner holds the Clinic subscription. Admins run the practice. Practitioners run their own calendar. */
export type PracticeRole = "owner" | "admin" | "practitioner";

export type PracticeAction =
  /** Invite, remove, re-order, change roles, take a practitioner off the page. */
  | "members.manage"
  /** The practice-wide bookings list (no client notes, no intake answers). */
  | "bookings.view_all"
  /** The practice's GST invoices and their CSV export. */
  | "invoices.view"
  /** The practice's GST details (one invoice series for everyone). */
  | "invoices.settings"
  /** Start, change, pause or cancel the Clinic subscription; the practice's payment account. */
  | "billing.manage"
  /** The practice page's name, slug, about text and services. */
  | "practice.edit"
  /** See who else is in the practice. */
  | "practice.view";

const RULES: Record<PracticeAction, readonly PracticeRole[]> = {
  "members.manage": ["owner", "admin"],
  "bookings.view_all": ["owner", "admin"],
  "invoices.view": ["owner", "admin"],
  "invoices.settings": ["owner", "admin"],
  // The subscription and the payment account are the owner's own: their card, their Razorpay keys.
  "billing.manage": ["owner"],
  "practice.edit": ["owner", "admin"],
  "practice.view": ["owner", "admin", "practitioner"],
};

export function allowed(role: PracticeRole | null, action: PracticeAction): boolean {
  return role !== null && RULES[action].includes(role);
}

export class ClinicAccessError extends Error {
  constructor(readonly action: PracticeAction | "client_notes") {
    super(`clinic: not allowed (${action})`);
    this.name = "ClinicAccessError";
  }
}

/**
 * Client notes are the practitioner's alone. Nobody else in the practice reads them, admins and the owner included:
 * a therapist's notes are confidential to the therapist. (A Duo second person keeps the access Duo already gives.)
 */
export function mayReadClientNotes(actorId: string, hostId: string): boolean {
  return actorId === hostId;
}
