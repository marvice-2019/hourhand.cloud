"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireHost } from "@/lib/auth/session";
import { authEnabled } from "@/lib/auth/auth";
import { store, type QuestionDraft } from "@/lib/data";
import { getPool } from "@/lib/data/pg-store";
import type { CodedError, QuestionErrors } from "@/lib/event-types";
import type { HostKey } from "@/lib/i18n/host";
import { getHostI18n } from "@/lib/i18n/host/server";
import { TEMPLATE_MAX_QUESTIONS } from "@/lib/intake/templates-shape";
import { STARTER_NAME_KEYS } from "@/lib/intake/options";
import { applyTemplate, checkTemplate, createFromStarter, createTemplate, deleteTemplate, updateTemplate } from "@/lib/intake/templates";

export type TemplateSaveResult =
  | { ok: true; id: string }
  | { ok: false; nameError?: string; formError?: string; questionErrors: QuestionErrors };

/** Templates live in Postgres only; the memory demo has none. */
function db() {
  return authEnabled() ? getPool(process.env.DATABASE_URL as string) : null;
}

function refresh(id?: string) {
  revalidatePath("/dashboard/event-types/templates");
  if (id) revalidatePath(`/dashboard/event-types/templates/${id}`);
}

/** Creates the template when `id` is null, otherwise replaces its name and questions. Event types are untouched. */
export async function saveTemplate(id: string | null, name: string, questions: QuestionDraft[]): Promise<TemplateSaveResult> {
  const user = await requireHost();
  const { t } = await getHostI18n();
  const pool = db();
  if (!pool) return { ok: false, formError: t("intake.errNoDatabase"), questionErrors: [] };
  const checked = checkTemplate(name, questions);
  if (!checked.ok) {
    // The same messages as the event type editor, in the host's language.
    const say = (e: CodedError) => t(`eventTypes.err${e.code[0].toUpperCase()}${e.code.slice(1)}` as HostKey, e.vars);
    return {
      ok: false,
      nameError: checked.nameError ? t("intake.errName") : undefined,
      formError: checked.formError === "tooMany" ? t("intake.errTooMany", { max: TEMPLATE_MAX_QUESTIONS }) : checked.formError === "empty" ? t("intake.errEmpty") : undefined,
      questionErrors: checked.questionCodes.map((c) => Object.fromEntries(
        (["label", "choices", "condition", "range"] as const).filter((k) => c[k]).map((k) => [k, say(c[k]!)]))),
    };
  }
  const saved = id ? await updateTemplate(pool, user.id, id, checked.name, checked.questions) : await createTemplate(pool, user.id, checked.name, checked.questions);
  if (!saved) return { ok: false, formError: t("intake.errNotYours"), questionErrors: [] };
  refresh(saved.id);
  return { ok: true, id: saved.id };
}

/** Form action: copies a starter example into the host's templates and opens it. */
export async function startFromExample(formData: FormData): Promise<void> {
  const user = await requireHost();
  const pool = db();
  if (!pool) redirect("/dashboard/event-types/templates");
  const key = String(formData.get("starter") ?? "");
  const { t } = await getHostI18n();
  const nameKey = STARTER_NAME_KEYS[key as keyof typeof STARTER_NAME_KEYS];
  const made = await createFromStarter(pool, user.id, key, new Date(), nameKey ? t("intake.exampleOption", { name: t(nameKey) }) : undefined);
  if (!made) redirect("/dashboard/event-types/templates");
  refresh();
  redirect(`/dashboard/event-types/templates/${made.id}`);
}

export async function removeTemplate(id: string): Promise<{ ok: boolean }> {
  const user = await requireHost();
  const pool = db();
  if (!pool) return { ok: false };
  const ok = await deleteTemplate(pool, user.id, id);
  refresh();
  return { ok };
}

/** Copies the template's saved questions into each chosen event type (replacing copies made by an earlier apply). */
export async function applyTemplateTo(id: string, eventTypeIds: string[]): Promise<{ ok: true; applied: number; skipped: number } | { ok: false; error: string }> {
  const user = await requireHost();
  const { t } = await getHostI18n();
  const pool = db();
  if (!pool) return { ok: false, error: t("intake.errNoDatabase") };
  const ids = Array.isArray(eventTypeIds) ? eventTypeIds.filter((x): x is string => typeof x === "string").slice(0, 100) : [];
  if (ids.length === 0) return { ok: false, error: t("intake.errTickOne") };
  const result = await applyTemplate(pool, store, user.id, id, ids);
  if (!result) return { ok: false, error: t("intake.errNotYours") };
  revalidatePath("/dashboard/event-types");
  for (const e of result.applied) revalidatePath(`/dashboard/event-types/${e}`);
  revalidatePath(`/${user.slug}`, "layout");
  return { ok: true, applied: result.applied.length, skipped: result.skipped.length };
}
