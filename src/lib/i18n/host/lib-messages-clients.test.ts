// The consent log's labels (PURPOSE_LABELS, CHANNEL_LABELS) each have a host line with the same English.
import { describe, expect, it } from "vitest";
import { CHANNEL_LABELS, PURPOSE_LABELS, type ConsentChannel, type ConsentPurpose } from "../../privacy/consent";
import { HOST_CATALOGS, type HostKey } from "./index";

// Same maps as src/app/dashboard/clients/[key]/page.tsx.
const PURPOSE_KEYS: Record<ConsentPurpose, HostKey> = {
  booking: "clients.purposeBooking", whatsapp_updates: "clients.purposeWhatsapp", sms_updates: "clients.purposeSms", host_question: "clients.purposeHostQuestion",
};
const CHANNEL_KEYS: Record<ConsentChannel, HostKey> = {
  booking_page: "clients.channelBookingPage", single_use_link: "clients.channelSingleUseLink", package_link: "clients.channelPackageLink",
};

describe("consent log labels", () => {
  it("has a host line with the same English for every purpose", () => {
    for (const [code, label] of Object.entries(PURPOSE_LABELS)) expect(HOST_CATALOGS.en[PURPOSE_KEYS[code as ConsentPurpose]]).toBe(label);
  });

  it("has a host line with the same English for every channel", () => {
    for (const [code, label] of Object.entries(CHANNEL_LABELS)) expect(HOST_CATALOGS.en[CHANNEL_KEYS[code as ConsentChannel]]).toBe(label);
  });
});
