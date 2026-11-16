import { LIMITS, type Plan } from "../billing/plans";

/** Whether a host can pick Hourhand video for an event type: ready, not set up on this server, or not on their plan. */
export type VideoAvailability = "ready" | "not_set_up" | "plan";

export function videoAvailability(plan: Plan, configured: boolean): VideoAvailability {
  if (!configured) return "not_set_up";
  return LIMITS[plan].hourhandVideo ? "ready" : "plan";
}

/**
 * Why an event type can't be switched to Hourhand video, checked on the server whatever the editor showed: "not_set_up"
 * or "plan", which the caller words in the host's language. Keeping it on an event type that already has it is allowed,
 * so a lapsed plan doesn't block other edits (joining is checked again then). Null when it can be saved.
 */
export function videoGateError(input: { chosen: boolean; alreadyChosen: boolean; availability: VideoAvailability }): Exclude<VideoAvailability, "ready"> | null {
  if (!input.chosen || input.alreadyChosen || input.availability === "ready") return null;
  return input.availability;
}
