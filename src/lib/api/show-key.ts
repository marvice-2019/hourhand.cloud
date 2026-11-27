// B14: a new key is shown once, right after it's made, and never after it's removed.
import type { ApiKeyFormState } from "@/app/dashboard/integrations/api-key-actions";

/** The key to show: only right after it's made, and only while it still exists (gone once Remove is pressed). */
export function keyToShow(state: ApiKeyFormState, keyIds: readonly string[]): string | null {
  return state.status === "made" && keyIds.includes(state.id) ? state.key : null;
}
