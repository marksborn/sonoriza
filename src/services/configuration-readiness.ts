import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";

type SequenceEntry = "MUSIC" | "PODCAST";

type ConfigurationHref =
  | "/dashboard/configuracao/calendarios"
  | "/dashboard/configuracao/fontes"
  | "/dashboard/configuracao/destinos";

const SPOTIFY_LIBRARY_SCOPE = "user-library-read";
const SPOTIFY_PLAYBACK_SCOPE = "user-read-playback-position";

export type ConfigurationIssue = {
  code: string;
  message: string;
  href: ConfigurationHref;
};

export type ConfigurationAssessment = {
  hasGoogle: boolean;
  hasSpotify: boolean;
  hasSpotifyLibraryScope: boolean;
  hasSpotifyPlaybackScope: boolean;
  calendars: Array<{
    id: string;
    summary: string | null;
    usedForDuration: boolean;
  }>;
  sources: Array<{
    id: string;
    kind: "MUSIC" | "PODCAST";
    spotifyType: "PLAYLIST" | "SHOW" | "SAVED_EPISODES";
    spotifyId: string;
    name: string | null;
    includePlayed: boolean;
  }>;
  targets: Array<{
    id: string;
    name: string;
    spotifyPlaylistId: string | null;
    priority: number;
    durationMode: "FIXED" | "CALENDAR";
    fixedDurationSeconds: number | null;
    emptyCalendarBehavior: "CLEAR" | "KEEP" | "SKIP";
    calendarEventFilterMode: "ALL" | "MARKER";
    calendarEventMarker: string | null;
    podcastPercent: number;
    podcastEpisodeMaxDurationMode: "NONE" | "FIXED" | "CALENDAR_MAX_EVENT";
    podcastEpisodeMaxDurationSeconds: number | null;
    sequence: SequenceEntry[];
    maxEpisodesPerProgram: number;
  }>;
  issues: ConfigurationIssue[];
  fingerprint: string;
};

export type FirstRunGate = {
  realRunAllowed: boolean;
  requiresSimulation: boolean;
  reason: string | null;
  latestSimulationAt: Date | null;
};

function parseSequence(value: unknown): SequenceEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is SequenceEntry => entry === "MUSIC" || entry === "PODCAST",
  );
}

function hasOnlyValidSequenceEntries(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => entry === "MUSIC" || entry === "PODCAST")
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scopeIncludes(scope: string | null | undefined, expected: string): boolean {
  return new Set((scope ?? "").split(/\s+/).filter(Boolean)).has(expected);
}

