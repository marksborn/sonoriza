import Link from "next/link";
import { redirect } from "next/navigation";

import { ReviewSimulationButton } from "@/components/ReviewSimulationButton";
import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  assessConfiguration,
  getFirstRunGate,
} from "@/services/configuration-readiness";
import { readInconclusiveSimulation } from "@/services/simulation-presentation";

type PageProps = {
  searchParams: Promise<{ run?: string }>;
};

type SimulationTargetSummary = {
  targetPlaylistId: string | null;
  name: string;
  planned: number | null;
  totalMinutes: number | null;
  calendarEventCount: number | null;
  calendarTimedEventCount: number | null;
  calendarEventFilterMode: "ALL" | "MARKER" | null;
  calendarEventMarker: string | null;
  calendarDurationMinutes: number | null;
  calendarMaxEventDurationMinutes: number | null;
  podcastEpisodeMaxDurationMode: "NONE" | "FIXED" | "CALENDAR_MAX_EVENT" | null;
  podcastEpisodeMaxDurationMinutes: number | null;
  podcastDurationExceededCount: number | null;
  compositionMode: "PROPORTION" | "SEQUENCE" | null;
  musicOrderMode: "STANDARD" | "RANDOMIZED" | null;
  musicOrderSeed: string | null;
  musicOrderSeedSource: "RUN" | "SIMULATION" | null;
  musicOrderHash: string | null;
  musicOrderChanged: boolean | null;
  compositionQualityPassed: boolean | null;
  sequencePattern: Array<"MUSIC" | "PODCAST">;
  sequenceSlotsRequested: number | null;
  sequenceSlotsFilled: number | null;
  sequenceUnfilledSlots: number | null;
  completedCycles: number | null;
  finalPartialCycleSlots: number | null;
  stoppedAtPatternIndex: number | null;
  sequenceQualityPassed: boolean | null;
  sequenceStopReason: string | null;
  musicCount: number | null;
  podcastCount: number | null;
  requestedPodcastPercent: number | null;
  actualPodcastPercent: number | null;
  mixDeviationPoints: number | null;
  mixQualityPassed: boolean | null;
  podcastShortfallMs: number | null;
  musicShortfallMs: number | null;
  qualityReason: string | null;
  unfilledSlots: number | null;
  poolExhausted: boolean | null;
  error: string | null;
};

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readSimulationTargets(summary: unknown): SimulationTargetSummary[] {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return [];
  const targets = (summary as Record<string, unknown>).targets;
  if (!Array.isArray(targets)) return [];

  return targets.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.name !== "string") return [];

    return [
      {
        targetPlaylistId:
          typeof value.targetPlaylistId === "string" ? value.targetPlaylistId : null,
        name: value.name,
        planned: numberValue(value.planned),
        totalMinutes: numberValue(value.totalMinutes),
        calendarEventCount: numberValue(value.calendarEventCount),
        calendarTimedEventCount: numberValue(value.calendarTimedEventCount),
        calendarEventFilterMode:
          value.calendarEventFilterMode === "ALL" || value.calendarEventFilterMode === "MARKER"
            ? value.calendarEventFilterMode
            : null,
        calendarEventMarker:
          typeof value.calendarEventMarker === "string" ? value.calendarEventMarker : null,
        calendarDurationMinutes: numberValue(value.calendarDurationMinutes),
        calendarMaxEventDurationMinutes: numberValue(value.calendarMaxEventDurationMinutes),
        podcastEpisodeMaxDurationMode:
          value.podcastEpisodeMaxDurationMode === "NONE" ||
          value.podcastEpisodeMaxDurationMode === "FIXED" ||
          value.podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT"
            ? value.podcastEpisodeMaxDurationMode
            : null,
        podcastEpisodeMaxDurationMinutes: numberValue(
          value.podcastEpisodeMaxDurationMinutes,
        ),
        podcastDurationExceededCount: numberValue(value.podcastDurationExceededCount),
        compositionMode:
          value.compositionMode === "PROPORTION" || value.compositionMode === "SEQUENCE"
            ? value.compositionMode
            : null,
        musicOrderMode:
          value.musicOrderMode === "STANDARD" || value.musicOrderMode === "RANDOMIZED"
            ? value.musicOrderMode
            : null,
        musicOrderSeed:
          typeof value.musicOrderSeed === "string" ? value.musicOrderSeed : null,
        musicOrderSeedSource:
          value.musicOrderSeedSource === "RUN" || value.musicOrderSeedSource === "SIMULATION"
            ? value.musicOrderSeedSource
            : null,
        musicOrderHash:
          typeof value.musicOrderHash === "string" ? value.musicOrderHash : null,
        musicOrderChanged: booleanValue(value.musicOrderChanged),
        compositionQualityPassed: booleanValue(value.compositionQualityPassed),
        sequencePattern: Array.isArray(value.sequencePattern)
          ? value.sequencePattern.filter(
              (entry): entry is "MUSIC" | "PODCAST" =>
                entry === "MUSIC" || entry === "PODCAST",
            )
          : [],
        sequenceSlotsRequested: numberValue(value.sequenceSlotsRequested),
        sequenceSlotsFilled: numberValue(value.sequenceSlotsFilled),
        sequenceUnfilledSlots: numberValue(value.sequenceUnfilledSlots),
        completedCycles: numberValue(value.completedCycles),
        finalPartialCycleSlots: numberValue(value.finalPartialCycleSlots),
        stoppedAtPatternIndex: numberValue(value.stoppedAtPatternIndex),
        sequenceQualityPassed: booleanValue(value.sequenceQualityPassed),
        sequenceStopReason:
          typeof value.sequenceStopReason === "string" ? value.sequenceStopReason : null,
        musicCount: numberValue(value.musicCount),
        podcastCount: numberValue(value.podcastCount),
        requestedPodcastPercent: numberValue(value.requestedPodcastPercent),
        actualPodcastPercent: numberValue(value.actualPodcastPercent),
        mixDeviationPoints: numberValue(value.mixDeviationPoints),
        mixQualityPassed: booleanValue(value.mixQualityPassed),
        podcastShortfallMs: numberValue(value.podcastShortfallMs),
        musicShortfallMs: numberValue(value.musicShortfallMs),
        qualityReason:
          typeof value.qualityReason === "string" ? value.qualityReason : null,
        unfilledSlots: numberValue(value.unfilledSlots),
        poolExhausted: booleanValue(value.poolExhausted),
        error: typeof value.error === "string" ? value.error : null,
      },
    ];
  });
}

