import Link from "next/link";
import { ImportFlow } from "@/components/ImportFlow";
import { focusRing } from "@/components/ui/focus";
import { requireOwnAccount } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function ImportEventTypesPage() {
  await requireOwnAccount();
  return (
    <div className="max-w-3xl">
      <Link href="/dashboard/event-types" className={`rounded-sm text-sm text-text-muted hover:underline ${focusRing}`}>← Event types</Link>
      <h1 className="mt-3 font-display text-xl text-text">Import from Calendly or Cal.com</h1>
      <p className="mt-2 text-text-muted">
        Bring your existing booking links across in one go: names, lengths, descriptions, buffers and booking questions.
        They arrive switched off, so you can check each one before guests see it.
      </p>
      <ImportFlow />
      <p className="mt-8 text-sm text-text-muted">
        Google Calendar appointment schedules and Zoho Bookings can&apos;t be imported: Google has no public way to read them,
        and Zoho needs its own app approval. Create those event types by hand for now.
      </p>
    </div>
  );
}