export async function assessConfiguration(
  userId: string,
): Promise<ConfigurationAssessment> {
  const [accounts, calendarsRaw, sourcesRaw, targetsRaw] = await Promise.all([
    prisma.account.findMany({
      where: { userId, provider: { in: ["google", "spotify"] } },
      select: { provider: true, scope: true },
    }),
    prisma.calendarSelection.findMany({
      where: { userId, selected: true },
      orderBy: [{ usedForDuration: "desc" }, { summary: "asc" }],
      select: {
        googleCalendarId: true,
        summary: true,
        usedForDuration: true,
      },
    }),
    prisma.sourcePlaylist.findMany({
      where: { userId, enabled: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }, { spotifyId: "asc" }],
      select: {
        id: true,
        kind: true,
        spotifyType: true,
        spotifyId: true,
        name: true,
        includePlayed: true,
      },
    }),
    prisma.targetPlaylist.findMany({
      where: { userId, enabled: true },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        spotifyPlaylistId: true,
        priority: true,
        durationMode: true,
        fixedDurationSeconds: true,
        emptyCalendarBehavior: true,
        calendarEventFilterMode: true,
        calendarEventMarker: true,
        podcastPercent: true,
        podcastEpisodeMaxDurationMode: true,
        podcastEpisodeMaxDurationSeconds: true,
        sequencePattern: true,
        maxEpisodesPerProgram: true,
      },
    }),
  ]);

  const providers = new Set(accounts.map((account) => account.provider));
  const hasGoogle = providers.has("google");
  const hasSpotify = providers.has("spotify");
  const spotifyAccount = accounts.find((account) => account.provider === "spotify");
  const hasSpotifyLibraryScope = scopeIncludes(
    spotifyAccount?.scope,
    SPOTIFY_LIBRARY_SCOPE,
  );
  const hasSpotifyPlaybackScope = scopeIncludes(
    spotifyAccount?.scope,
    SPOTIFY_PLAYBACK_SCOPE,
  );

  const calendars = calendarsRaw.map((calendar) => ({
    id: calendar.googleCalendarId,
    summary: calendar.summary,
    usedForDuration: calendar.usedForDuration,
  }));

  const sources = sourcesRaw.map((source) => ({ ...source }));
  const targets = targetsRaw.map((target) => ({
    id: target.id,
    name: target.name,
    spotifyPlaylistId: target.spotifyPlaylistId,
    priority: target.priority,
    durationMode: target.durationMode,
    fixedDurationSeconds: target.fixedDurationSeconds,
    emptyCalendarBehavior: target.emptyCalendarBehavior,
    calendarEventFilterMode: target.calendarEventFilterMode,
    calendarEventMarker: target.calendarEventMarker,
    podcastPercent: target.podcastPercent,
    podcastEpisodeMaxDurationMode: target.podcastEpisodeMaxDurationMode,
    podcastEpisodeMaxDurationSeconds: target.podcastEpisodeMaxDurationSeconds,
    sequence: parseSequence(target.sequencePattern),
    maxEpisodesPerProgram: target.maxEpisodesPerProgram,
  }));

  const issues: ConfigurationIssue[] = [];
  const pushIssue = (issue: ConfigurationIssue) => {
    if (!issues.some((current) => current.code === issue.code)) issues.push(issue);
  };

  if (!hasSpotify) {
    pushIssue({
      code: "SPOTIFY_REQUIRED",
      message: "Conecte o Spotify para ler as fontes e atualizar as playlists de destino.",
      href: "/dashboard/configuracao/fontes",
    });
  }

  if (targets.length === 0) {
    pushIssue({
      code: "TARGET_REQUIRED",
      message: "Ative pelo menos uma playlist de destino.",
      href: "/dashboard/configuracao/destinos",
    });
  }

  if (sources.length === 0) {
    pushIssue({
      code: "SOURCE_REQUIRED",
      message: "Ative pelo menos uma fonte de conteúdo do Spotify.",
      href: "/dashboard/configuracao/fontes",
    });
  }

  const calendarTargets = targets.filter(
    (target) => target.durationMode === "CALENDAR",
  );
  const durationCalendars = calendars.filter((calendar) => calendar.usedForDuration);

  if (calendarTargets.length > 0 && !hasGoogle) {
    pushIssue({
      code: "GOOGLE_REQUIRED",
      message: "Conecte o Google para calcular a duração das playlists baseadas no calendário.",
      href: "/dashboard/configuracao/calendarios",
    });
  }

  if (calendarTargets.length > 0 && durationCalendars.length === 0) {
    pushIssue({
      code: "DURATION_CALENDAR_REQUIRED",
      message: "Habilite pelo menos um calendário para entrar no cálculo de duração.",
      href: "/dashboard/configuracao/calendarios",
    });
  }

  const needsMusic = targets.some(
    (target) => target.podcastPercent < 100 || target.sequence.includes("MUSIC"),
  );
  const needsPodcast = targets.some(
    (target) => target.podcastPercent > 0 || target.sequence.includes("PODCAST"),
  );
  const hasMusicSource = sources.some((source) => source.kind === "MUSIC");
  const hasPodcastSource = sources.some((source) => source.kind === "PODCAST");

  if (needsMusic && !hasMusicSource) {
    pushIssue({
      code: "MUSIC_SOURCE_REQUIRED",
      message: "Adicione uma fonte de música para atender às regras dos destinos ativos.",
      href: "/dashboard/configuracao/fontes",
    });
  }

  if (needsPodcast && !hasPodcastSource) {
    pushIssue({
      code: "PODCAST_SOURCE_REQUIRED",
      message: "Adicione uma fonte de podcast para atender às regras dos destinos ativos.",
      href: "/dashboard/configuracao/fontes",
    });
  }

  const podcastSources = sources.filter((source) => source.kind === "PODCAST");
  const podcastSourcesNeedLibrary = podcastSources.some(
    (source) =>
      source.spotifyType === "SHOW" || source.spotifyType === "SAVED_EPISODES",
  );

  if (podcastSourcesNeedLibrary && !hasSpotifyLibraryScope) {
    pushIssue({
      code: "SPOTIFY_LIBRARY_SCOPE_REQUIRED",
      message: "Reconecte o Spotify para permitir a leitura dos seus programas e episódios salvos.",
      href: "/dashboard/configuracao/fontes",
    });
  }

  if (podcastSources.length > 0 && !hasSpotifyPlaybackScope) {
    pushIssue({
      code: "SPOTIFY_PLAYBACK_SCOPE_REQUIRED",
      message: "Reconecte o Spotify para distinguir episódios ouvidos, não ouvidos e calcular apenas o tempo restante dos episódios em andamento.",
      href: "/dashboard/configuracao/fontes",
    });
  }

  for (const rawTarget of targetsRaw) {
    const label = `Destino \"${rawTarget.name}\"`;

    if (
      rawTarget.durationMode === "FIXED" &&
      (rawTarget.fixedDurationSeconds ?? 0) <= 0
    ) {
      pushIssue({
        code: `INVALID_FIXED_DURATION:${rawTarget.id}`,
        message: `${label}: informe uma duração fixa maior que zero.`,
        href: "/dashboard/configuracao/destinos",
      });
    }

    if (
      rawTarget.durationMode === "CALENDAR" &&
      rawTarget.calendarEventFilterMode === "MARKER" &&
      !rawTarget.calendarEventMarker?.trim()
    ) {
      pushIssue({
        code: `CALENDAR_MARKER_REQUIRED:${rawTarget.id}`,
        message: `${label}: informe o marcador usado para selecionar eventos do calendário.`,
        href: "/dashboard/configuracao/destinos",
      });
    }

    if (
      rawTarget.podcastEpisodeMaxDurationMode === "FIXED" &&
      (rawTarget.podcastEpisodeMaxDurationSeconds ?? 0) <= 0
    ) {
      pushIssue({
        code: `PODCAST_MAX_DURATION_REQUIRED:${rawTarget.id}`,
        message: `${label}: informe uma duração máxima de episódio maior que zero.`,
        href: "/dashboard/configuracao/destinos",
      });
    }

    if (
      rawTarget.podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT" &&
      rawTarget.durationMode !== "CALENDAR"
    ) {
      pushIssue({
        code: `PODCAST_MAX_DURATION_CALENDAR_REQUIRED:${rawTarget.id}`,
        message: `${label}: o limite pelo maior evento só pode ser usado com duração baseada no calendário.`,
        href: "/dashboard/configuracao/destinos",
      });
    }

    if (!hasOnlyValidSequenceEntries(rawTarget.sequencePattern)) {
      pushIssue({
        code: `INVALID_SEQUENCE:${rawTarget.id}`,
        message: `${label}: configure uma sequência válida de música e podcast.`,
        href: "/dashboard/configuracao/destinos",
      });
    }

    if (!rawTarget.spotifyPlaylistId) {
      pushIssue({
        code: `TARGET_PLAYLIST_REQUIRED:${rawTarget.id}`,
        message: `${label}: vincule uma playlist do Spotify antes da primeira execução.`,
        href: "/dashboard/configuracao/destinos",
      });
    }
  }

  const destinationIds = new Map<string, string>();
  for (const target of targets) {
    if (!target.spotifyPlaylistId) continue;
    const previous = destinationIds.get(target.spotifyPlaylistId);
    if (previous) {
      pushIssue({
        code: `DUPLICATE_TARGET:${target.spotifyPlaylistId}`,
        message: `As playlists \"${previous}\" e \"${target.name}\" apontam para o mesmo destino no Spotify.`,
        href: "/dashboard/configuracao/destinos",
      });
    } else {
      destinationIds.set(target.spotifyPlaylistId, target.name);
    }
  }

  const playlistSourceIds = new Set(
    sources
      .filter((source) => source.spotifyType === "PLAYLIST")
      .map((source) => source.spotifyId),
  );

  for (const target of targets) {
    if (
      target.spotifyPlaylistId &&
      playlistSourceIds.has(target.spotifyPlaylistId)
    ) {
      pushIssue({
        code: `SOURCE_TARGET_CONFLICT:${target.spotifyPlaylistId}`,
        message: `A playlist de destino \"${target.name}\" também está cadastrada como fonte. Escolha outra playlist para evitar sobrescrever a própria fonte.`,
        href: "/dashboard/configuracao/destinos",
      });
    }
  }

  const fingerprintPayload = {
    providers: [...providers]
      .filter((provider) => provider === "google" || provider === "spotify")
      .sort(),
    durationCalendars: durationCalendars.map((calendar) => calendar.id).sort(),
    sources: sources
      .map((source) => ({
        kind: source.kind,
        spotifyType: source.spotifyType,
        spotifyId: source.spotifyId,
        includePlayed: source.includePlayed,
      }))
      .sort((a, b) =>
        `${a.kind}:${a.spotifyType}:${a.spotifyId}:${a.includePlayed}`.localeCompare(
          `${b.kind}:${b.spotifyType}:${b.spotifyId}:${b.includePlayed}`,
        ),
      ),
    targets: targets.map((target) => ({
      name: target.name,
      spotifyPlaylistId: target.spotifyPlaylistId,
      priority: target.priority,
      durationMode: target.durationMode,
      fixedDurationSeconds: target.fixedDurationSeconds,
      emptyCalendarBehavior: target.emptyCalendarBehavior,
      calendarEventFilterMode: target.calendarEventFilterMode,
      calendarEventMarker: target.calendarEventMarker,
      podcastPercent: target.podcastPercent,
      podcastEpisodeMaxDurationMode: target.podcastEpisodeMaxDurationMode,
      podcastEpisodeMaxDurationSeconds: target.podcastEpisodeMaxDurationSeconds,
      sequence: target.sequence,
      maxEpisodesPerProgram: target.maxEpisodesPerProgram,
    })),
  };

  return {
    hasGoogle,
    hasSpotify,
    hasSpotifyLibraryScope,
    hasSpotifyPlaybackScope,
    calendars,
    sources,
    targets,
    issues,
    fingerprint: fingerprint(fingerprintPayload),
  };
}

