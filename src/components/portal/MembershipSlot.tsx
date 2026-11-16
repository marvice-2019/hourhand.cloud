// ─── MEMBERSHIP SLOT ────────────────────────────────────────────────────────────────────────────────────────────────
// Memberships are being built separately. When they land, render the client's membership with this host here
// (plan, renewal date, sessions included). Until then this renders nothing, and the portal page already places it.
// Props are what the portal has in hand for the signed-in client: the host and the client's email (already isolated).
export function MembershipSlot(props: { hostId: string; email: string; locale: string }) {
  void props;
  return null;
}
