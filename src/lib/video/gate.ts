import { LIMITS, type Plan } from "../billing/plans";

/** Whether a host can pick Hourhand video for an event type: ready, not set up on this server, or not on their plan. */
export type VideoAvailability = "ready" | "not_set_up" | "plan";

export function videoAvailability(plan: Plan, configured: boolean): VideoAvailability {
  if (!configured) return "not_set_up";
  return LIMITS[plan].hourhandVideo ? "ready" : "plan";
}

export const VIDEO_NOT_SET_UP = "Hourhand video is not set up on this server yet.";
export const VIDEO_NEEDS_PLAN = "Hourhand video needs the Solo or Duo plan.";

/**
 * Why an event type can't be switched to Hourhand video, checked on the server whatever the editor showed. Keeping it on
 * an event type that already has it is allowed, so a lapsed plan doesn't block other edits (joining is checked again then).
 */
export function videoGateError(input: { chosen: boolean; alreadyChosen: boolean; availability: VideoAvailability }): string | null {
  if (!input.chosen || input.alreadyChosen) return null;
  if (input.availability === "not_set_up") return VIDEO_NOT_SET_UP;
  if (input.availability === "plan") return VIDEO_NEEDS_PLAN;
  return null;
}
