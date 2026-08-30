import type { ReactNode } from "react";

import { UiIcon, type UiIconName } from "@/components/UiIcon";

export function ProductSectionHeader({
  eyebrow,
  title,
  description,
  icon,
  iconTone = "brand",
  titleAccessory,
  aside,
  large = false,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  icon: UiIconName;
  iconTone?: "brand" | "accent";
  titleAccessory?: ReactNode;
  aside?: ReactNode;
  large?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={`${
            iconTone === "accent"
              ? "product-icon-tile-accent"
              : "product-icon-tile"
          } h-10 w-10 shrink-0 sm:h-11 sm:w-11`}
        >
          <UiIcon name={icon} size={20} />
        </span>
        <div className="min-w-0">
          <p
            className={`text-xs font-black uppercase tracking-[0.15em] ${
              iconTone === "accent" ? "text-accent-400" : "text-brand-400"
            }`}
          >
            {eyebrow}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h2
              className={`${
                large
                  ? "text-2xl sm:text-3xl"
                  : "text-xl"
              } font-black tracking-tight text-ink-inverse`}
            >
              {title}
            </h2>
            {titleAccessory}
          </div>
          {description ? (
            <div className="mt-1 max-w-2xl text-sm leading-5 text-muted-inverse sm:leading-6">
              {description}
            </div>
          ) : null}
        </div>
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </div>
  );
}
