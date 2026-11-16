// Private notes (a client note, a session note on a booking) are sealed with AES-256-GCM before they are stored
// (src/lib/crypto/seal.ts, key TOKEN_ENCRYPTION_KEY). The additional data binds each sealed note to its row, so a
// note copied into another client's or booking's row fails to open. They are decrypted only for the account owner:
// never for a Duo second person, never in emails, logs or analytics.

/** The longest note a host can save, client or session. */
export const MAX_NOTE = 5000;

export const clientNoteAad = (hostId: string, email: string) => `client_note:${hostId}:${email.trim().toLowerCase()}`;
export const bookingNoteAad = (bookingId: string) => `booking_note:${bookingId}`;
