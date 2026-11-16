// validateProfile's errors (PROFILE_MESSAGES) each have a host line with the same English.
import { describe, expect, it } from "vitest";
import { PROFILE_MESSAGES, validateProfile } from "../../profile";
import { HOST_CATALOGS, type HostKey } from "./index";
import { decode } from "./lib-messages";

// Same map as src/app/dashboard/profile/actions.ts.
const KEYS: Record<keyof typeof PROFILE_MESSAGES, HostKey> = {
  headline: "profile.errHeadline",
  bio: "profile.errBio",
  area: "profile.errArea",
  whatsapp: "profile.errWhatsapp",
  instagram: "profile.errInstagram",
  reviewsUrl: "profile.errReviewsUrl",
};

describe("profile messages", () => {
  it("has a host line with the same English for every code", () => {
    for (const [code, template] of Object.entries(PROFILE_MESSAGES)) expect(HOST_CATALOGS.en[KEYS[code as keyof typeof KEYS]]).toBe(template);
  });

  it("decodes real messages", () => {
    const v = validateProfile({ headline: "x".repeat(121), whatsapp: "12", instagram: "not valid!" });
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(decode(PROFILE_MESSAGES, v.errors.headline)).toEqual({ code: "headline", vars: {} });
    expect(decode(PROFILE_MESSAGES, v.errors.whatsapp)).toEqual({ code: "whatsapp", vars: {} });
    expect(decode(PROFILE_MESSAGES, v.errors.instagram)).toEqual({ code: "instagram", vars: {} });
  });
});
