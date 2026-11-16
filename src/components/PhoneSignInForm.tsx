"use client";

import { useActionState, useState } from "react";
import { requestPhoneCode, verifyPhoneCode, type PhoneSignInState } from "@/app/sign-in/actions";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";

/** Two steps: the number, then the 6-digit code texted to it. "Use a different number" starts over with a fresh form. */
export function PhoneSignInForm() {
  const [round, setRound] = useState(0);
  return <PhoneSteps key={round} onRestart={() => setRound((n) => n + 1)} />;
}

function PhoneSteps({ onRestart }: { onRestart: () => void }) {
  const [sent, sendAction, sending] = useActionState(requestPhoneCode, { step: "phone" } as PhoneSignInState);

  if (sent.step !== "code" || !sent.phone) {
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
          <p className="mt-1 text-sm text-text-muted">Indian mobile numbers only. We text you a 6-digit code.</p>
        </div>
        <Button type="submit" variant="secondary" loading={sending}>
          Text me a sign-in code
        </Button>
      </form>
    );
  }
  return <CodeStep phone={sent.phone} display={sent.display ?? sent.phone} onRestart={onRestart} />;
}

function CodeStep({ phone, display, onRestart }: { phone: string; display: string; onRestart: () => void }) {
  const [state, verifyAction, verifying] = useActionState(verifyPhoneCode, { step: "code", phone, display } as PhoneSignInState);
  return (
    <form action={verifyAction} noValidate className="grid gap-4">
      <input type="hidden" name="phone" value={phone} />
      <div>
        <Label htmlFor="code">Code sent to {display}</Label>
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
      <button type="button" onClick={onRestart} className="text-sm text-text-muted underline">
        Use a different number or get a new code
      </button>
    </form>
  );
}
