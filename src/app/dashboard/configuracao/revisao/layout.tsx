import type { ReactNode } from "react";

import { ReconnectSpotifyAction } from "@/app/dashboard/configuracao/revisao/reconnect-spotify-action";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assessConfiguration } from "@/services/configuration-readiness";

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function formatKnownSince(value: unknown): string {
  if (typeof value !== "string") return "Ainda não conhecido";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Ainda não conhecido";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

function windowLabel(value: number | null, unit: "DAYS" | "MONTHS" | "YEARS" | null) {
  if (!value || !unit) return "Configuração incompleta";
  const label =
    unit === "DAYS" ? (value === 1 ? "dia" : "dias") :
    unit === "MONTHS" ? (value === 1 ? "mês" : "meses") :
    value === 1 ? "ano" : "anos";
  return `Evitar músicas tocadas nos últimos ${value} ${label}`;
}

export default async function ConfigurationReviewLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth();
  if (!session?.user?.id) return children;

  const [assessment, latestSimulation] = await Promise.all([
    assessConfiguration(session.user.id),
    prisma.generationRun.findFirst({
      where: { userId: session.user.id, simulation: true },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, summary: true },
    }),
  ]);

  const policy = assessment.musicRepeatPolicy;
  const summary = objectValue(latestSimulation?.summary);
  const repeatSummary = objectValue(summary?.musicRepeat);
  const skipped = Math.max(
    0,
    Math.trunc(
      numberValue(summary?.musicRecentlyPlayedSkippedCount) ??
        numberValue(repeatSummary?.recentlyPlayedSkippedCount) ??
        0,
    ),
  );
  const knownSince =
    repeatSummary?.historyKnownSince ?? policy.historyKnownSince?.toISOString() ?? null;

  return (
    <div className="min-h-screen bg-[#0b021f]">
      {children}
      <div className="relative mx-auto max-w-5xl px-5 pb-8 sm:px-8 lg:px-10">
        <section className="rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.94),rgba(22,6,53,0.96))] p-5 text-white sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-orange-400">
                MUSIC-01 · Repetição
              </p>
              <h2 className="mt-1 text-xl font-black">
                {policy.enabled
                  ? windowLabel(policy.windowValue, policy.windowUnit)
                  : "Regra de repetição desativada"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-violet-200/70">
                {policy.enabled
                  ? "O histórico do Spotify é aplicado antes do planner; músicas dentro do período não contam para sequência, proporção ou quality gate."
                  : "O histórico pode continuar armazenado, mas não filtra o pool enquanto a regra estiver desativada."}
              </p>
            </div>
            <a
              href="/dashboard/configuracao/musica"
              className="shrink-0 text-sm font-black text-orange-300 hover:text-orange-200"
            >
              Editar →
            </a>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-violet-300/15 bg-black/15 p-4">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-violet-400">
                Última simulação
              </p>
              <p className="mt-2 text-lg font-black">{skipped}</p>
              <p className="mt-1 text-xs text-violet-200/60">
                músicas ignoradas por reprodução recente
              </p>
            </div>
            <div className="rounded-2xl border border-violet-300/15 bg-black/15 p-4">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-violet-400">
                Histórico conhecido desde
              </p>
              <p className="mt-2 text-sm font-bold text-violet-100">
                {formatKnownSince(knownSince)}
              </p>
            </div>
            <div className="rounded-2xl border border-violet-300/15 bg-black/15 p-4">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-violet-400">
                Permissão Spotify
              </p>
              <p
                className={`mt-2 text-sm font-black ${
                  assessment.hasSpotifyRecentlyPlayedScope
                    ? "text-emerald-300"
                    : "text-orange-300"
                }`}
              >
                {assessment.hasSpotifyRecentlyPlayedScope
                  ? "Recently Played disponível ✓"
                  : "Reconexão necessária"}
              </p>
              <ReconnectSpotifyAction />
            </div>
          </div>

          {policy.enabled && !repeatSummary ? (
            <p className="mt-4 text-xs leading-5 text-violet-300/65">
              O impacto detalhado aparecerá após a próxima simulação com MUSIC-01 ativo.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
