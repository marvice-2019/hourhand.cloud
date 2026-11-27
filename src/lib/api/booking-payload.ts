// One shape for a booking that leaves Hourhand: a webhook's `data` and each booking in the read API (B14), so one n8n
// flow can read both. No answers, private notes, manage links or payment details.

/** Columns the payload needs, from `bookings b join event_types e on e.id = b.event_type_id join invitees i on i.booking_id = b.id`. */
export const BOOKING_PAYLOAD_COLUMNS = `b.id, b.host_id, b.start_at, b.end_at, b.status, b.location_kind, b.rescheduled_from_id, b.created_at,
  e.id as event_type_id, e.name as event_name, e.slug as event_slug, e.duration_minutes,
  i.name as guest_name, i.email as guest_email, i.phone as guest_phone, i.timezone as guest_timezone`;

export const BOOKING_PAYLOAD_FROM = "bookings b join event_types e on e.id = b.event_type_id join invitees i on i.booking_id = b.id";

export interface BookingPayload {
  booking: { id: string; status: string; start: string; end: string; location: string | null; rescheduled_from: string | null; created_at: string };
  event_type: { id: string; name: string; slug: string; duration_minutes: number };
  guest: { name: string; email: string | null; phone: string | null; timezone: string };
}

// A row of BOOKING_PAYLOAD_COLUMNS; pg hands back loosely typed rows.
type Row = Record<string, unknown>;

/** Guests who booked without an email get a placeholder ending in .invalid; that is sent as null. */
export function bookingPayload(r: Row): BookingPayload {
  const email = String(r.guest_email);
  return {
    booking: {
      id: String(r.id), status: String(r.status),
      start: new Date(r.start_at as Date).toISOString(), end: new Date(r.end_at as Date).toISOString(),
      location: (r.location_kind as string | null) ?? null, rescheduled_from: (r.rescheduled_from_id as string | null) ?? null,
      created_at: new Date(r.created_at as Date).toISOString(),
    },
    event_type: { id: String(r.event_type_id), name: String(r.event_name), slug: String(r.event_slug), duration_minutes: Number(r.duration_minutes) },
    guest: { name: String(r.guest_name), email: /\.invalid$/i.test(email) ? null : email, phone: (r.guest_phone as string | null) ?? null, timezone: String(r.guest_timezone) },
  };
}