function readSkipped(summary: unknown): string[] {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return [];
  const skipped = (summary as Record<string, unknown>).skipped;
  return Array.isArray(skipped)
    ? skipped.filter((value): value is string => typeof value === "string")
    : [];
}

function readGenericPodcastSuppressedCount(summary: unknown): number {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return 0;
  const value = numberValue(
    (summary as Record<string, unknown>).genericPodcastSuppressedCount,
  );
  return value === null ? 0 : Math.max(0, Math.trunc(value));
}

function readMusicUnavailableSkippedCount(summary: unknown): number {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return 0;
  const value = numberValue(
    (summary as Record<string, unknown>).musicUnavailableSkippedCount,
  );
  return value === null ? 0 : Math.max(0, Math.trunc(value));
}

function readQualityPassed(summary: unknown): boolean | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  return booleanValue((summary as Record<string, unknown>).qualityPassed);
}

function durationLabel(seconds: number | null) {
  if (!seconds) return "Duração fixa inválida";
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} ${hours === 1 ? "hora" : "horas"}`;
  }
  return `${Math.round(seconds / 60)} minutos`;
}

function emptyBehaviorLabel(value: "CLEAR" | "KEEP" | "SKIP") {
  if (value === "CLEAR") return "esvaziar playlist";
  if (value === "KEEP") return "manter playlist";
  return "não tocar na playlist";
}

function configuredPodcastDurationLabel(target: {
  podcastEpisodeMaxDurationMode: "NONE" | "FIXED" | "CALENDAR_MAX_EVENT";
  podcastEpisodeMaxDurationSeconds: number | null;
}) {
  if (target.podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT") {
    return "máximo por episódio = maior evento elegível";
  }
  if (target.podcastEpisodeMaxDurationMode === "FIXED") {
    return `máximo por episódio = ${Math.round(
      (target.podcastEpisodeMaxDurationSeconds ?? 0) / 60,
    )} min`;
  }
  return "sem máximo de duração por episódio";
}

function minutesFromMs(ms: number | null) {
  return ms && ms > 0 ? Math.round(ms / 60000) : 0;
}

function sourceLabel(source: {
  name: string | null;
  spotifyType: "PLAYLIST" | "SHOW" | "SAVED_EPISODES";
}) {
  if (source.spotifyType === "SAVED_EPISODES") return "Seus episódios";
  if (source.name) return source.name;
  return source.spotifyType === "SHOW" ? "Programa do Spotify" : "Playlist do Spotify";
}

export default async function ConfigurationReviewPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const params = await searchParams;
  const assessment = await assessConfiguration(session.user.id);
  const gate = await getFirstRunGate(session.user.id, assessment);

  const simulation = params.run
    ? await prisma.generationRun.findFirst({
        where: {
          id: params.run,
          userId: session.user.id,
          simulation: true,
        },
        select: {
          id: true,
          status: true,
          startedAt: true,
          finishedAt: true,
          error: true,
          summary: true,
          logs: {
            orderBy: { createdAt: "asc" },
            select: { level: true, message: true },
          },
          items: {
            orderBy: { position: "asc" },
            select: {
              targetPlaylistId: true,
              position: true,
              contentType: true,
              title: true,
            },
          },
        },
      })
    : null;

  const simulatedTargets = readSimulationTargets(simulation?.summary);
  const simulatedOrderByTargetId = new Map<
    string,
    Array<{ position: number; type: "MUSIC" | "PODCAST"; title: string }>
  >();
  for (const item of simulation?.items ?? []) {
    const current = simulatedOrderByTargetId.get(item.targetPlaylistId) ?? [];
    current.push({
      position: item.position,
      type: item.contentType,
      title: item.title ?? "Item sem título",
    });
    simulatedOrderByTargetId.set(item.targetPlaylistId, current);
  }
  const skippedTargets = readSkipped(simulation?.summary);
  const simulationQualityPassed = readQualityPassed(simulation?.summary);
  const musicUnavailableSkippedCount = readMusicUnavailableSkippedCount(
    simulation?.summary,
  );
  const genericPodcastSuppressedCount = readGenericPodcastSuppressedCount(
    simulation?.summary,
  );
  const inconclusiveSimulation = readInconclusiveSimulation(simulation?.summary);
  const ready = assessment.issues.length === 0;
  const healthySimulation =
    simulation?.status === "SUCCESS" && simulationQualityPassed === true;
  const generalStateHealthy = ready && !inconclusiveSimulation;

  return (
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />

      <div className="relative mx-auto max-w-5xl space-y-6">
        <Link href="/dashboard/configuracao" className="product-link">
          <UiIcon name="arrow-left" size={18} />
          Central de configuração
        </Link>

        <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-black uppercase tracking-[0.17em] text-accent-400">
              CONFIG-04
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
              Revisar e testar
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-inverse sm:text-base">
              Confira tudo o que o Sonoriza vai usar. A simulação monta o plano e registra o resultado, mas não altera nenhuma playlist no Spotify.
            </p>
          </div>
          <div className="product-badge max-w-full px-4 py-3">
            <div className="min-w-0">
              <p className="font-black text-ink-inverse">Conta atual</p>
              <p className="mt-1 truncate">{session.user.email}</p>
            </div>
          </div>
        </header>

        <section
          className={`rounded-[1.75rem] border p-5 sm:p-6 ${
            generalStateHealthy ? "status-success" : "status-warning"
          }`}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <UiIcon
                  name={generalStateHealthy ? "check" : "warning"}
                  size={18}
                />
                <p className="text-xs font-black uppercase tracking-[0.15em]">
                  Estado geral
                </p>
              </div>
              <h2 className="mt-2 text-xl font-black">
                {!ready
                  ? "Existem pendências antes da simulação"
                  : inconclusiveSimulation
                    ? "Configuração válida · simulação inconclusiva"
                    : "Pronto para simular"}
              </h2>
              <p className="mt-2 text-sm leading-6 opacity-80">
                {ready
                  ? gate.realRunAllowed && gate.requiresSimulation
                    ? "A simulação atual corresponde à configuração e atendeu às regras de composição. A primeira geração real está liberada."
                    : gate.requiresSimulation
                      ? gate.reason
                      : "Esta conta já possui uma geração real controlada bem-sucedida."
                  : "Corrija os itens abaixo; a simulação e a primeira execução real permanecem bloqueadas até lá."}
              </p>
            </div>
            <ReviewSimulationButton disabled={!ready} />
          </div>
        </section>

        {assessment.issues.length > 0 && (
          <section className="status-warning rounded-[1.75rem] border p-5 sm:p-6">
            <div className="flex items-center gap-2">
              <UiIcon name="warning" size={18} />
              <p className="text-xs font-black uppercase tracking-[0.15em]">
                Pendências
              </p>
            </div>
            <h2 className="mt-2 text-xl font-black">Antes de testar, ajuste estes pontos</h2>
            <div className="mt-4 space-y-3">
              {assessment.issues.map((issue) => (
                <div
                  key={issue.code}
                  className="flex flex-col gap-3 rounded-2xl border border-warning/20 bg-canvas-dark/20 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <p className="text-sm font-semibold leading-6">{issue.message}</p>
                  <Link href={issue.href} className="shrink-0 product-link">
                    Corrigir
                    <UiIcon name="arrow-right" size={16} />
                  </Link>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="grid gap-5 md:grid-cols-2">
          <section className="product-panel p-5 sm:p-6">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
              Conexões
            </p>
            <h2 className="mt-1 text-xl font-black text-ink-inverse">Contas conectadas</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="product-card p-4">
                <p className="font-black text-ink-inverse">Google Agenda</p>
                <div
                  className={`mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black ${
                    assessment.hasGoogle ? "status-success" : "status-warning"
                  }`}
                >
                  <UiIcon name={assessment.hasGoogle ? "check" : "warning"} size={14} />
                  {assessment.hasGoogle ? "Conectado" : "Pendente"}
                </div>
              </div>
              <div className="product-card p-4">
                <p className="font-black text-ink-inverse">Spotify</p>
                <div
                  className={`mt-2 inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-black ${
                    assessment.hasSpotify ? "status-success" : "status-warning"
                  }`}
                >
                  <UiIcon name={assessment.hasSpotify ? "check" : "warning"} size={14} />
                  {assessment.hasSpotify ? "Conectado" : "Pendente"}
                </div>
                {assessment.hasSpotify && (
                  <p
                    className={`mt-2 text-xs font-semibold ${
                      assessment.hasSpotifyPlaybackScope
                        ? "text-success"
                        : "text-warning"
                    }`}
                  >
                    {assessment.hasSpotifyPlaybackScope
                      ? "Progresso de podcasts disponível"
                      : "Reconexão necessária para progresso de podcasts"}
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="product-panel p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
                  Calendários
                </p>
                <h2 className="mt-1 text-xl font-black text-ink-inverse">
                  Tempo e calendário
                </h2>
              </div>
              <Link href="/dashboard/configuracao/calendarios" className="product-link">
                Editar
                <UiIcon name="arrow-right" size={16} />
              </Link>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {assessment.calendars.length > 0 ? (
                assessment.calendars.map((calendar) => (
                  <span key={calendar.id} className="product-badge">
                    <UiIcon name="calendar" size={14} />
                    {calendar.summary ?? "Calendário"}
                    {calendar.usedForDuration ? " · duração" : ""}
                  </span>
                ))
              ) : (
                <p className="text-sm text-muted-inverse">Nenhum calendário selecionado.</p>
              )}
            </div>
          </section>
        </div>

        <section className="product-panel p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
                Fontes
              </p>
              <h2 className="mt-1 text-xl font-black text-ink-inverse">
                Conteúdo que alimenta o Sonoriza
              </h2>
            </div>
            <Link href="/dashboard/configuracao/fontes" className="product-link">
              Editar
              <UiIcon name="arrow-right" size={16} />
            </Link>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {(["MUSIC", "PODCAST"] as const).map((kind) => {
              const entries = assessment.sources.filter((source) => source.kind === kind);
              return (
                <div key={kind} className="product-card p-4">
                  <div className="flex items-center gap-2">
                    <UiIcon name="music" size={17} className="text-brand-400" />
                    <p className="font-black text-ink-inverse">
                      {kind === "MUSIC" ? "Música" : "Podcasts"}
                    </p>
                  </div>
                  <div className="mt-3 space-y-3">
                    {entries.length > 0 ? (
                      entries.map((source) => (
                        <div key={source.id}>
                          <p className="text-sm text-ink-inverse/90">{sourceLabel(source)}</p>
                          {kind === "PODCAST" && (
                            <p className="mt-1 text-xs leading-5 text-muted-inverse">
                              {source.includePlayed
                                ? "inclui episódios já concluídos"
                                : "somente não concluídos · episódios em andamento usam o tempo restante"}
                              {source.spotifyType === "SHOW"
                                ? ` · ${
                                    source.episodeOrder === "NEWEST_FIRST"
                                      ? "mais novos primeiro"
                                      : source.episodeOrder === "OLDEST_FIRST"
                                        ? "mais antigos primeiro"
                                        : "ordem legada do Spotify"
                                  } · prioridade sobre fontes genéricas`
                                : ""}
                            </p>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-inverse">Nenhuma fonte ativa.</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="product-panel p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
                Destinos
              </p>
              <h2 className="mt-1 text-xl font-black text-ink-inverse">
                Ordem e regras de geração
              </h2>
            </div>
            <Link href="/dashboard/configuracao/destinos" className="product-link">
              Editar
              <UiIcon name="arrow-right" size={16} />
            </Link>
          </div>

          <div className="mt-4 space-y-3">
            {assessment.targets.length > 0 ? (
              assessment.targets.map((target, index) => (
                <article key={target.id} className="product-card p-4 sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs font-black uppercase tracking-[0.12em] text-accent-400">
                        {index + 1}ª na geração
                      </p>
                      <h3 className="mt-1 text-lg font-black text-ink-inverse">{target.name}</h3>
                    </div>
                    <span className="status-success inline-flex w-fit items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-black">
                      <UiIcon name="check" size={13} />
                      Ativa
                    </span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-muted-inverse">
                    {target.durationMode === "CALENDAR"
                      ? `Baseada no calendário · ${
                          target.calendarEventFilterMode === "MARKER"
                            ? `marcador ${target.calendarEventMarker ?? "não informado"}`
                            : "todos os eventos"
                        }`
                      : `Duração fixa: ${durationLabel(target.fixedDurationSeconds)}`}
                    {target.durationMode === "CALENDAR"
                      ? ` · sem evento elegível: ${emptyBehaviorLabel(
                          target.emptyCalendarBehavior,
                        )}`
                      : ""}
                    {target.compositionMode === "PROPORTION"
                      ? ` · Por proporção: ${target.podcastPercent}% podcast / ${
                          100 - target.podcastPercent
                        }% música`
                      : " · Por sequência"}
                    {` · ${configuredPodcastDurationLabel(target)}`}
                    {` · músicas: ${
                      target.musicOrderMode === "RANDOMIZED"
                        ? "ordem randomizada"
                        : "ordem padrão"
                    }`}
                  </p>
                  {target.compositionMode === "SEQUENCE" && (
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-inverse">
                      <span>Ciclo:</span>
                      {target.sequence.map((entry, sequenceIndex) => (
                        <span
                          key={`${target.id}-${sequenceIndex}`}
                          className="product-badge px-2.5 py-1"
                        >
                          {entry === "MUSIC" ? "Música" : "Podcast"}
                        </span>
                      ))}
                      <span>
                        · máximo {target.maxEpisodesPerProgram}{" "}
                        {target.maxEpisodesPerProgram === 1 ? "episódio" : "episódios"} do mesmo programa
                      </span>
                    </div>
                  )}
                </article>
              ))
            ) : (
              <p className="text-sm text-muted-inverse">Nenhum destino ativo.</p>
            )}
          </div>
        </section>

        {simulation && (
          <section
            className={`rounded-[1.75rem] border p-5 sm:p-6 ${
              healthySimulation ? "status-success" : "status-warning"
            }`}
          >
            <div className="flex items-center gap-2">
              <UiIcon name={healthySimulation ? "check" : "warning"} size={18} />
              <p className="text-xs font-black uppercase tracking-[0.15em]">
                Resultado da simulação
              </p>
            </div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-xl font-black">
                {inconclusiveSimulation
                  ? inconclusiveSimulation.title
                  : simulation.status !== "SUCCESS"
                    ? `Simulação: ${simulation.status}`
                    : healthySimulation
                      ? "Simulação concluída · regras atendidas"
                      : "Simulação concluída · ajuste necessário"}
              </h2>
              <span className="rounded-full border border-current/20 bg-canvas-dark/20 px-3 py-1.5 text-xs font-bold">
                {new Intl.DateTimeFormat("pt-BR", {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(simulation.startedAt)}
              </span>
            </div>
            <p className="mt-2 text-sm font-semibold">
              Nada foi aplicado ao Spotify.
            </p>

            {inconclusiveSimulation ? (
              <div className="mt-4 space-y-4 rounded-2xl border border-warning/25 bg-canvas-dark/20 p-4 sm:p-5">
                <div>
                  <p className="font-black">{inconclusiveSimulation.reasonLabel}</p>
                  <p className="mt-1 text-sm leading-6 opacity-80">
                    {inconclusiveSimulation.message}
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric
                    label="Fontes configuradas"
                    value={inconclusiveSimulation.configuredSourceCount}
                  />
                  <Metric
                    label="Confirmadas"
                    value={inconclusiveSimulation.confirmedSourceCount}
                    tone="success"
                  />
                  <Metric
                    label="Indisponíveis"
                    value={inconclusiveSimulation.unavailableSourceCount}
                    tone="warning"
                  />
                  <Metric
                    label="Não verificadas"
                    value={inconclusiveSimulation.notAttemptedSourceCount}
                  />
                </div>

                {!inconclusiveSimulation.countsExact &&
                  inconclusiveSimulation.notAttemptedSourceCount > 0 && (
                    <p className="text-xs leading-5 opacity-70">
                      Este resultado foi registrado antes do detalhamento por fonte. A quantidade de fontes não verificadas foi reconstruída pelos totais conhecidos; uma nova simulação passa a registrar cada estado individualmente.
                    </p>
                  )}

                {inconclusiveSimulation.sourceDiagnostics.length > 0 && (
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.1em]">
                      Diagnóstico das fontes
                    </p>
                    <div className="mt-2 space-y-2">
                      {inconclusiveSimulation.sourceDiagnostics.map((diagnostic, index) => {
                        const toneClass =
                          diagnostic.state === "CONFIRMED"
                            ? "status-success"
                            : diagnostic.state === "UNAVAILABLE"
                              ? "status-warning"
                              : "border-line-dark/45 bg-canvas-dark/20 text-ink-inverse";
                        return (
                          <article
                            key={`${diagnostic.source}-${diagnostic.state}-${index}`}
                            className={`rounded-xl border p-3 ${toneClass}`}
                          >
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <p className="text-sm font-black">{diagnostic.source}</p>
                              <span className="w-fit rounded-full border border-current/20 px-2.5 py-1 text-xs font-black">
                                {diagnostic.stateLabel}
                              </span>
                            </div>
                            <p className="mt-2 text-sm leading-6 opacity-80">
                              {diagnostic.detail}
                            </p>
                          </article>
                        );
                      })}
                    </div>
                  </div>
                )}

                {!inconclusiveSimulation.countsExact &&
                  inconclusiveSimulation.notAttemptedSourceCount > 0 && (
                    <div className="status-info rounded-xl border p-3">
                      <p className="text-sm font-black">Qual fonte ficou sem tentativa?</p>
                      <p className="mt-1 text-sm leading-6 opacity-80">
                        O run anterior não gravou essa identidade. A próxima simulação registrará pelo nome quais fontes foram confirmadas, quais falharam e quais não chegaram a ser verificadas.
                      </p>
                    </div>
                  )}

                <div className="status-info rounded-xl border p-3">
                  <p className="text-sm font-black">A configuração não foi reprovada.</p>
                  <p className="mt-1 text-sm leading-6 opacity-80">
                    O planner não avaliou composição, disponibilidade ou esgotamento usando um pool parcial. A primeira geração real continua bloqueada até uma simulação conclusiva.
                  </p>
                </div>

                <p className="text-sm font-semibold leading-6">
                  {inconclusiveSimulation.retryHint}
                </p>

                {inconclusiveSimulation.canRetryFromCard && (
                  <ReviewSimulationButton
                    label="Tentar simulação novamente"
                    runningLabel="Tentando novamente…"
                  />
                )}
              </div>
            ) : (
              <>
                {simulation.error && (
                  <p className="status-danger mt-3 rounded-2xl border p-4 text-sm">
                    {simulation.error}
                  </p>
                )}

                {simulation.status === "SUCCESS" && simulationQualityPassed === false && (
                  <div className="status-warning mt-4 rounded-2xl border p-4">
                    <p className="font-black">Primeira geração real bloqueada</p>
                    <p className="mt-1 text-sm leading-6 opacity-80">
                      O plano conseguiu ser montado, mas ficou materialmente diferente da regra de composição configurada. Ajuste fontes ou limites e simule novamente.
                    </p>
                  </div>
                )}

                {genericPodcastSuppressedCount > 0 && (
                  <div className="status-info mt-4 rounded-2xl border p-4">
                    <p className="font-black">
                      {genericPodcastSuppressedCount}{" "}
                      {genericPodcastSuppressedCount === 1
                        ? "episódio genérico suprimido"
                        : "episódios genéricos suprimidos"}{" "}
                      por regra de programa
                    </p>
                    <p className="mt-1 text-sm leading-6 opacity-80">
                      Quando um programa está configurado como fonte específica, a política desse SHOW prevalece sobre “Seus episódios” e playlists genéricas do mesmo programa.
                    </p>
                  </div>
                )}

                {musicUnavailableSkippedCount > 0 && (
                  <div className="status-warning mt-4 rounded-2xl border p-4">
                    <p className="font-black">
                      {musicUnavailableSkippedCount}{" "}
                      {musicUnavailableSkippedCount === 1
                        ? "música ignorada"
                        : "músicas ignoradas"}{" "}
                      por indisponibilidade
                    </p>
                    <p className="mt-1 text-sm leading-6 opacity-80">
                      Essas faixas não contam para sequência, duração, percentual de música ou quality gate porque o Spotify as marcou como indisponíveis para reprodução no contexto atual.
                    </p>
                  </div>
                )}

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {simulatedTargets.map((target) => (
                    <article
                      key={target.name}
                      className={`rounded-2xl border p-4 ${
                        target.compositionQualityPassed === false
                          ? "status-warning"
                          : "border-line-dark/55 bg-canvas-dark/20 text-ink-inverse"
                      }`}
                    >
                      <h3 className="font-black">{target.name}</h3>
                      {target.error ? (
                        <p className="status-danger mt-2 rounded-xl border p-3 text-sm">
                          {target.error}
                        </p>
                      ) : (
                        <>
                          <p className="mt-2 text-sm leading-6 opacity-80">
                            {target.planned ?? 0} itens · {target.totalMinutes ?? 0} min
                            {target.musicCount !== null
                              ? ` · ${target.musicCount} músicas`
                              : ""}
                            {target.podcastCount !== null
                              ? ` · ${target.podcastCount} podcasts`
                              : ""}
                          </p>
                          {target.musicOrderMode === "RANDOMIZED" && (
                            <div className="status-info mt-3 rounded-xl border p-3 text-xs leading-5">
                              <p className="font-black">Músicas randomizadas nesta simulação</p>
                              <p className="mt-1 opacity-80">
                                Seed: <code>{target.musicOrderSeed ?? "indisponível"}</code>
                                {target.musicOrderChanged === false
                                  ? " · a ordem coincidiu com a original nesta execução"
                                  : ""}
                              </p>
                              {target.targetPlaylistId &&
                                (simulatedOrderByTargetId.get(target.targetPlaylistId)?.length ?? 0) > 0 && (
                                  <details className="mt-2">
                                    <summary className="cursor-pointer font-black">
                                      Ver ordem simulada ({simulatedOrderByTargetId.get(target.targetPlaylistId)!.length} itens)
                                    </summary>
                                    <ol className="mt-2 space-y-1">
                                      {simulatedOrderByTargetId.get(target.targetPlaylistId)!.map((item) => (
                                        <li key={`${item.position}-${item.type}-${item.title}`}>
                                          {item.position + 1}. {item.type === "MUSIC" ? "M" : "P"} · {item.title}
                                        </li>
                                      ))}
                                    </ol>
                                    {target.musicOrderHash && (
                                      <p className="mt-2 opacity-65">
                                        Hash da ordem: <code>{target.musicOrderHash}</code>
                                      </p>
                                    )}
                                  </details>
                                )}
                            </div>
                          )}
                          {target.calendarDurationMinutes !== null && (
                            <p className="mt-2 text-xs font-semibold leading-5 opacity-70">
                              {target.calendarEventCount ?? 0} eventos considerados
                              {target.calendarEventFilterMode === "MARKER" &&
                              target.calendarEventMarker
                                ? ` com ${target.calendarEventMarker}`
                                : ""}
                              {target.calendarTimedEventCount !== null
                                ? ` de ${target.calendarTimedEventCount} eventos com horário`
                                : ""}
                              {` · ${target.calendarDurationMinutes} min calculados pelo calendário`}
                              {target.calendarMaxEventDurationMinutes !== null
                                ? ` · maior janela ${target.calendarMaxEventDurationMinutes} min`
                                : ""}
                            </p>
                          )}
                          {target.podcastEpisodeMaxDurationMode && (
                            <p className="mt-2 text-xs font-semibold leading-5 opacity-70">
                              {target.podcastEpisodeMaxDurationMode === "NONE"
                                ? "Podcasts: sem limite de duração por episódio"
                                : target.podcastEpisodeMaxDurationMinutes !== null
                                  ? `Podcasts: limite efetivo de ${target.podcastEpisodeMaxDurationMinutes} min por episódio`
                                  : "Podcasts: limite efetivo não aplicável nesta execução"}
                              {target.podcastDurationExceededCount !== null
                                ? ` · ${target.podcastDurationExceededCount} ${
                                    target.podcastDurationExceededCount === 1
                                      ? "episódio descartado"
                                      : "episódios descartados"
                                  } por duração`
                                : ""}
                            </p>
                          )}
                          {target.compositionMode !== "SEQUENCE" &&
                            target.requestedPodcastPercent !== null &&
                            target.actualPodcastPercent !== null && (
                              <div className="mt-3 rounded-xl border border-line-dark/45 bg-canvas-dark/20 p-3 text-sm">
                                <p>
                                  Meta: <strong>{target.requestedPodcastPercent}% podcast</strong> · Planejado:{" "}
                                  <strong>{target.actualPodcastPercent}% podcast</strong>
                                </p>
                                {target.mixQualityPassed === true ? (
                                  <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-success">
                                    <UiIcon name="check" size={13} />
                                    Dentro da tolerância de 10 pontos percentuais
                                  </p>
                                ) : target.mixQualityPassed === false ? (
                                  <p className="mt-1 text-xs font-bold text-warning">
                                    Meta não atendida
                                    {target.mixDeviationPoints !== null
                                      ? ` · desvio de ${target.mixDeviationPoints} p.p.`
                                      : ""}
                                  </p>
                                ) : null}
                              </div>
                            )}
                          {target.compositionMode === "SEQUENCE" && (
                            <div className="mt-3 rounded-xl border border-line-dark/45 bg-canvas-dark/20 p-3 text-sm">
                              <p className="font-black">
                                Ciclo:{" "}
                                {target.sequencePattern
                                  .map((entry) => (entry === "MUSIC" ? "M" : "P"))
                                  .join(" → ") || "não informado"}
                              </p>
                              <p className="mt-1 text-xs leading-5 opacity-75">
                                {target.completedCycles ?? 0} ciclos completos
                                {target.finalPartialCycleSlots
                                  ? ` · ciclo final com ${target.finalPartialCycleSlots} slots preenchidos`
                                  : ""}
                                {target.sequenceUnfilledSlots
                                  ? ` · ${target.sequenceUnfilledSlots} slot não preenchido`
                                  : ""}
                              </p>
                              {target.actualPodcastPercent !== null && (
                                <p className="mt-1 text-xs opacity-70">
                                  Resultado por duração: {target.actualPodcastPercent}% podcast /{" "}
                                  {100 - target.actualPodcastPercent}% música. Esse percentual é apenas informativo.
                                </p>
                              )}
                              {target.sequenceStopReason &&
                                target.sequenceStopReason !== "TARGET_REACHED" && (
                                  <p className="mt-1 text-xs font-semibold text-warning">
                                    Interrupção:{" "}
                                    {target.sequenceStopReason === "NO_FITTING_CANDIDATE"
                                      ? "o próximo tipo não tinha item que coubesse no tempo restante"
                                      : "não havia candidato elegível para o próximo tipo"}
                                    .
                                  </p>
                                )}
                            </div>
                          )}
                        </>
                      )}
                      {target.qualityReason && target.compositionQualityPassed === false && (
                        <p className="mt-2 text-xs font-semibold leading-5 text-warning">
                          {target.qualityReason}.
                        </p>
                      )}
                      {minutesFromMs(target.podcastShortfallMs) > 0 && (
                        <p className="mt-1 text-xs text-warning">
                          Faltaram aproximadamente {minutesFromMs(target.podcastShortfallMs)} min de podcast para a meta.
                        </p>
                      )}
                      {target.poolExhausted && (
                        <p className="mt-2 text-xs font-semibold text-warning">
                          As fontes de conteúdo terminaram antes de preencher todo o tempo planejado.
                        </p>
                      )}
                      {(target.unfilledSlots ?? 0) > 0 && (
                        <p className="mt-1 text-xs text-warning">
                          {target.unfilledSlots} posições da sequência ficaram sem conteúdo.
                        </p>
                      )}
                    </article>
                  ))}
                </div>

                {skippedTargets.length > 0 && (
                  <p className="mt-4 text-sm opacity-80">
                    Sem alteração nesta simulação: {skippedTargets.join(", ")}.
                  </p>
                )}
              </>
            )}

            {simulation.logs.some(
              (log) => log.level === "WARN" || log.level === "ERROR",
            ) && (
              <details className="mt-4 rounded-2xl border border-current/20 bg-canvas-dark/20 p-4">
                <summary className="cursor-pointer font-black">
                  Avisos técnicos da simulação
                </summary>
                <div className="mt-3 space-y-2 text-sm opacity-80">
                  {simulation.logs
                    .filter((log) => log.level === "WARN" || log.level === "ERROR")
                    .map((log, index) => (
                      <p key={`${log.level}-${index}`}>
                        {log.level === "ERROR" ? "Erro" : "Aviso"}: {log.message}
                      </p>
                    ))}
                </div>
              </details>
            )}

            {!inconclusiveSimulation &&
            simulation.status === "SUCCESS" &&
            gate.realRunAllowed ? (
              <Link
                href="/dashboard"
                className="status-success mt-5 inline-flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-black"
              >
                Primeira geração liberada · voltar ao painel
                <UiIcon name="arrow-right" size={16} />
              </Link>
            ) : !inconclusiveSimulation && simulation.status === "SUCCESS" ? (
              <Link
                href="/dashboard/configuracao/fontes"
                className="status-warning mt-5 inline-flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm font-black"
              >
                Ajustar fontes e simular novamente
                <UiIcon name="arrow-right" size={16} />
              </Link>
            ) : null}
          </section>
        )}
      </div>
    </main>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "success" | "warning";
}) {
  const toneClass =
    tone === "success"
      ? "border-success/20 text-success"
      : tone === "warning"
        ? "border-warning/20 text-warning"
        : "border-line-dark/45 text-ink-inverse";

  return (
    <div className={`rounded-xl border bg-canvas-dark/20 p-3 ${toneClass}`}>
      <p className="text-xs font-black uppercase tracking-[0.1em] opacity-70">{label}</p>
      <p className="mt-1 text-xl font-black">{value}</p>
    </div>
  );
}
