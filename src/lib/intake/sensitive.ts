// Spots questions that ask about health, so the editor can show its DPDP Act note (host catalogue "intake.healthNote").
// A hint, not a classifier: it errs towards showing the note.
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
