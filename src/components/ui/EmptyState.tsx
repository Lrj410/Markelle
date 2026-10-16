import type { ReactNode } from "react";
import clsx from "clsx";

interface Props {
  children: ReactNode;
  /** Softer secondary tone (e.g. in-progress). */
  quiet?: boolean;
  /** Marks the region busy for assistive tech. */
  busy?: boolean;
  className?: string;
  as?: "p" | "div";
}

/** Shared empty / loading copy for dock panels and lists. */
export function EmptyState({
  children,
  quiet,
  busy,
  className,
  as: Tag = "p",
}: Props) {
  return (
    <Tag
      className={clsx("panel-empty", quiet && "quiet", className)}
      aria-busy={busy || undefined}
      role={busy ? "status" : undefined}
    >
      {children}
    </Tag>
  );
}
