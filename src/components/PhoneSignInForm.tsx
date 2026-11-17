"use client";

import { useActionState, useState } from "react";
import { requestPhoneCode, verifyPhoneCode, type PhoneSignInState } from "@/app/sign-in/actions";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import type { OtpChannel } from "@/lib/auth/phone";

const SEND_LABEL: Record<OtpChannel, string> = { whatsapp: "Send code on WhatsApp", sms: "Text me a sign-in code" };
const OTHER_LABEL: Record<OtpChannel, string> = { whatsapp: "Send it on WhatsApp instead", sms: "Text it to me instead" };

/**
 * Two steps: the number, then the 6-digit code. `channels` are the ones set up on the server, the default first.
 * "Use a different number" starts over with a fresh form.
 */
export function PhoneSignInForm({ channels }: { channels: OtpChannel[] }) {
  const [round, setRound] = useState(0);
  return <PhoneSteps key={round} channels={channels} onRestart={() => setRound((n) => n + 1)} />;
}

function PhoneSteps({ channels, onRestart }: { channels: OtpChannel[]; onRestart: () => void }) {
  const [sent, sendAction, sending] = useActionState(requestPhoneCode, { step: "phone" } as PhoneSignInState);
  const [first, second] = channels;

  if (sent.step !== "code" || !sent.phone || !sent.channel) {
    return (
      <form action={sendAction} noValidate className="grid gap-4">
        <div>
          <Label htmlFor="phone">Mobile number</Label>
          <Input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            inputMode="tel"
            placeholder="98765 43210"
            required
            defaultValue={sent.display}
            error={sent.error}
          />
          <p className="mt-1 text-sm text-text-muted">Indian mobile numbers only. We send you a 6-digit code.</p>
        </div>
        <Button type="submit" name="channel" value={first} variant="secondary" loading={sending}>
          {SEND_LABEL[first]}
        </Button>
        {second && (
          <button type="submit" name="channel" value={second} disabled={sending} className="text-sm text-text-muted underline">
            {OTHER_LABEL[second]}
          </button>
        )}
      </form>
    );
  }

  const other = channels.find((c) => c !== sent.channel);
  return (
    <div className="grid gap-3">
      {/* Keyed by channel: switching channel sends a new code, so the code field starts empty again. */}
      <CodeStep key={sent.channel} phone={sent.phone} display={sent.display ?? sent.phone} channel={sent.channel} />
      {other && (
        <form action={sendAction}>
          <input type="hidden" name="phone" value={sent.phone} />
          <button type="submit" name="channel" value={other} disabled={sending} className="text-sm text-text-muted underline">
            Didn&apos;t get it? {OTHER_LABEL[other]}
          </button>
        </form>
      )}
      <button type="button" onClick={onRestart} className="justify-self-start text-sm text-text-muted underline">
        Use a different number
      </button>
    </div>
  );
}

function CodeStep({ phone, display, channel }: { phone: string; display: string; channel: OtpChannel }) {
  const [state, verifyAction, verifying] = useActionState(verifyPhoneCode, { step: "code", phone, display } as PhoneSignInState);
  return (
    <form action={verifyAction} noValidate className="grid gap-4">
      <input type="hidden" name="phone" value={phone} />
      <div>
        <Label htmlFor="code">{channel === "whatsapp" ? `Code sent on WhatsApp to ${display}` : `Code texted to ${display}`}</Label>
        <Input
          id="code"
          name="code"
          type="text"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          required
          autoFocus
          error={state.error}
        />
        <p className="mt-1 text-sm text-text-muted">It expires in 5 minutes.</p>
      </div>
      <Button type="submit" loading={verifying}>
        Sign in
      </Button>
    </form>
  );
}
