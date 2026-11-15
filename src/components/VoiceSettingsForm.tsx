"use client";

import { useActionState } from "react";
import { saveVoice, type VoiceFormState } from "@/app/dashboard/voice/actions";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";
import { focusRing } from "./ui/focus";

const idle: VoiceFormState = { status: "idle" };

export interface VoiceFormValues { enabled: boolean; recording: boolean; cap: number; publicNote: string; agentId: string; phoneNumber: string; maxCap: number }

export function VoiceSettingsForm({ values }: { values: VoiceFormValues }) {
  const [state, action, pending] = useActionState(saveVoice, idle);
  const err = state.status === "error" ? state.errors : {};
  return (
    <form action={action} className="grid max-w-xl gap-4">
      {err.form && <p role="alert" className="text-danger">{err.form}</p>}
      <label className="flex items-start gap-3">
        <input type="checkbox" name="enabled" defaultChecked={values.enabled} className="mt-1 h-5 w-5" />
        <span><span className="font-semibold text-text">Answer my calls</span><span className="block text-sm text-text-muted">Off: callers to your receptionist number hear one line asking them to book online.</span></span>
      </label>
      <div>
        <Label htmlFor="cap">Monthly minute limit</Label>
        <Input id="cap" name="cap" type="number" min={0} max={values.maxCap} required defaultValue={values.cap} error={err.cap} />
        <p className="mt-1 text-sm text-text-muted">Up to {values.maxCap} minutes are included. At the limit the assistant stops taking calls until next month; you get an email at 80%.</p>
      </div>
      <label className="flex items-start gap-3">
        <input type="checkbox" name="recording" defaultChecked={values.recording} className="mt-1 h-5 w-5" />
        <span><span className="font-semibold text-text">Record calls</span><span className="block text-sm text-text-muted">Off by default. When on, every caller is told at the start that the call is recorded.</span></span>
      </label>
      <div>
        <Label htmlFor="publicNote">What the assistant may tell any caller</Label>
        <textarea id="publicNote" name="publicNote" rows={4} maxLength={1000} defaultValue={values.publicNote}
          placeholder="Address and landmark, parking, which floor, languages you speak."
          className={`mt-1 block w-full rounded-md border border-border-input bg-card px-3 py-2 text-base text-text ${focusRing}`} />
        {err.publicNote && <p className="mt-1 text-sm text-danger">{err.publicNote}</p>}
        <p className="mt-1 text-sm text-text-muted">Services, prices and your cancellation policy come from your event types. Don&apos;t put anything private here.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="phoneNumber">Receptionist number</Label>
          <Input id="phoneNumber" name="phoneNumber" type="tel" defaultValue={values.phoneNumber} placeholder="+91 80 4567 8900" error={err.phoneNumber} />
        </div>
        <div>
          <Label htmlFor="agentId">ElevenLabs agent id</Label>
          <Input id="agentId" name="agentId" type="text" autoComplete="off" spellCheck={false} defaultValue={values.agentId} error={err.agentId} />
        </div>
      </div>
      <div><Button type="submit" loading={pending}>Save</Button></div>
    </form>
  );
}
