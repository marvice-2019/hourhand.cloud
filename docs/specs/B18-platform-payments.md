# B18: Platform payments (commission split, or Hourhand collects)

## What it does

Until now every guest paid the host's own Razorpay or Stripe account, and Hourhand never touched the money. A super admin can
now choose, per host, how that host's guests pay:

| Mode | Who the guest pays | How the host gets their share |
| --- | --- | --- |
| `own` (default, every existing host) | The host's own Razorpay or Stripe | Directly, as before |
| `split` | Hourhand's Razorpay | Razorpay Route transfers the host's share to their linked account (`acc_…`) as soon as the payment is captured; Hourhand keeps the commission |
| `platform` | Hourhand's Razorpay | Hourhand owes the host their share; a super admin records each payout (amount and bank/UPI reference) against a running balance |

A Stripe host set to `split` pays the commission as Stripe Connect's application fee on their own account. `platform` doesn't
apply to Stripe hosts (their guests keep paying them directly). Memberships always go to the host's own account.

## Settings (super admins only, `manage_payments`)

- **Hourhand's Razorpay** (`/admin/payments`): key id and key secret. Checked with Razorpay before saving, sealed with
  `TOKEN_ENCRYPTION_KEY` (bound to the key id), never shown again: only `rzp_test_••••abcd` and test/live. Can't be replaced or
  removed while a payment Hourhand took is still being confirmed or refunded.
- **Default commission**: 0% to 50%, stored in `platform_settings` (`payments.commission_bps`).
- **Per host** (host page): mode, a commission override (empty = default) and the Route linked account id. `split` needs the
  Route account.
- Every change, every payout and every visit to `/admin/payments` goes in the audit log. Secrets never do; key ids are masked.

## How a payment flows

1. A guest books (or buys a package). `collectFor(hostId)` returns the host's own account in `own` mode, or Hourhand's account
   marked with the host's collection terms. If that account isn't set up (no Hourhand keys, or `split` without a Route
   account) payments are unavailable, so a guest never pays the wrong account.
2. The order is made on that account; in `split` mode with a Route `transfers` entry for the host's share (`on_hold: false`).
3. The payment row records `collected_via` (`host` or `platform`), `commission_minor` and `transfer_account`. Confirming,
   reconciling, fee lookups and refunds all use the account on the row (`authForPayment`), so a later mode change never sends
   them to the wrong account.
4. Refunds of a split payment ask Razorpay to reverse the Route transfer too (`reverse_all`).

## Owed to hosts (`platform` mode)

For each payment Hourhand took in full (not split): amount − refunded − commission, never below zero for one payment, plus
paid package purchases; less payouts recorded. A payout can't be larger than what's owed.

## Before using it with real money

- Turn on Razorpay Route for Hourhand's account and add each split host as a linked account.
- Taking guests' money in full and paying hosts later (`platform` mode) can need an RBI payment aggregator licence. Check with
  a CA before using it with live keys.
- Hourhand pays Razorpay's fee on payments it collects; GST invoices are still issued in the host's name.
- Not verified against Razorpay's live API: how `reverse_all` behaves on a partial refund of a split payment. Try it with test
  keys before going live.
