// The errors deleteMyAccount (./actions.ts) gives, as code -> English. They live here because a "use server" file
// may only export async functions. DeleteAccountForm shows each in the host's language.
export const DELETE_ACCOUNT_MESSAGES = {
  demo: "The demo data can't be deleted.",
  email: "Type your email exactly as shown to confirm.",
} as const;
