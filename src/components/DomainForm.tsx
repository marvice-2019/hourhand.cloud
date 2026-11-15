"use client";

import { useActionState } from "react";
import { saveDomain, type DomainFormState } from "@/app/dashboard/domain/actions";
import { Button } from "./ui/Button";
import { Input, Label } from "./ui/Input";

const idle: DomainFormState = { status: "idle" };

export function DomainForm({ current }: { current?: string }) {
  const [state, action, pending] = useActionState(saveDomain, idle);
  return (
    <form action={action} className="grid max-w-md gap-3">
      <div>
        <Label htmlFor="domain">{current ? "Change to another domain" : "Your domain"}</Label>
        <Input id="domain" name="domain" type="text" inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false} required
          placeholder="book.yourname.com" defaultValue="" error={state.status === "error" ? state.error : undefined} />
      </div>
      <div><Button type="submit" loading={pending}>{current ? "Use this domain instead" : "Add domain"}</Button></div>
    </form>
  );
}
