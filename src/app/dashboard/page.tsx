import { redirect } from "next/navigation";

/** /dashboard on its own opens the same place sign-in does. */
export default function DashboardHome() {
  redirect("/dashboard/event-types");
}
