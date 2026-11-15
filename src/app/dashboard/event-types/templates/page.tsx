import Link from "next/link";
import { startFromExample } from "./actions";
import { Button, buttonClasses } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { templatesEnabled } from "@/lib/intake/options";
import { STARTERS } from "@/lib/intake/starters";
import { listTemplates } from "@/lib/intake/templates";

export const dynamic = "force-dynamic";

export default async function IntakeTemplatesPage() {
  const user = await requireHost();
  const enabled = templatesEnabled();
  const templates = enabled ? await listTemplates(getPool(process.env.DATABASE_URL as string), user.id) : [];

  return (
    <div>
      <Link href="/dashboard/event-types" className="inline-flex min-h-11 items-center font-semibold text-accent underline">Back to event types</Link>
      <h1 className="mt-2 font-display text-xl text-text">Intake templates</h1>
      <p className="mt-2 max-w-xl text-text-muted">
        A template is a set of booking-form questions you can use on several event types. Applying it copies the questions in;
        changing the template later changes nothing until you apply it again, and past bookings keep the questions as they were asked.
      </p>
      {!enabled && <p className="mt-4 max-w-xl rounded-md bg-surface p-3 text-sm text-text">Templates need the database, which this demo doesn&apos;t have. You can still add the starter examples from an event type&apos;s Booking form tab.</p>}

      {enabled && (
        <section aria-labelledby="tpl-mine" className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="tpl-mine" className="font-semibold text-text">Your templates</h2>
            <Link href="/dashboard/event-types/templates/new" className={buttonClasses({ variant: "secondary" })}>New template</Link>
          </div>
          {templates.length === 0 ? <p className="mt-2 text-text-muted">None yet. Start from an example below, or make your own.</p> : (
            <ul className="mt-3 grid gap-3">
              {templates.map((t) => (
                <li key={t.id}>
                  <Card className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold text-text">{t.name}{t.example && <span className="ml-2 rounded-sm bg-warning-bg px-2 py-0.5 text-xs font-normal">Example: edit before use</span>}</p>
                      <p className="text-sm text-text-muted">{t.questions.length} {t.questions.length === 1 ? "question" : "questions"}</p>
                    </div>
                    <Link href={`/dashboard/event-types/templates/${t.id}`} className="inline-flex min-h-11 items-center font-semibold text-accent underline">Edit or apply</Link>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="tpl-examples" className="mt-8">
        <h2 id="tpl-examples" className="font-semibold text-text">Start from an example</h2>
        <p className="mt-1 max-w-xl text-sm text-text-muted">Plain-English starting points. Read every question and change it to fit how you work before clients see it.</p>
        <ul className="mt-3 grid gap-3">
          {STARTERS.map((s) => (
            <li key={s.key}>
              <Card className="grid gap-2">
                <p className="font-semibold text-text">{s.name} <span className="ml-1 rounded-sm bg-warning-bg px-2 py-0.5 text-xs font-normal">Example</span></p>
                <p className="text-sm text-text-muted">{s.summary}</p>
                <ul className="list-disc pl-5 text-sm text-text">{s.questions.map((q) => <li key={q.label}>{q.label}</li>)}</ul>
                {enabled && (
                  <form action={startFromExample}>
                    <input type="hidden" name="starter" value={s.key} />
                    <Button type="submit" variant="secondary">Use as a template</Button>
                  </form>
                )}
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
