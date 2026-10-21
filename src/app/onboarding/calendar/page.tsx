import { redirect } from "next/navigation";

// Sign-in goes straight to the dashboard, so this early onboarding step is unused; the calendars page there does the job behind sign-in.
export default function OnboardingCalendarPage() {
  redirect("/dashboard/calendars");
}
