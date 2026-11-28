# B17: super admin — approve hosts, and see every host's customers

The owner asked for a Super admin that shows who registered and all their data, and approves or declines. The staff
area at /admin already had an overview, a host search, host details, staff and an audit log; this extends it.

## Approve, decline, suspend (super admins only)
- Each host has a review status: approved (every existing host), pending, declined or suspended.
- On a host's page: Approve or Decline (pending), Approve (declined), Suspend (approved), Reactivate (suspended). A
  move from the wrong status is refused (two staff clicking at once can't both apply it); so is a closed account,
  your own account, and anyone without the permission. Each move is in the audit log.
- Overview: how many hosts wait for approval (linking the Hosts list filtered to them), and a switch "Require my
  approval for new hosts", off by default. When on, a new sign-up starts pending. Switching it is logged.
- A host who isn't approved can sign in and set up; the dashboard says why their pages are hidden and who to write
  to (the grievance contact on the privacy page). Their public page, every page found by their slug (custom domain,
  packages, polls, memberships), single-use links, their practice listing and routing forms are hidden, and they
  take no new bookings or reschedules. Guests can still cancel. The host is emailed about each move, in their language
  (B22: `account_review_host`, one per move, skipped when sent if a later move has overtaken it or the account closed).
- Hosts list: a status filter and a status line on each host who isn't approved.

## Customer data (super admins only, every view logged)
- From a host's page: Clients (name, email, phone, bookings, first and last, the host's private client note),
  Bookings and answers (each booking's guest, extra guests, intake answers, payment, private booking note), and
  Payments and gateways (booking payments, packages, memberships; each gateway's provider, status, mode and its key id
  masked, like rzp_live_••••1234). The sealed gateway credentials are never read.
- Overview: new hosts per India day for 30 days, and how hosts sign in.
- Hosts list: "Download CSV" of every host, logged; cells that start with = + - @ can't run as spreadsheet formulas.

## Open for the owner
- The privacy policy says Hourhand is the hosts' data processor; staff reading guests' data needs a lawyer's look.
