import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { BrandLogo } from "@/components/BrandLogo";
import { TargetRunButton } from "@/components/TargetRunButton";
import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  runSummaryMentionsTarget,
  summarizeGenerationRunDiagnostic,
} from "@/services/generation-run-diagnostics";

export default async function GeneratedPlaylistPage({
  params,
}: {
  params: Promise<{ targetId: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const { targetId } = await params;
  const target = await prisma.targetPlaylist.findFirst({
    where: {
      id: targetId,
      userId: session.user.id,
    },
  });

  if (!target) notFound();

  const [run, recentRuns] = await Promise.all([
    prisma.generationRun.findFirst({
      where: {
        userId: session.user.id,
        simulation: false,
        status: { in: ["SUCCESS", "PARTIAL"] },
        items: {
          some: { targetPlaylistId: target.id },
        },
      },
      orderBy: { startedAt: "desc" },
      include: {
        items: {
          where: { targetPlaylistId: target.id },
          orderBy: { position: "asc" },
        },
      },
    }),
    loadRecentTargetRuns(session.user.id, target.id),
  ]);

  const items = run?.items ?? [];
  const musicCount = items.filter((item) => item.contentType === "MUSIC").length;
  const podcastCount = items.filter((item) => item.contentType === "PODCAST").length;
  const totalDurationMs = items.reduce(
    (total, item) => total + Math.max(0, item.durationMs),
    0,
  );
  const spotifyUrl = target.spotifyPlaylistId
    ? `https://open.spotify.com/playlist/${target.spotifyPlaylistId}`
    : null;

  return (
    <main className="product-shell min-h-screen pb-12">
      <div className="product-ambient" />

      <header className="relative z-10 border-b border-line-dark/50 bg-surface-dark/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4 sm:px-8 lg:px-10">
          <BrandLogo compact variant="light" />
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-2xl border border-line-dark/70 bg-surface-subtle/70 px-4 py-2 text-sm font-bold text-muted-inverse transition hover:border-brand-400/50 hover:bg-surface-elevated hover:text-ink-inverse"
          >
            <UiIcon name="arrow-left" size={18} />
            Voltar ao painel
          </Link>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-6xl space-y-5 px-5 py-6 sm:space-y-6 sm:px-8 lg:px-10 lg:py-8">
        <section className="relative overflow-hidden rounded-[2rem] border border-brand-400/30 bg-brand-gradient p-6 shadow-product-card sm:p-8">
          <div className="pointer-events-none absolute -right-14 -top-24 h-72 w-72 rounded-full border-[42px] border-white/10" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-3 py-1.5 text-xs font-black uppercase tracking-[0.16em] text-accent-400 backdrop-blur-sm">
                <UiIcon name="list" size={16} />
                Última geração do Sonoriza
              </span>
              <h1 className="mt-4 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
                {target.name}
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80 sm:text-base">
                Esta visão mostra exatamente os itens persistidos pelo Sonoriza na geração real mais recente deste destino. Simulações não aparecem aqui.
              </p>
            </div>

            <div className="flex flex-col items-start gap-3 sm:items-end">
              <TargetRunButton targetId={target.id} targetName={target.name} />
              {spotifyUrl ? (
                <a
                  href={spotifyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex w-fit items-center gap-2 rounded-2xl border border-white/15 bg-white/10 px-4 py-2.5 text-sm font-bold text-ink-inverse backdrop-blur-sm transition hover:bg-white/15"
                >
                  <UiIcon name="play" size={18} />
                  Abrir no Spotify
                </a>
              ) : null}
            </div>
          </div>
        </section>

        {!run ? (
          <section className="product-panel p-6 sm:p-8">
            <div className="mx-auto max-w-xl py-8 text-center">
              <span className="product-icon-tile mx-auto h-12 w-12">
                <UiIcon name="history" size={22} />
              </span>
              <h2 className="mt-4 text-xl font-black text-ink-inverse">
                Nenhuma geração real aplicada ainda
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-inverse">
                Este destino pode ter simulações ou tentativas anteriores, mas ainda não existe uma geração real com itens persistidos para apresentar como playlist aplicada.
              </p>
            </div>
          </section>
        ) : (
          <>
            <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Itens" value={String(items.length)} />
              <Metric label="Duração planejada" value={formatDuration(totalDurationMs)} />
              <Metric label="Músicas" value={String(musicCount)} />
              <Metric label="Podcasts" value={String(podcastCount)} />
            </section>

            <section className="product-panel p-5 sm:p-6">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
                    Execução de origem
                  </p>
                  <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
                    Geração real de {formatRunDate(run.startedAt)}
                  </h2>
                  <p className="mt-1 text-sm text-muted-inverse">
                    Run <code className="text-ink-inverse">{run.id}</code>
                  </p>
                </div>
                <span
                  className={`inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${
                    run.status === "SUCCESS" ? "status-success" : "status-warning"
                  }`}
                >
                  {run.status === "SUCCESS" ? (
                    <UiIcon name="check" size={14} />
                  ) : (
                    <UiIcon name="warning" size={14} />
                  )}
                  {run.status === "SUCCESS" ? "SUCESSO" : "PARCIAL"}
                </span>
              </div>
            </section>

            <section className="product-panel overflow-hidden">
              <div className="border-b border-line-dark/55 px-5 py-5 sm:px-6">
                <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
                  Ordem aplicada
                </p>
                <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
                  Conteúdo da playlist
                </h2>
                <p className="mt-1 text-sm text-muted-inverse">
                  A duração exibida é a duração usada pelo planner. Em podcasts parcialmente ouvidos, ela pode representar apenas o tempo restante considerado na geração.
                </p>
              </div>

              {items.length === 0 ? (
                <div className="px-5 py-8 text-center text-sm text-muted-inverse sm:px-6">
                  A geração foi registrada sem itens para este destino.
                </div>
              ) : (
                <ol className="divide-y divide-line-dark/45">
                  {items.map((item) => (
                    <li
                      key={item.id}
                      className="flex gap-4 px-5 py-4 sm:items-center sm:px-6"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-surface-subtle text-sm font-black text-muted-inverse">
                        {item.position + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${
                              item.contentType === "MUSIC" ? "status-info" : "status-warning"
                            }`}
                          >
                            <UiIcon
                              name={item.contentType === "MUSIC" ? "music" : "play"}
                              size={13}
                            />
                            {item.contentType === "MUSIC" ? "Música" : "Podcast"}
                          </span>
                          <span className="text-xs font-semibold text-muted-inverse">
                            {formatDuration(item.durationMs)}
                          </span>
                        </div>
                        <p className="mt-2 truncate font-black text-ink-inverse">
                          {item.title ?? "Item sem título"}
                        </p>
                        {item.subtitle ? (
                          <p className="mt-1 truncate text-sm text-muted-inverse">
                            {item.subtitle}
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}

        <section className="product-panel overflow-hidden">
          <div className="border-b border-line-dark/55 px-5 py-5 sm:px-6">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
              Histórico operacional
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
              Execuções recentes
            </h2>
            <p className="mt-1 text-sm text-muted-inverse">
              Sucessos, execuções parciais e falhas deste destino. Nenhuma consulta extra ao Spotify é feita para montar este histórico.
            </p>
          </div>

          {recentRuns.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-muted-inverse sm:px-6">
              Nenhuma execução real deste destino foi registrada ainda.
            </div>
          ) : (
            <div className="divide-y divide-line-dark/45">
              {recentRuns.map((recentRun) => {
                const schedule = recentRun.scheduleRuns[0] ?? null;
                const diagnostic = summarizeGenerationRunDiagnostic({
                  summary: recentRun.summary,
                  error: recentRun.error,
                  scheduleReason: schedule?.reason ?? null,
                });

                return (
                  <article key={recentRun.id} className="px-5 py-5 sm:px-6">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-bold ${runStatusClass(recentRun.status)}`}
                          >
                            <UiIcon
                              name={recentRun.status === "SUCCESS" ? "check" : "warning"}
                              size={13}
                            />
                            {runStatusLabel(recentRun.status)}
                          </span>
                          <span className="text-xs font-bold text-muted-inverse">
                            {triggerLabel(recentRun.trigger)}
                          </span>
                          {schedule && schedule.attempt > 1 ? (
                            <span className="text-xs font-semibold text-muted-inverse">
                              tentativa {schedule.attempt}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-2 font-black text-ink-inverse">
                          {formatRunDate(recentRun.startedAt)}
                        </p>
                        <p className="mt-1 break-all text-xs text-muted-inverse">
                          Run <code className="text-ink-inverse">{recentRun.id}</code>
                        </p>
                      </div>

                      {recentRun.finishedAt ? (
                        <span className="text-xs font-semibold text-muted-inverse">
                          finalizada {formatRunDate(recentRun.finishedAt)}
                        </span>
                      ) : null}
                    </div>

                    {diagnostic ? (
                      <details
                        className={`mt-4 rounded-2xl border p-4 ${
                          recentRun.status === "FAILED"
                            ? "border-red-400/25 bg-red-500/10"
                            : "border-amber-400/20 bg-amber-400/5"
                        }`}
                        open={recentRun.status === "FAILED"}
                      >
                        <summary className="cursor-pointer list-none font-black text-ink-inverse">
                          {diagnostic.headline}
                        </summary>
                        <p className="mt-2 text-sm leading-6 text-muted-inverse">
                          {diagnostic.detail}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-muted-inverse">
                          {diagnostic.source ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              {diagnostic.source}
                            </span>
                          ) : null}
                          {diagnostic.operation ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              {diagnostic.operation}
                            </span>
                          ) : null}
                          {diagnostic.providerStatus !== null ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              HTTP {diagnostic.providerStatus}
                            </span>
                          ) : null}
                          {diagnostic.pagesRead !== null ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              {diagnostic.pagesRead} página{diagnostic.pagesRead === 1 ? "" : "s"} lida{diagnostic.pagesRead === 1 ? "" : "s"}
                            </span>
                          ) : null}
                          {diagnostic.partialRead ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              leitura parcial descartada
                            </span>
                          ) : null}
                          {diagnostic.retryAfterSeconds !== null ? (
                            <span className="rounded-full border border-line-dark/70 px-2.5 py-1">
                              retry após {diagnostic.retryAfterSeconds}s
                            </span>
                          ) : null}
                        </div>
                      </details>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function runStatusClass(status: string): string {
  if (status === "SUCCESS") return "status-success";
  if (status === "PARTIAL") return "status-warning";
  return "border-red-400/30 bg-red-500/10 text-red-200";
}

function runStatusLabel(status: string): string {
  if (status === "SUCCESS") return "SUCESSO";
  if (status === "PARTIAL") return "PARCIAL";
  if (status === "FAILED") return "FALHA";
  return status;
}

function triggerLabel(trigger: string): string {
  if (trigger === "SCHEDULED") return "Agendada";
  if (trigger === "MANUAL") return "Manual";
  return trigger;
}

async function loadRecentRunBatch(userId: string, targetId: string, skip: number) {
  return prisma.generationRun.findMany({
    where: {
      userId,
      simulation: false,
    },
    orderBy: { startedAt: "desc" },
    skip,
    take: 40,
    select: {
      id: true,
      trigger: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      error: true,
      summary: true,
      items: {
        where: { targetPlaylistId: targetId },
        select: { id: true },
        take: 1,
      },
      scheduleRuns: {
        where: { targetPlaylistId: targetId },
        orderBy: { startedAt: "desc" },
        select: { status: true, reason: true, attempt: true },
        take: 1,
      },
    },
  });
}

type RecentRunCandidate = Awaited<ReturnType<typeof loadRecentRunBatch>>[number];

async function loadRecentTargetRuns(
  userId: string,
  targetId: string,
): Promise<RecentRunCandidate[]> {
  const matches: RecentRunCandidate[] = [];
  let skip = 0;

  while (matches.length < 8) {
    const batch = await loadRecentRunBatch(userId, targetId, skip);
    for (const candidate of batch) {
      if (
        candidate.items.length > 0 ||
        candidate.scheduleRuns.length > 0 ||
        runSummaryMentionsTarget(candidate.summary, targetId)
      ) {
        matches.push(candidate);
        if (matches.length >= 8) break;
      }
    }

    if (batch.length < 40) break;
    skip += batch.length;
  }

  return matches.slice(0, 8);
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="product-panel p-5">
      <p className="text-xs font-black uppercase tracking-[0.14em] text-muted-inverse">
        {label}
      </p>
      <p className="mt-2 text-2xl font-black tracking-tight text-ink-inverse">{value}</p>
    </div>
  );
}

function formatDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.round(durationMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) return `${totalMinutes} min`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}min`;
}

function formatRunDate(date: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}
