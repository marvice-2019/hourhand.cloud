import { redirect } from "next/navigation";

// This step never had a form; the availability page sets hours, behind sign-in.
export default function OnboardingHoursPage() {
  redirect("/dashboard/availability");
}
