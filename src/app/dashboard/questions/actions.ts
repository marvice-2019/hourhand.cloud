"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { authEnabled } from "@/lib/auth/auth";
import { requireHost } from "@/lib/auth/session";
import { getPool } from "@/lib/data/pg-store";
import { isNamedError } from "@/lib/data/types";
import { answerQuestion, declineQuestion, saveOffer, type QuestionInputError } from "@/lib/questions/questions";

// Ask a question (B19). Each action checks the session itself, and every query takes the signed-in host's id, so another
// host's question is simply not found.

const back = (result: string): never => {
  revalidatePath("/dashboard/questions");
  redirect(`/dashboard/questions?result=${encodeURIComponent(result)}`);
};

export async function saveOfferAction(form: FormData): Promise<void> {
  const user = await requireHost();
  if (!authEnabled()) back("demo");
  const rupees = String(form.get("price") ?? "").trim() || "0";
  const priceMinor = /^\d{1,6}(\.\d{1,2})?$/.test(rupees) ? Math.round(Number(rupees) * 100) : Number.NaN;
  let result = "saved";
  try {
    await saveOffer(getPool(process.env.DATABASE_URL as string), user.id, {
      active: form.get("active") === "on", priceMinor, responseDays: Number(form.get("responseDays")), intro: String(form.get("intro") ?? ""),
    });
  } catch (error) {
    if (!isNamedError<QuestionInputError>(error, "QuestionInputError")) throw error;
    result = `invalid_${Object.keys(error.fields)[0]}`;
  }
  back(result);
}

export async function answerAction(form: FormData): Promise<void> {
  const user = await requireHost();
  if (!authEnabled()) back("demo");
  back(await answerQuestion(getPool(process.env.DATABASE_URL as string), user.id, String(form.get("id") ?? ""), String(form.get("answer") ?? ""), new Date()));
}

export async function declineAction(form: FormData): Promise<void> {
  const user = await requireHost();
  if (!authEnabled()) back("demo");
  back(await declineQuestion(getPool(process.env.DATABASE_URL as string), user.id, String(form.get("id") ?? ""), new Date()));
}
