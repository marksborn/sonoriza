"use client";

import { Children, type ReactNode, useState } from "react";

export function ProgressiveList({
  children,
  initialCount,
  className,
  moreLabel,
  lessLabel = "Mostrar menos",
}: {
  children: ReactNode;
  initialCount: number;
  className: string;
  moreLabel: string;
  lessLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = Children.toArray(children);
  const remaining = Math.max(0, items.length - initialCount);
  const visibleItems = expanded ? items : items.slice(0, initialCount);

  return (
    <>
      <ol className={className}>{visibleItems}</ol>
      {remaining > 0 ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-brand-400/35 bg-surface-elevated/55 px-4 py-2 text-sm font-black text-brand-300 transition hover:border-brand-400/65 hover:text-accent-300"
        >
          {expanded ? lessLabel : moreLabel}
        </button>
      ) : null}
    </>
  );
}
