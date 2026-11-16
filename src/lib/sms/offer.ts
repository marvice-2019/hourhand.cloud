import { authEnabled } from "../auth/auth";
import { hostPlan } from "../billing/account";
import { LIMITS } from "../billing/plans";
import { getPool } from "../data/pg-store";
import { smsConfig } from "./config";

/** Whether the booking form offers text updates for this host: SMS set up here, and the host's plan includes texts. */
export async function smsOffered(hostId: string): Promise<boolean> {
  if (!smsConfig() || !authEnabled() || !process.env.DATABASE_URL) return false;
  return LIMITS[await hostPlan(getPool(process.env.DATABASE_URL), hostId)].smsPerMonth > 0;
}
