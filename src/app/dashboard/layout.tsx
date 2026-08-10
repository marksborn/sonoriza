import Link from "next/link";

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
        <div className="sticky top-0 z-[70] border-b border-orange-400/30 bg-[#32110d]/95 px-4 py-3 text-orange-50 shadow-lg backdrop-blur-xl">
          <div className="mx-auto flex max-w-6xl flex-col gap-1 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-5">
            <p className="font-black">
              Spotify temporariamente bloqueado · {backoff.reason === "QUOTA_EXCEEDED" ? "quota excedida" : "limite de requisições"}
            </p>
            <p className="font-semibold text-orange-100/85">
              Tente novamente após {formatBackoffDate(backoff.blockedUntil)} · {formatRemaining(retryAfterSecondsRemaining(backoff))}
            </p>
          </div>
        </div>
      ) : null}
      {children}
      <Link
        href="/dashboard/configuracao"
        className="fixed bottom-5 right-5 z-50 inline-flex items-center gap-2 rounded-2xl border border-violet-300/30 bg-[#241052]/95 px-4 py-3 text-sm font-black text-violet-100 shadow-[0_18px_45px_-20px_rgba(139,92,246,0.95)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-violet-200/60 hover:bg-violet-800 sm:bottom-7 sm:right-7"
      >
        <span aria-hidden="true">⚙</span>
        Configurar
      </Link>
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