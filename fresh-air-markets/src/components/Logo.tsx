/** Fresh Air Markets & Events brand mark: a leaf sprig inside a thin ring. */
export function LogoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      width={size}
      height={size}
      className={className}
      aria-hidden
    >
      <circle cx="60" cy="62" r="48" fill="none" stroke="#6fa3e8" strokeWidth="2.5" />
      <g strokeLinejoin="round">
        <path
          d="M 44 86 Q 40 76 44 68 Q 48 60 46 50"
          fill="none"
          stroke="#274d99"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path d="M 46 50 Q 34 46 28 36 Q 38 34 46 40 Q 50 44 46 50 Z" fill="#9cc1ef" />
        <path d="M 46 50 Q 40 34 46 18 Q 58 26 56 42 Q 54 48 46 50 Z" fill="#1d3f8f" />
        <path d="M 46 50 Q 58 44 70 42 Q 66 52 56 56 Q 50 56 46 50 Z" fill="#3a63c9" />
        <path d="M 44 68 Q 56 64 66 68 Q 60 76 50 76 Q 45 74 44 68 Z" fill="#5b86d6" />
        <path d="M 44 86 Q 54 84 60 90 Q 54 96 46 94 Q 42 90 44 86 Z" fill="#274d99" />
      </g>
    </svg>
  );
}

/** Full lockup: mark + wordmark, for hero/footer placements with room to breathe. */
export function LogoLockup({
  size = 40,
  dark = false,
  className = "",
}: {
  size?: number;
  dark?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <LogoMark size={size} />
      <div className="leading-none">
        <div className={`font-display text-xl ${dark ? "text-cream" : "text-pine-deep"}`}>Fresh Air</div>
        <div
          className={`mt-0.5 text-[10px] font-bold uppercase tracking-[0.2em] ${
            dark ? "text-cream/60" : "text-ink/50"
          }`}
        >
          Markets &amp; Events
        </div>
      </div>
    </div>
  );
}
