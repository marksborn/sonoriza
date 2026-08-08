import Link from "next/link";
import { redirect } from "next/navigation";

import { ReviewSimulationButton } from "@/components/ReviewSimulationButton";
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
        },
      })
    : null;

  const simulatedTargets = readSimulationTargets(simulation?.summary);
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
    <main className="relative min-h-screen overflow-hidden bg-[#0b021f] px-5 py-8 text-white sm:px-8 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_5%,rgba(126,34,206,0.3),transparent_31rem),radial-gradient(circle_at_90%_10%,rgba(255,107,0,0.12),transparent_25rem),linear-gradient(180deg,#12032f_0%,#0b021f_55%,#090119_100%)]" />

      <div className="relative mx-auto max-w-5xl space-y-6">
        <Link
          href="/dashboard/configuracao"
          className="inline-flex items-center gap-2 text-sm font-bold text-violet-300 transition hover:text-white"
        >
          <span aria-hidden="true">←</span>
          Central de configuração
        </Link>

        <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-black uppercase tracking-[0.17em] text-orange-400">CONFIG-04</p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">Revisar e testar</h1>
            <p className="mt-3 text-sm leading-6 text-violet-200/75 sm:text-base">
              Confira tudo o que o Sonoriza vai usar. A simulação monta o plano e registra o resultado, mas não altera nenhuma playlist no Spotify.
            </p>
          </div>
          <div className="rounded-2xl border border-violet-400/20 bg-violet-950/45 px-4 py-3 text-sm">
            <p className="font-black text-white">Conta atual</p>
            <p className="mt-1 text-violet-200/75">{session.user.email}</p>
          </div>
        </header>

        <section
          className={`rounded-[1.75rem] border p-5 sm:p-6 ${
            generalStateHealthy
              ? "border-emerald-400/25 bg-emerald-950/20"
              : "border-orange-400/25 bg-orange-950/15"
          }`}
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className={`text-xs font-black uppercase tracking-[0.15em] ${generalStateHealthy ? "text-emerald-300" : "text-orange-300"}`}>
                Estado geral
              </p>
              <h2 className="mt-1 text-xl font-black">
                {!ready
                  ? "Existem pendências antes da simulação"
                  : inconclusiveSimulation
                    ? "Configuração válida · simulação inconclusiva"
                    : "Pronto para simular"}
              </h2>
              <p className="mt-2 text-sm text-violet-100/70">
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
          <section className="rounded-[1.75rem] border border-orange-400/25 bg-[linear-gradient(145deg,rgba(70,26,14,0.5),rgba(32,8,55,0.9))] p-5 sm:p-6">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-orange-300">Pendências</p>
            <h2 className="mt-1 text-xl font-black">Antes de testar, ajuste estes pontos</h2>
            <div className="mt-4 space-y-3">
              {assessment.issues.map((issue) => (
                <div key={issue.code} className="flex flex-col gap-3 rounded-2xl border border-orange-300/15 bg-black/15 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm font-semibold leading-6 text-orange-50/90">{issue.message}</p>
                  <Link href={issue.href} className="shrink-0 text-sm font-black text-orange-300 hover:text-orange-200">
                    Corrigir →
                  </Link>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className="grid gap-5 md:grid-cols-2">
          <section className="rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.92),rgba(22,6,53,0.94))] p-5 sm:p-6">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">Conexões</p>
            <h2 className="mt-1 text-xl font-black">Contas conectadas</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-violet-400/20 bg-violet-950/35 p-4">
                <p className="font-black">Google Agenda</p>
                <p className={`mt-1 text-sm font-semibold ${assessment.hasGoogle ? "text-emerald-300" : "text-orange-300"}`}>
                  {assessment.hasGoogle ? "Conectado ✓" : "Pendente"}
                </p>
              </div>
              <div className="rounded-2xl border border-violet-400/20 bg-violet-950/35 p-4">
                <p className="font-black">Spotify</p>
                <p className={`mt-1 text-sm font-semibold ${assessment.hasSpotify ? "text-emerald-300" : "text-orange-300"}`}>
                  {assessment.hasSpotify ? "Conectado ✓" : "Pendente"}
                </p>
                {assessment.hasSpotify && (
                  <p className={`mt-1 text-xs ${assessment.hasSpotifyPlaybackScope ? "text-emerald-200/75" : "text-orange-200/80"}`}>
                    {assessment.hasSpotifyPlaybackScope
                      ? "Progresso de podcasts disponível ✓"
                      : "Reconexão necessária para progresso de podcasts"}
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.92),rgba(22,6,53,0.94))] p-5 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">Calendários</p>
                <h2 className="mt-1 text-xl font-black">Tempo e calendário</h2>
              </div>
              <Link href="/dashboard/configuracao/calendarios" className="text-sm font-black text-orange-300 hover:text-orange-200">Editar</Link>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {assessment.calendars.length > 0 ? (
                assessment.calendars.map((calendar) => (
                  <span key={calendar.id} className="rounded-full border border-violet-300/20 bg-violet-500/10 px-3 py-1.5 text-xs font-bold text-violet-100">
                    {calendar.summary ?? "Calendário"}{calendar.usedForDuration ? " · viagens" : ""}
                  </span>
                ))
              ) : (
                <p className="text-sm text-violet-200/65">Nenhum calendário selecionado.</p>
              )}
            </div>
          </section>
        </div>

        <section className="rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.92),rgba(22,6,53,0.94))] p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-orange-400">Fontes</p>
              <h2 className="mt-1 text-xl font-black">Conteúdo que alimenta o Sonoriza</h2>
            </div>
            <Link href="/dashboard/configuracao/fontes" className="text-sm font-black text-orange-300 hover:text-orange-200">Editar</Link>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {(["MUSIC", "PODCAST"] as const).map((kind) => {
              const entries = assessment.sources.filter((source) => source.kind === kind);
              return (
                <div key={kind} className="rounded-2xl border border-violet-400/20 bg-violet-950/35 p-4">
                  <p className="font-black">{kind === "MUSIC" ? "Música" : "Podcasts"}</p>
                  <div className="mt-3 space-y-3">
                    {entries.length > 0 ? entries.map((source) => (
                      <div key={source.id}>
                        <p className="text-sm text-violet-100/80">• {sourceLabel(source)}</p>
                        {kind === "PODCAST" && (
                          <p className="ml-3 mt-1 text-xs text-violet-200/55">
                            {source.includePlayed
                              ? "inclui episódios já concluídos"
                              : "somente não concluídos · episódios em andamento usam o tempo restante"}
                            {source.spotifyType === "SHOW"
                              ? ` · ${source.episodeOrder === "NEWEST_FIRST" ? "mais novos primeiro" : source.episodeOrder === "OLDEST_FIRST" ? "mais antigos primeiro" : "ordem legada do Spotify"} · prioridade sobre fontes genéricas`
                              : ""}
                          </p>
                        )}
                      </div>
                    )) : <p className="text-sm text-violet-200/55">Nenhuma fonte ativa.</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.92),rgba(22,6,53,0.94))] p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">Destinos</p>
              <h2 className="mt-1 text-xl font-black">Ordem e regras de geração</h2>
            </div>
            <Link href="/dashboard/configuracao/destinos" className="text-sm font-black text-orange-300 hover:text-orange-200">Editar</Link>
          </div>

          <div className="mt-4 space-y-3">
            {assessment.targets.length > 0 ? assessment.targets.map((target, index) => (
              <article key={target.id} className="rounded-2xl border border-violet-400/20 bg-violet-950/35 p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.12em] text-orange-300">{index + 1}ª na geração</p>
                    <h3 className="mt-1 text-lg font-black">{target.name}</h3>
                  </div>
                  <span className="w-fit rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1 text-xs font-black text-emerald-300">Ativa</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-violet-100/75">
                  {target.durationMode === "CALENDAR"
                    ? `Baseada no calendário · ${target.calendarEventFilterMode === "MARKER" ? `marcador ${target.calendarEventMarker ?? "não informado"}` : "todos os eventos"}`
                    : `Duração fixa: ${durationLabel(target.fixedDurationSeconds)}`}
                  {target.durationMode === "CALENDAR" ? ` · sem evento elegível: ${emptyBehaviorLabel(target.emptyCalendarBehavior)}` : ""}
                  {target.compositionMode === "PROPORTION"
                    ? ` · Por proporção: ${target.podcastPercent}% podcast / ${100 - target.podcastPercent}% música`
                    : " · Por sequência"}
                  {` · ${configuredPodcastDurationLabel(target)}`}
                </p>
                {target.compositionMode === "SEQUENCE" && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-violet-200/75">
                  <span>Ciclo:</span>
                  {target.sequence.map((entry, sequenceIndex) => (
                    <span key={`${target.id}-${sequenceIndex}`} className="rounded-full border border-violet-300/20 bg-violet-500/10 px-2.5 py-1 font-bold">
                      {entry === "MUSIC" ? "Música" : "Podcast"}
                    </span>
                  ))}
                  <span>· máximo {target.maxEpisodesPerProgram} {target.maxEpisodesPerProgram === 1 ? "episódio" : "episódios"} do mesmo programa</span>
                </div>
                )}
              </article>
            )) : <p className="text-sm text-violet-200/65">Nenhum destino ativo.</p>}
          </div>
        </section>

        {simulation && (
          <section className={`rounded-[1.75rem] border p-5 sm:p-6 ${healthySimulation ? "border-emerald-400/25 bg-emerald-950/20" : "border-orange-400/25 bg-orange-950/15"}`}>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-orange-300">Resultado da simulação</p>
            <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-xl font-black">
                {inconclusiveSimulation
                  ? inconclusiveSimulation.title
                  : simulation.status !== "SUCCESS"
                    ? `Simulação: ${simulation.status}`
                    : healthySimulation
                      ? "Simulação concluída · regras atendidas"
                      : "Simulação concluída · ajuste necessário"}
              </h2>
              <span className="rounded-full border border-violet-300/20 bg-violet-950/40 px-3 py-1.5 text-xs font-bold text-violet-200">
                {new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(simulation.startedAt)}
              </span>
            </div>
            <p className="mt-2 text-sm font-semibold text-emerald-200">Nada foi aplicado ao Spotify.</p>

            {inconclusiveSimulation ? (
              <div className="mt-4 space-y-4 rounded-2xl border border-orange-300/25 bg-orange-400/10 p-4 sm:p-5">
                <div>
                  <p className="font-black text-orange-100">{inconclusiveSimulation.reasonLabel}</p>
                  <p className="mt-1 text-sm leading-6 text-orange-50/80">
                    {inconclusiveSimulation.message}
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-xl border border-orange-200/15 bg-black/15 p-3">
                    <p className="text-xs font-black uppercase tracking-[0.1em] text-orange-200/70">Fontes configuradas</p>
                    <p className="mt-1 text-xl font-black text-white">{inconclusiveSimulation.configuredSourceCount}</p>
                  </div>
                  <div className="rounded-xl border border-emerald-300/15 bg-black/15 p-3">
                    <p className="text-xs font-black uppercase tracking-[0.1em] text-emerald-200/70">Lidas com sucesso</p>
                    <p className="mt-1 text-xl font-black text-white">{inconclusiveSimulation.readSourceCount}</p>
                  </div>
                  <div className="rounded-xl border border-orange-200/15 bg-black/15 p-3">
                    <p className="text-xs font-black uppercase tracking-[0.1em] text-orange-200/70">Indisponíveis</p>
                    <p className="mt-1 text-xl font-black text-white">{inconclusiveSimulation.unavailableSourceCount}</p>
                  </div>
                </div>

                {inconclusiveSimulation.unavailableSources.length > 0 && (
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.1em] text-orange-200/70">Fontes que não puderam ser confirmadas</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {inconclusiveSimulation.unavailableSources.map((source) => (
                        <span key={source} className="rounded-full border border-orange-200/20 bg-orange-200/10 px-3 py-1.5 text-xs font-bold text-orange-50">
                          {source}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-violet-200/15 bg-black/15 p-3">
                  <p className="text-sm font-black text-violet-50">A configuração não foi reprovada.</p>
                  <p className="mt-1 text-sm leading-6 text-violet-100/70">
                    O planner não avaliou composição, disponibilidade ou esgotamento usando um pool parcial. A primeira geração real continua bloqueada até uma simulação conclusiva.
                  </p>
                </div>

                <p className="text-sm font-semibold leading-6 text-orange-100/80">
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
                {simulation.error && <p className="mt-3 rounded-2xl border border-red-400/25 bg-red-950/35 p-4 text-sm text-red-200">{simulation.error}</p>}

                {simulation.status === "SUCCESS" && simulationQualityPassed === false && (
                  <div className="mt-4 rounded-2xl border border-orange-300/25 bg-orange-400/10 p-4">
                    <p className="font-black text-orange-100">Primeira geração real bloqueada</p>
                    <p className="mt-1 text-sm leading-6 text-orange-100/75">
                      O plano conseguiu ser montado, mas ficou materialmente diferente da regra de composição configurada. Ajuste fontes ou limites e simule novamente.
                    </p>
                  </div>
                )}

                {genericPodcastSuppressedCount > 0 && (
                  <div className="mt-4 rounded-2xl border border-orange-300/20 bg-orange-400/10 p-4">
                    <p className="font-black text-orange-50">
                      {genericPodcastSuppressedCount} {genericPodcastSuppressedCount === 1 ? "episódio genérico suprimido" : "episódios genéricos suprimidos"} por regra de programa
                    </p>
                    <p className="mt-1 text-sm leading-6 text-orange-100/70">
                      Quando um programa está configurado como fonte específica, a política desse SHOW prevalece sobre “Seus episódios” e playlists genéricas do mesmo programa.
                    </p>
                  </div>
                )}

                {musicUnavailableSkippedCount > 0 && (
                  <div className="mt-4 rounded-2xl border border-violet-300/20 bg-violet-400/10 p-4">
                    <p className="font-black text-violet-50">
                      {musicUnavailableSkippedCount} {musicUnavailableSkippedCount === 1 ? "música ignorada" : "músicas ignoradas"} por indisponibilidade
                    </p>
                    <p className="mt-1 text-sm leading-6 text-violet-100/70">
                      Essas faixas não contam para sequência, duração, percentual de música ou quality gate porque o Spotify as marcou como indisponíveis para reprodução no contexto atual.
                    </p>
                  </div>
                )}

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  {simulatedTargets.map((target) => (
                    <article key={target.name} className={`rounded-2xl border p-4 ${target.compositionQualityPassed === false ? "border-orange-300/25 bg-orange-950/20" : "border-violet-300/15 bg-black/15"}`}>
                      <h3 className="font-black">{target.name}</h3>
                      {target.error ? (
                        <p className="mt-2 text-sm text-red-200">{target.error}</p>
                      ) : (
                        <>
                          <p className="mt-2 text-sm leading-6 text-violet-100/75">
                            {target.planned ?? 0} itens · {target.totalMinutes ?? 0} min
                            {target.musicCount !== null ? ` · ${target.musicCount} músicas` : ""}
                            {target.podcastCount !== null ? ` · ${target.podcastCount} podcasts` : ""}
                          </p>
                          {target.calendarDurationMinutes !== null && (
                            <p className="mt-2 text-xs font-semibold leading-5 text-violet-200/70">
                              {target.calendarEventCount ?? 0} eventos considerados
                              {target.calendarEventFilterMode === "MARKER" && target.calendarEventMarker
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
                            <p className="mt-2 text-xs font-semibold leading-5 text-violet-200/70">
                              {target.podcastEpisodeMaxDurationMode === "NONE"
                                ? "Podcasts: sem limite de duração por episódio"
                                : target.podcastEpisodeMaxDurationMinutes !== null
                                  ? `Podcasts: limite efetivo de ${target.podcastEpisodeMaxDurationMinutes} min por episódio`
                                  : "Podcasts: limite efetivo não aplicável nesta execução"}
                              {target.podcastDurationExceededCount !== null
                                ? ` · ${target.podcastDurationExceededCount} ${target.podcastDurationExceededCount === 1 ? "episódio descartado" : "episódios descartados"} por duração`
                                : ""}
                            </p>
                          )}
                          {target.compositionMode !== "SEQUENCE" && target.requestedPodcastPercent !== null && target.actualPodcastPercent !== null && (
                            <div className="mt-3 rounded-xl border border-violet-300/15 bg-black/15 p-3 text-sm">
                              <p className="text-violet-100/80">
                                Meta: <strong>{target.requestedPodcastPercent}% podcast</strong> · Planejado: <strong>{target.actualPodcastPercent}% podcast</strong>
                              </p>
                              {target.mixQualityPassed === true ? (
                                <p className="mt-1 text-xs font-bold text-emerald-300">Dentro da tolerância de 10 pontos percentuais ✓</p>
                              ) : target.mixQualityPassed === false ? (
                                <p className="mt-1 text-xs font-bold text-orange-300">
                                  Meta não atendida{target.mixDeviationPoints !== null ? ` · desvio de ${target.mixDeviationPoints} p.p.` : ""}
                                </p>
                              ) : null}
                            </div>
                          )}
                {target.compositionMode === "SEQUENCE" && (
                  <div className="mt-3 rounded-xl border border-violet-300/15 bg-black/15 p-3 text-sm">
                    <p className="font-black text-violet-100">Ciclo: {target.sequencePattern.map((entry) => entry === "MUSIC" ? "M" : "P").join(" → ") || "não informado"}</p>
                    <p className="mt-1 text-xs leading-5 text-violet-200/75">
                      {target.completedCycles ?? 0} ciclos completos
                      {target.finalPartialCycleSlots ? ` · ciclo final com ${target.finalPartialCycleSlots} slots preenchidos` : ""}
                      {target.sequenceUnfilledSlots ? ` · ${target.sequenceUnfilledSlots} slot não preenchido` : ""}
                    </p>
                    {target.actualPodcastPercent !== null && (
                      <p className="mt-1 text-xs text-violet-200/65">Resultado por duração: {target.actualPodcastPercent}% podcast / {100 - target.actualPodcastPercent}% música. Esse percentual é apenas informativo.</p>
                    )}
                    {target.sequenceStopReason && target.sequenceStopReason !== "TARGET_REACHED" && (
                      <p className="mt-1 text-xs font-semibold text-orange-200">Interrupção: {target.sequenceStopReason === "NO_FITTING_CANDIDATE" ? "o próximo tipo não tinha item que coubesse no tempo restante" : "não havia candidato elegível para o próximo tipo"}.</p>
                    )}
                  </div>
                )}
              </>
            )}
                      {target.qualityReason && target.compositionQualityPassed === false && (
                        <p className="mt-2 text-xs font-semibold leading-5 text-orange-200">{target.qualityReason}.</p>
                      )}
                      {minutesFromMs(target.podcastShortfallMs) > 0 && (
                        <p className="mt-1 text-xs text-orange-200/80">Faltaram aproximadamente {minutesFromMs(target.podcastShortfallMs)} min de podcast para a meta.</p>
                      )}
                      {target.poolExhausted && <p className="mt-2 text-xs font-semibold text-orange-300">As fontes de conteúdo terminaram antes de preencher todo o tempo planejado.</p>}
                      {(target.unfilledSlots ?? 0) > 0 && <p className="mt-1 text-xs text-orange-200/80">{target.unfilledSlots} posições da sequência ficaram sem conteúdo.</p>}
                    </article>
                  ))}
                </div>

                {skippedTargets.length > 0 && (
                  <p className="mt-4 text-sm text-violet-100/70">Sem alteração nesta simulação: {skippedTargets.join(", ")}.</p>
                )}
              </>
            )}

            {simulation.logs.some((log) => log.level === "WARN" || log.level === "ERROR") && (
              <details className="mt-4 rounded-2xl border border-violet-300/15 bg-black/15 p-4">
                <summary className="cursor-pointer font-black text-violet-100">Avisos técnicos da simulação</summary>
                <div className="mt-3 space-y-2 text-sm text-violet-200/75">
                  {simulation.logs.filter((log) => log.level === "WARN" || log.level === "ERROR").map((log, index) => (
                    <p key={`${log.level}-${index}`}>{log.level === "ERROR" ? "Erro" : "Aviso"}: {log.message}</p>
                  ))}
                </div>
              </details>
            )}

            {!inconclusiveSimulation && simulation.status === "SUCCESS" && gate.realRunAllowed ? (
              <Link href="/dashboard" className="mt-5 inline-flex items-center gap-2 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-2.5 text-sm font-black text-emerald-200 hover:bg-emerald-400/15">
                Primeira geração liberada · voltar ao painel →
              </Link>
            ) : !inconclusiveSimulation && simulation.status === "SUCCESS" ? (
              <Link href="/dashboard/configuracao/fontes" className="mt-5 inline-flex items-center gap-2 rounded-2xl border border-orange-400/25 bg-orange-400/10 px-4 py-2.5 text-sm font-black text-orange-200 hover:bg-orange-400/15">
                Ajustar fontes e simular novamente →
              </Link>
            ) : null}
          </section>
        )}
      </div>
    </main>
  );
}
