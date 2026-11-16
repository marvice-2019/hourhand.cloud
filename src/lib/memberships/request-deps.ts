import { authEnabled } from "../auth/auth";
import { hostPlan } from "../billing/account";
import { tokenKey } from "../crypto/seal";
import { getPool } from "../data/pg-store";
import { loadHostRazorpay } from "../payments/host-razorpay";
import type { MembershipDeps } from "./handlers";
import { razorpayMembershipProvider } from "./provider";

/** What the membership routes use, or null when this server can't take payments (no Postgres or no TOKEN_ENCRYPTION_KEY). */
export function requestMembershipDeps(): (MembershipDeps & { key: Buffer }) | null {
  if (!authEnabled()) return null;
  let key: Buffer;
  try {
    key = tokenKey();
  } catch {
    return null;
  }
  const pool = getPool(process.env.DATABASE_URL!);
  return {
    pool, key,
    authFor: (hostId) => loadHostRazorpay(pool, key, hostId),
    providerFor: (auth) => razorpayMembershipProvider(auth),
    planFor: (hostId) => hostPlan(pool, hostId),
  };
}
