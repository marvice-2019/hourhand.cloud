import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Booking } from "../data/types";

// Each booking gets its own room on the Jitsi server; every seat of a group class shares the class's room. The room
// name is random (never the booking id), stored on first join, and only ever reaches people through a signed redirect.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** 26 characters of base32 (130 bits): lowercase letters and digits, which Jitsi keeps as-is in a room name. */
export function newRoomName(): string {
  const bytes = randomBytes(26);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 31];
  return out;
}

/** What a room belongs to: the class for a group-class seat, otherwise the booking itself. */
export function roomKey(booking: Pick<Booking, "id" | "classKey">): string {
  return booking.classKey ? `class:${booking.classKey}` : `booking:${booking.id}`;
}

export interface RoomStore {
  /** The room for this key, made on first call. Two calls at once get the same room. */
  roomFor(key: string, hostId: string): Promise<string>;
}

export function pgRoomStore(pool: pg.Pool): RoomStore {
  return {
    async roomFor(key, hostId) {
      await pool.query("insert into video_rooms (room_key, host_id, room) values ($1, $2, $3) on conflict (room_key) do nothing", [key, hostId, newRoomName()]);
      const { rows: [r] } = await pool.query("select room from video_rooms where room_key = $1", [key]);
      return r.room as string;
    },
  };
}

/** For the demo (memory) data and tests. */
export function memoryRoomStore(): RoomStore {
  const rooms = new Map<string, string>();
  return {
    async roomFor(key) {
      if (!rooms.has(key)) rooms.set(key, newRoomName());
      return rooms.get(key)!;
    },
  };
}
