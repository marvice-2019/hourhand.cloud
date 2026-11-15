import { VOICE_INCLUDED_MINUTES } from "../billing/plans";
import type { SettingsPatch } from "./store";

// The receptionist settings form on /dashboard/voice: checked here so the page and its tests share one set of rules.

export type VoiceForm = { ok: true; value: SettingsPatch } | { ok: false; errors: Record<string, string> };

const field = (form: FormData, k: string) => String(form.get(k) ?? "").trim();

export function validateVoiceForm(form: FormData): VoiceForm {
  const errors: Record<string, string> = {};
  const capRaw = field(form, "cap");
  const cap = Number(capRaw);
  if (!/^\d{1,5}$/.test(capRaw) || cap > VOICE_INCLUDED_MINUTES) errors.cap = `Enter 0 to ${VOICE_INCLUDED_MINUTES} minutes.`;
  const note = field(form, "publicNote");
  if (note.length > 1000) errors.publicNote = "Keep it under 1000 characters.";
  const agentId = field(form, "agentId");
  if (agentId && !/^[A-Za-z0-9_-]{1,100}$/.test(agentId)) errors.agentId = "That doesn't look like an ElevenLabs agent id.";
  const phone = field(form, "phoneNumber").replace(/[\s()-]/g, "");
  if (phone && !/^\+[1-9][0-9]{6,14}$/.test(phone)) errors.phoneNumber = "Enter the number with country code, like +91 80 4567 8900.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      enabled: form.get("enabled") === "on", recordingEnabled: form.get("recording") === "on", monthlyMinuteCap: cap,
      publicNote: note, agentId: agentId || null, phoneNumber: phone || null,
    },
  };
}
