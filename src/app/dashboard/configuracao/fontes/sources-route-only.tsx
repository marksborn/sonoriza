"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function SourcesRouteOnly({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  if (pathname !== "/dashboard/configuracao/fontes") return null;

  return <>{children}</>;
}
