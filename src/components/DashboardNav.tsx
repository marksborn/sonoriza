"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";

const items = [
  {
    href: "/dashboard/descobrir",
    label: "Descobrir",
    icon: "music" as const,
    match: (pathname: string) => pathname.startsWith("/dashboard/descobrir"),
  },
  {
    href: "/dashboard/historico",
    label: "Histórico",
    icon: "history" as const,
    match: (pathname: string) => pathname.startsWith("/dashboard/historico"),
  },
  {
    href: "/dashboard/configuracao",
    label: "Configurar",
    icon: "settings" as const,
    match: (pathname: string) => pathname.startsWith("/dashboard/configuracao"),
  },
];

export function DashboardNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navegação principal do Sonoriza"
      className="fixed inset-x-3 bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-50 grid grid-cols-3 gap-1 rounded-2xl border border-line-dark/70 bg-surface-dark/90 p-1.5 shadow-product-card backdrop-blur-2xl sm:inset-x-auto sm:bottom-7 sm:right-7 sm:flex sm:w-auto sm:flex-col sm:items-stretch sm:gap-1.5 sm:rounded-3xl sm:p-2"
    >
      {items.map((item) => {
        const active = item.match(pathname);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`inline-flex min-w-0 items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-[11px] font-black transition sm:justify-start sm:gap-2 sm:rounded-2xl sm:px-4 sm:py-3 sm:text-sm ${
              active
                ? "border-brand-400/60 bg-brand text-white shadow-product-card"
                : "border-transparent bg-surface-elevated/75 text-muted-inverse hover:border-brand-400/45 hover:bg-surface-subtle hover:text-ink-inverse"
            }`}
          >
            <UiIcon
              name={item.icon}
              size={18}
              className="h-4 w-4 shrink-0 sm:h-[19px] sm:w-[19px]"
            />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
