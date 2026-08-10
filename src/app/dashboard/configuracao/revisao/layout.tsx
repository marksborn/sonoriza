import type { ReactNode } from "react";

import { ReconnectSpotifyAction } from "@/app/dashboard/configuracao/revisao/reconnect-spotify-action";
import { UiIcon } from "@/components/UiIcon";
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
    <div className="min-h-screen bg-canvas-dark">
      {children}
      <div className="relative mx-auto max-w-5xl px-5 pb-8 sm:px-8 lg:px-10">
        <section className="product-panel p-5 sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
                MUSIC-01 · Repetição
              </p>
              <h2 className="mt-1 text-xl font-black text-ink-inverse">
                {policy.enabled
                  ? windowLabel(policy.windowValue, policy.windowUnit)
                  : "Regra de repetição desativada"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-inverse">
                {policy.enabled
                  ? "O histórico do Spotify é aplicado antes do planner; músicas dentro do período não contam para sequência, proporção ou quality gate."
                  : "O histórico pode continuar armazenado, mas não filtra o pool enquanto a regra estiver desativada."}
              </p>
            </div>
            <a href="/dashboard/configuracao/musica" className="product-link shrink-0">
              Editar
              <UiIcon name="arrow-right" size={17} />
            </a>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="product-card p-4">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-brand-400">
                Última simulação
              </p>
              <p className="mt-2 text-lg font-black text-ink-inverse">{skipped}</p>
              <p className="mt-1 text-xs text-muted-inverse">
                músicas ignoradas por reprodução recente
              </p>
            </div>
            <div className="product-card p-4">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-brand-400">
                Histórico conhecido desde
              </p>
              <p className="mt-2 text-sm font-bold text-ink-inverse">
                {formatKnownSince(knownSince)}
              </p>
            </div>
            <div className="product-card p-4">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-brand-400">
                Permissão Spotify
              </p>
              <p
                className={`mt-2 inline-flex items-center gap-1.5 text-sm font-black ${
                  assessment.hasSpotifyRecentlyPlayedScope ? "text-success" : "text-warning"
                }`}
              >
                {assessment.hasSpotifyRecentlyPlayedScope ? (
                  <>
                    <UiIcon name="check" size={15} />
                    Recently Played disponível
                  </>
                ) : (
                  <>
                    <UiIcon name="warning" size={15} />
                    Reconexão necessária
                  </>
                )}
              </p>
              <ReconnectSpotifyAction />
            </div>
          </div>

          {policy.enabled && !repeatSummary ? (
            <p className="mt-4 text-xs leading-5 text-muted-inverse">
              O impacto detalhado aparecerá após a próxima simulação com MUSIC-01 ativo.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
