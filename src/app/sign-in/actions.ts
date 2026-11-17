"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAPIError } from "better-auth/api";
import { authEnabled, getAuth, googleEnabled, microsoftEnabled, phoneEnabled } from "@/lib/auth/auth";
import { formatPhone, normalizePhone, OTP_CHANNEL_HEADER, otpChannels, pickOtpChannel, type OtpChannel } from "@/lib/auth/phone";
import { clientIp, rateLimiter, SIGN_IN_LIMITS } from "@/lib/rate-limit";

export type SignInState = { status: "idle" | "sent" | "error"; email?: string; error?: string };

const TOO_MANY = "Too many sign-in links asked for. Wait ten minutes, then try again.";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function requestMagicLink(_prev: SignInState, form: FormData): Promise<SignInState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { status: "error", email, error: "Enter a valid email address." };
  if (!authEnabled()) return { status: "error", email, error: "Sign-in needs the database. Start the app with HOURHAND_DATA=postgres." };
  const requestHeaders = await headers();
  // Server actions call Better Auth directly, past its HTTP rate limiter, so the limits are applied here.
  if (!rateLimiter.take(`ip:${clientIp(requestHeaders)}`, SIGN_IN_LIMITS.perIp)) return { status: "error", email, error: TOO_MANY };
  try {
    await getAuth().api.signInMagicLink({ body: { email, callbackURL: "/dashboard/event-types", errorCallbackURL: "/sign-in?error=link" }, headers: requestHeaders });
  } catch (error) {
    if (isAPIError(error) && error.status === "TOO_MANY_REQUESTS") return { status: "error", email, error: TOO_MANY }; // the per-email limit
    console.error("magic link request failed", error instanceof Error ? error.message : error);
    return { status: "error", email, error: "We couldn't send the link just now. Try again in a minute." };
  }
  return { status: "sent", email };
}

export async function signInWithGoogle(): Promise<void> {
  if (!authEnabled() || !googleEnabled()) redirect("/sign-in");
  const result = await getAuth().api.signInSocial({ body: { provider: "google", callbackURL: "/dashboard/event-types" }, headers: await headers() });
  if (!result.url) redirect("/sign-in");
  redirect(result.url);
}

export async function signInWithMicrosoft(): Promise<void> {
  if (!authEnabled() || !microsoftEnabled()) redirect("/sign-in");
  const result = await getAuth().api.signInSocial({
    body: { provider: "microsoft", callbackURL: "/dashboard/event-types", errorCallbackURL: "/sign-in?error=microsoft" },
    headers: await headers(),
  });
  if (!result.url) redirect("/sign-in");
  redirect(result.url);
}

export type PhoneSignInState = { step: "phone" | "code"; phone?: string; display?: string; channel?: OtpChannel; error?: string };

const TOO_MANY_CODES = "Too many codes asked for. Wait ten minutes, then try again.";

export async function requestPhoneCode(_prev: PhoneSignInState, form: FormData): Promise<PhoneSignInState> {
  const raw = String(form.get("phone") ?? "").slice(0, 32);
  const phone = normalizePhone(raw);
  if (!phone) return { step: "phone", display: raw, error: "Enter an Indian mobile number, like 98765 43210." };
  if (!authEnabled() || !phoneEnabled()) return { step: "phone", display: raw, error: "Sign-in by phone isn't available right now. Use your email instead." };
  const requestHeaders = await headers();
  if (!rateLimiter.take(`ip-phone:${clientIp(requestHeaders)}`, SIGN_IN_LIMITS.perIp)) return { step: "phone", display: raw, error: TOO_MANY_CODES };
  const channel = pickOtpChannel(String(form.get("channel") ?? ""), otpChannels());
  if (!channel) return { step: "phone", display: raw, error: "Sign-in by phone isn't available right now. Use your email instead." };
  // Better Auth's endpoint takes only the number, so the chosen channel travels to sendOTP as a header.
  const withChannel = new Headers(requestHeaders);
  withChannel.set(OTP_CHANNEL_HEADER, channel);
  try {
    await getAuth().api.sendPhoneNumberOTP({ body: { phoneNumber: phone }, headers: withChannel });
  } catch (error) {
    if (isAPIError(error) && error.status === "TOO_MANY_REQUESTS") return { step: "phone", display: raw, error: TOO_MANY_CODES };
    console.error(`phone code request failed (${channel})`, error instanceof Error ? error.message : error);
    const where = channel === "whatsapp" ? "send the code on WhatsApp" : "text the code";
    return { step: "phone", display: raw, error: `We couldn't ${where} just now. Try again in a minute, or use your email.` };
  }
  return { step: "code", phone, display: formatPhone(phone), channel };
}

export async function verifyPhoneCode(prev: PhoneSignInState, form: FormData): Promise<PhoneSignInState> {
  // The number comes from the form, not from trust in prev: it is normalised again and must still be an Indian mobile.
  const phone = normalizePhone(String(form.get("phone") ?? ""));
  const code = String(form.get("code") ?? "").replace(/\s/g, "");
  if (!phone) return { step: "phone", error: "Enter your number again." };
  const back = { step: "code" as const, phone, display: formatPhone(phone) };
  if (!/^\d{6}$/.test(code)) return { ...back, error: "Enter the 6-digit code from the text." };
  if (!authEnabled() || !phoneEnabled()) return { step: "phone", error: "Sign-in by phone isn't available right now. Use your email instead." };
  try {
    await getAuth().api.verifyPhoneNumber({ body: { phoneNumber: phone, code }, headers: await headers() });
  } catch (error) {
    const message = isAPIError(error) ? String(error.body?.code ?? error.message) : "";
    if (/TOO_MANY_ATTEMPTS|OTP_EXPIRED|OTP_NOT_FOUND|too many attempts|otp expired|otp not found/i.test(message)) return { ...back, error: "That code has expired or had too many tries. Ask for a new one." };
    if (/INVALID_OTP|invalid otp/i.test(message)) return { ...back, error: "That code isn't right. Check the text and try again." };
    console.error("phone code check failed", error instanceof Error ? error.message : error);
    return { ...back, error: "We couldn't sign you in. If your account was closed, it can't be used again." };
  }
  redirect("/dashboard/event-types");
}
