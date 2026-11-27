import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { focusRing } from "@/components/ui/focus";
import { Input, Label } from "@/components/ui/Input";
import { audit } from "@/lib/admin/roles";
import { requireStaff } from "@/lib/admin/session";
import { formatMoney } from "@/lib/billing/plans";
import { getPool } from "@/lib/data/pg-store";
import { formatDate } from "@/lib/format";
import { defaultCommissionBps, hostBalances, MAX_COMMISSION_BPS, platformRazorpayStatus } from "@/lib/payments/platform";
import { recordPayoutAction, removeGatewayAction, saveGatewayAction, setCommissionAction } from "./actions";

export const dynamic = "force-dynamic";

// Super admins only (B18): Hourhand's own Razorpay, the default commission, and what Hourhand owes hosts whose guests
// paid Hourhand in full. The key secret is write-only: once saved, only the masked key id is ever shown.

const RESULTS: Record<string, [string, boolean]> = {
  gateway_saved: ["Saved. Razorpay accepted the key pair.", true],
  gateway_removed: ["Hourhand's Razorpay keys are removed. Hosts set to split or Hourhand collects can't take payments until new keys are saved.", true],
  commission_saved: ["Default commission saved. It applies to new payments.", true],
  payout_recorded: ["Payout recorded.", true],
  format: ["Check the details you entered and try again.", false],
  rejected: ["Razorpay didn't accept this key pair. Copy both again from Razorpay's dashboard, under Account & Settings, API keys.", false],
  unreachable: ["Couldn't reach Razorpay to check the keys. Try again in a minute.", false],
  busy: ["A guest's payment to Hourhand is still being confirmed or refunded. Try again once it has settled.", false],
  bad_commission: [`Enter a commission from 0% to ${MAX_COMMISSION_BPS / 100}%.`, false],
  bad_amount: ["Enter an amount no larger than what Hourhand owes this host.", false],
  not_allowed: ["Only a super admin can change payments.", false],
};

export default async function AdminPaymentsPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const staff = await requireStaff("manage_payments");
  const { result } = await searchParams;
  const db = getPool(process.env.DATABASE_URL as string);
  const [gateway, commission, balances] = await Promise.all([platformRazorpayStatus(db), defaultCommissionBps(db), hostBalances(db)]);
  await audit(db, staff, "payments.view", null, null);
  const message = result ? RESULTS[result] : undefined;
  const tz = "Asia/Kolkata";
  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-xl text-text">Payments</h1>
      <p className="mt-1 text-text-muted">
        By default every host&apos;s guests pay the host&apos;s own Razorpay or Stripe. On a host&apos;s page you can instead have guests pay
        Hourhand&apos;s Razorpay, either split at once with the host through Razorpay Route, or collected in full and paid out by you.
      </p>
      {message && <p role={message[1] ? "status" : "alert"} className={`mt-4 text-sm ${message[1] ? "text-success" : "text-danger"}`}>{message[0]}</p>}

      <div className="mt-6 grid gap-4">
        <Card>
          <h2 className="mb-3 font-semibold text-text">Hourhand&apos;s Razorpay</h2>
          {gateway ? (
            <p className="text-text">
              Connected: <span className="font-mono">{gateway.key}</span> · {gateway.mode === "test" ? "Test mode (no real money)" : "Live mode"} · updated {formatDate(gateway.updatedAt, tz)}
            </p>
          ) : <p className="text-text-muted">Not connected. Hosts set to split or Hourhand collects can&apos;t take payments until it is.</p>}
          <form action={saveGatewayAction} className="mt-4 grid gap-3" autoComplete="off">
            <div><Label htmlFor="keyId">Key id</Label><Input id="keyId" name="keyId" placeholder="rzp_test_…" required spellCheck={false} /></div>
            <div><Label htmlFor="keySecret">Key secret</Label><Input id="keySecret" name="keySecret" type="password" required autoComplete="new-password" /></div>
            <p className="text-sm text-text-muted">Checked with Razorpay before it&apos;s saved, then stored encrypted. Nobody can read the secret back, here or anywhere. Use test keys until you are ready to take real money.</p>
            <div className="flex flex-wrap gap-2"><Button type="submit" size="sm">{gateway ? "Replace keys" : "Save keys"}</Button></div>
          </form>
          {gateway && (
            <form action={removeGatewayAction} className="mt-3"><Button type="submit" size="sm" variant="secondary">Remove keys</Button></form>
          )}
          <p className="mt-4 text-sm text-text-muted">
            Splitting needs Razorpay Route turned on for this account, and each host added there as a linked account. Taking guests&apos; money
            in full and paying hosts later can need an RBI payment aggregator licence: check with your CA before using it with live keys.
          </p>
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold text-text">Default commission</h2>
          <form action={setCommissionAction} className="flex flex-wrap items-end gap-2">
            <div><Label htmlFor="commission">Hourhand&apos;s share of each payment (%)</Label><Input id="commission" name="commission" inputMode="decimal" defaultValue={String(commission / 100)} className="w-32" /></div>
            <Button type="submit" size="sm">Save</Button>
          </form>
          <p className="mt-3 text-sm text-text-muted">Applies to hosts set to split or Hourhand collects, and to Stripe hosts set to split, unless their page sets their own. New payments only.</p>
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold text-text">Owed to hosts</h2>
          {balances.length === 0 ? <p className="text-text-muted">Nothing yet. Only payments Hourhand collected in full show here.</p> : (
            <ul className="grid gap-4">
              {balances.map((b) => (
                <li key={`${b.hostId}-${b.currency}`} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
                  <p className="text-text">
                    <Link href={`/admin/hosts/${b.hostId}`} className={`font-semibold text-accent underline ${focusRing}`}>{b.name || b.email}</Link>
                    {" "}owed <strong>{formatMoney(b.owedMinor, b.currency)}</strong>
                  </p>
                  <p className="text-sm text-text-muted">
                    Collected {formatMoney(b.collectedMinor, b.currency)} · refunded {formatMoney(b.refundedMinor, b.currency)} · Hourhand&apos;s commission {formatMoney(b.commissionMinor, b.currency)} · paid out {formatMoney(b.paidOutMinor, b.currency)}
                  </p>
                  {b.owedMinor > 0 && (
                    <form action={recordPayoutAction} className="mt-2 flex flex-wrap items-end gap-2">
                      <input type="hidden" name="hostId" value={b.hostId} />
                      <div><Label htmlFor={`amount-${b.hostId}`}>Paid (₹)</Label><Input id={`amount-${b.hostId}`} name="amount" inputMode="decimal" required className="w-32" /></div>
                      <div><Label htmlFor={`ref-${b.hostId}`}>Bank or UPI reference</Label><Input id={`ref-${b.hostId}`} name="reference" required maxLength={200} /></div>
                      <Button type="submit" size="sm">Record payout</Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <p className="mt-6 text-sm text-text-muted">Every change here, and your visit to this page, is in the audit log.</p>
    </div>
  );
}
