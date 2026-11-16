// The host's language on the server: read from the signed-in person's saved preference (users.host_locale), so the
// first HTML is already in their language and nothing flashes. Pages, layouts and server actions call getHostI18n().
import { cache } from "react";
import { getHostContext } from "../../auth/session";
import { hostLocaleOf } from "./index";
import { makeHostI18n, type HostI18n } from "./format";

/**
 * The dashboard speaks the language of whoever is signed in. A Duo second person managing an owner's account sees the
 * dashboard in their own language; emails about the account follow the owner's (see hostLocaleOf in the mail worker).
 */
export const getHostI18n = cache(async (): Promise<HostI18n> => {
  const ctx = await getHostContext();
  return makeHostI18n(hostLocaleOf(ctx?.actor));
});