export function readConfigurationFingerprint(summary: unknown): string | null {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
  const value = (summary as Record<string, unknown>).configurationFingerprint;
  return typeof value === "string" ? value : null;
}

export function readSimulationQualityPassed(summary: unknown): boolean {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  return (summary as Record<string, unknown>).qualityPassed === true;
}

export async function getFirstRunGate(
  userId: string,
  assessment?: ConfigurationAssessment,
): Promise<FirstRunGate> {
  const current = assessment ?? (await assessConfiguration(userId));

  if (current.issues.length > 0) {
    return {
      realRunAllowed: false,
      requiresSimulation: true,
      reason: "Revise as pendências da configuração antes de executar uma playlist real.",
      latestSimulationAt: null,
    };
  }

  // Historical real runs created before CONFIG-04 have no fingerprint and do
  // not count as completion of the controlled first-run flow.
  const successfulManualRuns = await prisma.generationRun.findMany({
    where: {
      userId,
      trigger: "MANUAL",
      simulation: false,
      status: "SUCCESS",
    },
    orderBy: { startedAt: "desc" },
    select: { summary: true },
  });

  const hasControlledRealRun = successfulManualRuns.some(
    (run) => readConfigurationFingerprint(run.summary) !== null,
  );

  if (hasControlledRealRun) {
    return {
      realRunAllowed: true,
      requiresSimulation: false,
      reason: null,
      latestSimulationAt: null,
    };
  }

  const latestSimulation = await prisma.generationRun.findFirst({
    where: { userId, simulation: true, status: "SUCCESS" },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, summary: true },
  });

  if (!latestSimulation) {
    return {
      realRunAllowed: false,
      requiresSimulation: true,
      reason: "Faça uma simulação bem-sucedida antes da primeira geração real.",
      latestSimulationAt: null,
    };
  }

  if (readConfigurationFingerprint(latestSimulation.summary) !== current.fingerprint) {
    return {
      realRunAllowed: false,
      requiresSimulation: true,
      reason: "A configuração mudou desde a última simulação. Simule novamente antes da primeira geração real.",
      latestSimulationAt: latestSimulation.startedAt,
    };
  }

  if (!readSimulationQualityPassed(latestSimulation.summary)) {
    return {
      realRunAllowed: false,
      requiresSimulation: true,
      reason: "A última simulação não conseguiu atender às proporções configuradas. Ajuste as fontes ou limites e simule novamente.",
      latestSimulationAt: latestSimulation.startedAt,
    };
  }

  return {
    realRunAllowed: true,
    requiresSimulation: true,
    reason: null,
    latestSimulationAt: latestSimulation.startedAt,
  };
}
