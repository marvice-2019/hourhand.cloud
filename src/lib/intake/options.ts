// What the editor offers under "Add questions from": the host's own templates, then the starter examples.
import { authEnabled } from "../auth/auth";
import { getPool } from "../data/pg-store";
import { STARTERS } from "./starters";
import { listTemplates } from "./templates";
import type { TemplateQuestion } from "./templates-shape";

export interface TemplateChoice { id: string; name: string; questions: TemplateQuestion[]; example?: boolean; starter?: boolean }

/** Whether templates can be saved here: they live in Postgres, which the memory demo doesn't have. */
export const templatesEnabled = (): boolean => authEnabled();

/** The host-language name of each starter; English when no translator is given. */
export const STARTER_NAME_KEYS = { therapy: "intake.starterTherapy", coaching: "intake.starterCoaching", tutoring: "intake.starterTutoring" } as const;
export const STARTER_SUMMARY_KEYS = { therapy: "intake.starterTherapySummary", coaching: "intake.starterCoachingSummary", tutoring: "intake.starterTutoringSummary" } as const;

export async function templateChoices(userId: string, t?: (key: (typeof STARTER_NAME_KEYS)[keyof typeof STARTER_NAME_KEYS]) => string): Promise<TemplateChoice[]> {
  const own = templatesEnabled() ? await listTemplates(getPool(process.env.DATABASE_URL as string), userId) : [];
  return [
    ...own.map((t) => ({ id: t.id, name: t.name, questions: t.questions, example: t.example })),
    ...STARTERS.map((s) => ({ id: `starter:${s.key}`, name: t ? t(STARTER_NAME_KEYS[s.key]) : s.name, questions: s.questions, starter: true })),
  ];
}
