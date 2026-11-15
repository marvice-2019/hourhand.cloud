// Spots questions that ask about health, so the editor can remind the host that the answers are personal data under the
// DPDP Act. A hint, not a classifier: it errs towards showing the note.
const HEALTH_WORDS = [
  "health", "medical", "medicine", "medication", "medicines", "diagnos", "symptom", "illness", "disease", "condition",
  "therapy", "therapist", "counsel", "psychiatr", "psycholog", "mental", "anxiety", "depress", "stress", "panic", "trauma",
  "suicid", "self-harm", "self harm", "harm yourself", "sleep", "eating", "weight", "pregnan", "allerg", "disab",
  "injur", "pain", "surgery", "hospital", "doctor", "treatment", "prescri", "addict", "alcohol", "substance", "adhd",
  "autis", "blood", "heart", "diabet", "thyroid", "period", "menstru", "sexual",
];

/** True when a question label looks like it asks about health. */
export function looksHealthRelated(label: string): boolean {
  const l = label.toLowerCase();
  return HEALTH_WORDS.some((w) => l.includes(w));
}

/** The note shown in the editor when any question asks about health. */
export const HEALTH_NOTE =
  "Some of these questions ask about health. Clients' answers are personal data under India's Digital Personal Data Protection Act, 2023 (DPDP Act), " +
  "and health details are among the most private things people share. Ask only what you need before the first session, and keep the answers to yourself.";
