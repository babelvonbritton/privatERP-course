/** Olaseena brand mark: the lambda (λ), drawn as inline SVG. */
const LAMBDA_PATH =
  "M25 18c7-1.6 13-1.7 18-.5 6 1.4 10 5 13 12l17 37c1 3 2 5 4 5l2-.3v13c-8 2-14 1-19-2-5-3-7-7-9-13l-6-14-14 32H17l22-49-4-9c-2-4-5-4-10-2l-5 2z";

export function Logo({ className = "", small = false }: { className?: string; small?: boolean }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg width={small ? 26 : 32} height={small ? 26 : 32} viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="var(--color-plum-600)" />
        <path d={LAMBDA_PATH} transform="scale(0.32)" fill="var(--color-canvas)" />
      </svg>
      <span className={`${small ? "text-xl" : "text-3xl"} font-semibold tracking-tight text-plum-900`}>Olaseena</span>
    </div>
  );
}

/** Lambda mark alone, for small places such as the mobile bar and the tour. */
export function LambdaMark({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className={className}>
      <path d={LAMBDA_PATH} transform="scale(0.32)" fill="currentColor" />
    </svg>
  );
}
