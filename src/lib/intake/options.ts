// What the editor offers under "Add questions from": the host's own templates, then the starter examples.
import { authEnabled } from "../auth/auth";
import { getPool } from "../data/pg-store";
import { STARTERS } from "./starters";
import { listTemplates } from "./templates";
import type { TemplateQuestion } from "./templates-shape";

export interface TemplateChoice { id: string; name: string; questions: TemplateQuestion[]; example?: boolean; starter?: boolean }

/** Whether templates can be saved here: they live in Postgres, which the memory demo doesn't have. */
export const templatesEnabled = (): boolean => authEnabled();

export async function templateChoices(userId: string): Promise<TemplateChoice[]> {
  const own = templatesEnabled() ? await listTemplates(getPool(process.env.DATABASE_URL as string), userId) : [];
  return [
    ...own.map((t) => ({ id: t.id, name: t.name, questions: t.questions, example: t.example })),
    ...STARTERS.map((s) => ({ id: `starter:${s.key}`, name: `${s.name} (starter)`, questions: s.questions, starter: true })),
  ];
}
