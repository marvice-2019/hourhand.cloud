import type pg from "pg";
import { listInvoices, type Invoice } from "../gst/invoices";
import { requirePracticeRole } from "./practices";

// The practice's one GST invoice series. Invoices for every practitioner's sessions are issued by the practice owner's
// account (their GSTIN, their prefix, one running number per financial year), so they all sit under the owner.

type Db = Pick<pg.PoolClient, "query">;

/** The practice's invoices and credit notes, newest first. Owner or admin. */
export async function listPracticeInvoices(db: Db, actorId: string, range?: { from: Date; to: Date }): Promise<Invoice[]> {
  const ctx = await requirePracticeRole(db as Pick<pg.Pool, "query">, actorId, "invoices.view");
  return listInvoices(db, ctx.practice.ownerId, range);
}
