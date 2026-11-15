import Link from "next/link";
import { notFound } from "next/navigation";
import { TemplateEditor } from "@/components/intake/TemplateEditor";
import { requireHost } from "@/lib/auth/session";
import { store } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import { templatesEnabled } from "@/lib/intake/options";
import { getTemplate } from "@/lib/intake/templates";

export const dynamic = "force-dynamic";

/** `new` makes a template; anything else is the host's own template id. */
export default async function IntakeTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireHost();
  if (!templatesEnabled()) notFound();
  const template = id === "new" ? null : await getTemplate(getPool(process.env.DATABASE_URL as string), user.id, id);
  if (id !== "new" && !template) notFound();
  const eventTypes = (await store.listEventTypes(user.id)).filter((e) => e.kind !== "one_off").sort((a, b) => a.position - b.position).map(({ id: eid, name }) => ({ id: eid, name }));

  return (
    <div>
      <Link href="/dashboard/event-types/templates" className="inline-flex min-h-11 items-center font-semibold text-accent underline">Back to templates</Link>
      <h1 className="mt-2 font-display text-xl text-text">{template ? template.name : "New template"}</h1>
      {template?.example && (
        <p className="mt-2 max-w-xl rounded-md bg-warning-bg p-3 text-sm text-text">
          This is an example. Read each question and change the wording to fit how you work, then save it.
        </p>
      )}
      <TemplateEditor
        key={template?.id ?? "new"}
        id={template?.id ?? null}
        initialName={template?.name ?? ""}
        initialQuestions={template?.questions ?? []}
        eventTypes={eventTypes}
      />
    </div>
  );
}
