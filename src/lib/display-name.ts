/**
 * The name guests see for a host. Hosts who sign up with an email link have no name until they set one, which left
 * pages reading "QA call with " and a blank profile heading. Falls back to the email's local part (without any
 * +tag), which the booking-link slug already shows, so it reveals nothing new. Never the full email address.
 */
export function hostDisplayName(name: string | null | undefined, email: string): string {
  const own = name?.trim();
  if (own) return own;
  const local = (email.split("@")[0] ?? "").split("+")[0];
  const words = local.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return "Your host";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
