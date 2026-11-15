// Starter intake templates in plain English. Each is an example for the host to read and edit before using: Hourhand
// doesn't know their practice, and these are prompts, not clinical or professional forms.
import type { TemplateQuestion } from "./templates-shape";

export interface StarterTemplate {
  key: "therapy" | "coaching" | "tutoring";
  name: string;
  /** One line on what it is for, shown on the templates page. */
  summary: string;
  questions: TemplateQuestion[];
}

const q = (label: string, kind: TemplateQuestion["kind"], extra: Partial<TemplateQuestion> = {}): TemplateQuestion =>
  ({ label, kind, required: false, choices: [], ...extra });

export const STARTERS: readonly StarterTemplate[] = [
  {
    key: "therapy",
    name: "Therapy intake",
    summary: "What brings a new client, their past experience of therapy, and an emergency note. Asked on the first booking only.",
    questions: [
      q("What would you like help with?", "long_text", { required: true, firstBookingOnly: true }),
      q("Have you had therapy or counselling before?", "yes_no", { required: true, firstBookingOnly: true }),
      q("What worked for you, or didn't?", "long_text", { firstBookingOnly: true, showIf: { questionIndex: 1, values: ["yes"] } }),
      q("Are you taking any medication you'd like me to know about?", "long_text", { firstBookingOnly: true }),
      q("How would you prefer to be addressed?", "short_text", { firstBookingOnly: true }),
      q("Someone we can contact in an emergency (name and phone)", "short_text", { firstBookingOnly: true }),
      q("I understand these sessions aren't an emergency service. If I'm in crisis, I'll call Tele-MANAS on 14416 or emergency services on 112.", "consent", { required: true, firstBookingOnly: true }),
    ],
  },
  {
    key: "coaching",
    name: "Coaching discovery",
    summary: "Goals, what's in the way, and how the client likes to work.",
    questions: [
      q("What would you like to get out of coaching?", "long_text", { required: true }),
      q("Which area is this mostly about?", "single_select", { required: true, choices: ["Career", "Leadership", "Business", "Health and habits", "Relationships", "Something else"] }),
      q("Tell me a little about it", "short_text", { showIf: { questionIndex: 1, values: ["Something else"] } }),
      q("What has got in the way so far?", "long_text"),
      q("Have you worked with a coach before?", "yes_no", { firstBookingOnly: true }),
      q("How do you like to be held to account?", "multi_select", { choices: ["Weekly check-ins", "WhatsApp nudges", "Written action plans", "Just the sessions"] }),
      q("When would you like to see a change by?", "date"),
    ],
  },
  {
    key: "tutoring",
    name: "Tutoring",
    summary: "Student level, subject, and the exam they're preparing for.",
    questions: [
      q("Student's name", "short_text", { required: true, firstBookingOnly: true }),
      q("Class or level", "single_select", { required: true, choices: ["Class 1 to 5", "Class 6 to 8", "Class 9 to 10", "Class 11 to 12", "College", "Adult learner"] }),
      q("Board", "single_select", { choices: ["CBSE", "ICSE", "State board", "IB", "Cambridge (IGCSE)", "Other"], showIf: { questionIndex: 1, values: ["Class 1 to 5", "Class 6 to 8", "Class 9 to 10", "Class 11 to 12"] } }),
      q("Subject", "short_text", { required: true }),
      q("Preparing for an exam?", "yes_no", { required: true }),
      q("Which exam?", "short_text", { required: true, showIf: { questionIndex: 4, values: ["yes"] } }),
      q("Exam date", "date", { showIf: { questionIndex: 4, values: ["yes"] } }),
      q("Latest marks in this subject (out of 100)", "number", { minValue: 0, maxValue: 100 }),
      q("Parent's email, if different from yours", "email", { firstBookingOnly: true }),
    ],
  },
];

export const starterByKey = (key: string): StarterTemplate | undefined => STARTERS.find((s) => s.key === key);
