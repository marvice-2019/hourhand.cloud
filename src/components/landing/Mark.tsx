/** The Hourhand mark: a saffron face with one hand at about 1 o'clock and a marigold pivot. */
export function Mark({ size = "size-7" }: { size?: string }) {
  return (
    <span aria-hidden className={`relative ${size} shrink-0 rounded-pill bg-accent`}>
      <span className="absolute left-1/2 top-1/2 h-[34%] w-[9%] origin-bottom -translate-x-1/2 -translate-y-full rotate-[30deg] rounded-pill bg-bg" />
      <span className="absolute left-1/2 top-1/2 size-[26%] -translate-x-1/2 -translate-y-1/2 rounded-pill bg-highlight" />
    </span>
  );
}
