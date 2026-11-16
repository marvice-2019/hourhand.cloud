// deleteMyAccount's errors (DELETE_ACCOUNT_MESSAGES) each have a host line with the same English.
import { describe, expect, it } from "vitest";
import { DELETE_ACCOUNT_MESSAGES } from "../../auth/delete-account-messages";
import { HOST_CATALOGS, type HostKey } from "./index";
import { decode } from "./lib-messages";

// Same map as src/components/DeleteAccountForm.tsx.
const KEYS: Record<keyof typeof DELETE_ACCOUNT_MESSAGES, HostKey> = { demo: "settings.errDeleteDemo", email: "settings.errDeleteEmail" };

describe("delete account messages", () => {
  it("has a host line with the same English for every code", () => {
    for (const [code, template] of Object.entries(DELETE_ACCOUNT_MESSAGES)) expect(HOST_CATALOGS.en[KEYS[code as keyof typeof KEYS]]).toBe(template);
  });

  it("decodes the messages", () => {
    expect(decode(DELETE_ACCOUNT_MESSAGES, "Type your email exactly as shown to confirm.")).toEqual({ code: "email", vars: {} });
    expect(decode(DELETE_ACCOUNT_MESSAGES, "Something else.")).toBeNull();
  });
});
