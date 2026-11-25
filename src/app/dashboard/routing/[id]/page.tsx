import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteRoutingFormAction } from "../actions";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { RoutingFormEditor } from "@/components/RoutingFormEditor";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { authEnabled } from "@/lib/auth/auth";
import { requireOwnAccount } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { getHostI18n } from "@/lib/i18n/host/server";
import { routableEventTypes, routingFormForHost } from "@/lib/routing/routing";

export const dynamic = "force-dynamic";

export default async function RoutingFormPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ done?: string }> }) {
  const user = await requireOwnAccount();
  const { t } = await getHostI18n();
  const { id } = await params;
  const { done } = await searchParams;
  if (!authEnabled()) notFound();
  const pool = getPool(process.env.DATABASE_URL as string);
  const [form, eventTypes] = await Promise.all([routingFormForHost(pool, user.id, id), routableEventTypes(pool, user.id)]);
  if (!form) notFound();
  const path = `/f/${form.token}`;
  return (
    <div>
      <Link href="/dashboard/routing" className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline">{t("routing.title")}</Link>
      <h1 className="font-display text-xl text-text">{form.title}</h1>
      {done === "created" && <p role="status" className="mt-4 max-w-xl rounded-md bg-success-bg p-3 text-sm text-text">{t("routing.doneCreated")}</p>}
      {done === "saved" && <p role="status" className="mt-4 max-w-xl rounded-md bg-success-bg p-3 text-sm text-text">{t("routing.doneSaved")}</p>}

      <Card className="mt-6 grid max-w-xl gap-2">
        <p className="font-semibold text-text">{t("routing.link")}</p>
        <p className="break-all text-sm text-text-muted">{path}</p>
        <div><CopyLinkButton path={path} /></div>
      </Card>

      <div className="mt-6">
        <RoutingFormEditor
          form={{ id: form.id, title: form.title, question: form.question, active: form.active, options: form.options }}
          eventTypes={eventTypes.map((e) => ({ id: e.id, name: e.name }))}
        />
      </div>

      <form action={deleteRoutingFormAction} className="mt-8">
        <input type="hidden" name="id" value={form.id} />
        <Button type="submit" variant="danger">{t("routing.delete")}</Button>
      </form>
    </div>
  );
}
