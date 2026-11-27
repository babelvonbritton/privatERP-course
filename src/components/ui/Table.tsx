import type { ReactNode } from "react";

/**
 * Scrollable table shell: a keyboard-focusable region with a table inside.
 * Columns differ per screen, so only the wrapper, the table, and the cell
 * padding are shared; each screen still writes its own head and rows.
 */
export function TableShell({
  label,
  minWidth,
  wrapperClassName,
  children,
}: {
  label: string;
  minWidth: string;
  wrapperClassName?: string;
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      tabIndex={0}
      aria-label={label}
      className={wrapperClassName ?? "relative overflow-x-auto rounded-card border border-line bg-surface"}
    >
      <table className="w-full border-collapse text-left text-sm" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

/** Header cell with the shared padding and weight; pass className for alignment extras. */
export function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th scope="col" className={className ? `px-4 py-3 font-medium ${className}` : "px-4 py-3 font-medium"}>
      {children}
    </th>
  );
}

/** Body cell with the shared padding; pass className for color, weight, and alignment extras. */
export function Td({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={className ? `px-4 py-3 ${className}` : "px-4 py-3"}>{children}</td>;
}
