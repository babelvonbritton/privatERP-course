/** Olaseena brand mark: the lambda (λ), drawn as inline SVG. */
export function Logo({ className = "", small = false }: { className?: string; small?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg width={small ? 26 : 32} height={small ? 26 : 32} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect x="1.5" y="1.5" width="29" height="29" rx="9" stroke="var(--color-plum-600)" strokeWidth="2" />
        <path
          d="M17.5 7 10 25.5"
          stroke="var(--color-plum-600)"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path
          d="M17.5 7 22.5 25.5h3.5"
          stroke="var(--color-plum-600)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className={`${small ? "text-xl" : "text-3xl"} font-semibold tracking-tight text-plum-900`}>Olaseena</span>
    </div>
  );
}

/** Lambda mark alone, for small places such as the mobile bar and the tour. */
export function LambdaMark({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      <path d="M17.5 7 10 25.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M17.5 7 22.5 25.5h3.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
