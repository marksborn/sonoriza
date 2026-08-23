"use client";

import { usePathname } from "next/navigation";

const TABS = [
  { href: "/dashboard/descobrir/para-voce", label: "Para você" },
  { href: "/dashboard/descobrir/albuns", label: "Álbuns" },
  { href: "/dashboard/descobrir/novidades", label: "Novidades" },
] as const;

export function DiscoverTabs() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Seções de Descobrir"
      className="grid grid-cols-3 gap-1 rounded-2xl border border-line-dark/60 bg-surface-subtle/70 p-1"
    >
      {TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <a
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-xl px-3 py-2.5 text-center text-sm font-black transition ${
              active
                ? "bg-brand text-white shadow-action"
                : "text-muted-inverse hover:bg-surface-elevated hover:text-ink-inverse"
            }`}
          >
            {tab.label}
          </a>
        );
      })}
    </nav>
  );
}
