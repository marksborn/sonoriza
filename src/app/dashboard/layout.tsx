import Link from "next/link";

import { UiIcon } from "@/components/UiIcon";
import {
  getActiveSpotifyBackoff,
  retryAfterSecondsRemaining,
} from "@/services/spotify/backoff";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const backoff = await getActiveSpotifyBackoff();

  return (
    <>
      {backoff ? (
        <div className="sticky top-0 z-[70] border-b border-warning/30 bg-warning-soft/95 px-4 py-3 text-warning shadow-lg backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-5">
            <p className="flex items-center gap-2 font-black">
              <UiIcon name="warning" size={18} />
              Spotify temporariamente bloqueado · {backoff.reason === "QUOTA_EXCEEDED" ? "quota excedida" : "limite de requisições"}
            </p>
            <p className="font-semibold text-warning/80">
              Tente novamente após {formatBackoffDate(backoff.blockedUntil)} · {formatRemaining(retryAfterSecondsRemaining(backoff))}
            </p>
          </div>
        </div>
      ) : null}
      {children}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2 sm:bottom-7 sm:right-7">
        <Link
          href="/dashboard/descobrir"
          className="inline-flex items-center gap-2 rounded-2xl border border-brand-400/40 bg-brand/95 px-4 py-3 text-sm font-black text-white shadow-product-card backdrop-blur-xl transition hover:-translate-y-0.5 hover:bg-brand-400"
        >
          <UiIcon name="music" size={19} />
          Descobrir
        </Link>
        <Link
          href="/dashboard/configuracao"
          className="inline-flex items-center gap-2 rounded-2xl border border-line-dark/70 bg-surface-elevated/95 px-4 py-3 text-sm font-black text-ink-inverse shadow-product-card backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-brand-400/55 hover:bg-surface-subtle"
        >
          <UiIcon name="settings" size={19} />
          Configurar
        </Link>
      </div>
    </>
  );
}

function formatBackoffDate(value: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(value);
}

function formatRemaining(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.ceil((safe % 3600) / 60);
  if (hours > 0) return `aprox. ${hours}h${String(minutes).padStart(2, "0")}`;
  if (minutes > 0) return `aprox. ${minutes} min`;
  return "menos de 1 min";
}
