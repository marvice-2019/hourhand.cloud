// Ink: the fixed warm dark of the landing page's showcase bands, the same in both themes.
// Kept here as Tailwind classes so the landing page needs no stylesheet of its own.

export const ink = {
  band: "bg-[#120e0b] text-[#f4ece1] [color-scheme:dark] selection:bg-[#e8743f] selection:text-[#120e0b]",
  raise: "bg-[#1b1511]",
  sunk: "bg-[#120e0b]",
  line: "border-[rgb(244_236_225/0.1)]",
  lineStrong: "border-[rgb(244_236_225/0.18)]",
  divide: "divide-[rgb(244_236_225/0.1)]",
  text: "text-[#f4ece1]",
  muted: "text-[#b3a593]",
  accent: "text-[#e8743f]",
  accentBg: "bg-[#e8743f] text-[#1a120c]",
  success: "text-[#5cc28e]",
  successPill: "bg-[rgb(92_194_142/0.12)] text-[#5cc28e]",
  danger: "text-[#f07a6a]",
  dangerPill: "bg-[rgb(240_122_106/0.12)] text-[#f07a6a]",
  focus: "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e8743f]",
  // The product frame, lit along its top edge.
  frame:
    "rounded-[14px] border border-[rgb(244_236_225/0.18)] bg-[#1b1511] shadow-[inset_0_1px_0_rgb(244_236_225/0.07),0_30px_80px_-20px_rgb(0_0_0/0.7),0_12px_24px_-12px_rgb(0_0_0/0.5)]",
  pane: "rounded-md border border-[rgb(244_236_225/0.1)] bg-[#120e0b]",
} as const;

/** Fraunces held tight at its large optical size: the brand's display voice. */
export const display = "font-display font-semibold tracking-[-0.03em] leading-[1.02] text-balance [font-variation-settings:'opsz'_144]";
export const heading = "font-display font-semibold tracking-[-0.02em] leading-[1.1] text-balance [font-variation-settings:'opsz'_96]";

/** Exponential ease-out for the one authored state change. */
export const easeOut = "ease-[cubic-bezier(0.16,1,0.3,1)]";
