import type { ReactNode } from "react";

export function ProductMetricCard({
  value,
  label,
  detail,
  compact = false,
  className = "",
}: {
  value: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-line-dark/55 bg-surface-subtle/65 px-4 py-4 ${className}`}
    >
      <p
        className={`${
          compact ? "text-base leading-5 sm:text-lg" : "text-xl sm:text-2xl"
        } font-black text-ink-inverse`}
      >
        {value}
      </p>
      <p className="mt-1 text-xs font-semibold text-muted-inverse">{label}</p>
      {detail ? (
        <p className="mt-1 text-[10px] leading-4 text-muted-inverse/75">
          {detail}
        </p>
      ) : null}
    </div>
  );
}
