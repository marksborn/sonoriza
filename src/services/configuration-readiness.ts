import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { isValidTimeZone } from "@/services/target-schedule";

type SequenceEntry = "MUSIC" | "PODCAST";
type MusicRepeatUnit = "DAYS" | "MONTHS" | "YEARS";

type ConfigurationHref =
  | "/dashboard/configuracao/calendarios"
  | "/dashboard/configuracao/fontes"
  | "/dashboard/configuracao/musica"
  | "/dashboard/configuracao/destinos";

const SPOTIFY_LIBRARY_SCOPE = "user-library-read";
const SPOTIFY_PLAYBACK_SCOPE = "user-read-playback-position";
const SPOTIFY_RECENTLY_PLAYED_SCOPE = "user-read-recently-played";

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
  hasSpotifyRecentlyPlayedScope: boolean;
  musicRepeatPolicy: {
    enabled: boolean;
    windowValue: number | null;
    windowUnit: MusicRepeatUnit | null;
    historyKnownSince: Date | null;
    lastSyncAt: Date | null;
  };
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
    episodeOrder: "SOURCE_DEFAULT" | "OLDEST_FIRST" | "NEWEST_FIRST";
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
    compositionMode: "PROPORTION" | "SEQUENCE";
    musicOrderMode: "STANDARD" | "RANDOMIZED";
    podcastPercent: number;
    podcastEpisodeMaxDurationMode: "NONE" | "FIXED" | "CALENDAR_MAX_EVENT";
    podcastEpisodeMaxDurationSeconds: number | null;
    sequence: SequenceEntry[];
    maxEpisodesPerProgram: number;
    maxTracksPerArtist: number | null;
    maxTracksPerAlbum: number | null;
    updatePolicy: "MANUAL" | "KEEP_FILLED" | "REBUILD_DAILY";
    dailyScheduleMinutes: number | null;
    scheduleTimezone: string | null;
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

export type LatestSimulationForGate = {
  startedAt: Date;
  status: string;
  summary: unknown;
} | null;

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
  const [accounts, calendarsRaw, sourcesRaw, targetsRaw, musicPolicyRaw] =
    await Promise.all([
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
          episodeOrder: true,
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
          compositionMode: true,
          musicOrderMode: true,
          podcastPercent: true,
          podcastEpisodeMaxDurationMode: true,
          podcastEpisodeMaxDurationSeconds: true,
          sequencePattern: true,
          maxEpisodesPerProgram: true,
          maxTracksPerArtist: true,
          maxTracksPerAlbum: true,
          updatePolicy: true,
          dailyScheduleMinutes: true,
          scheduleTimezone: true,
        },
      }),
      prisma.musicPlaybackPolicy.findUnique({
        where: { userId },
        select: {
          enabled: true,
          windowValue: true,
          windowUnit: true,
          historyKnownSince: true,
          lastSyncAt: true,
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
  const hasSpotifyRecentlyPlayedScope = scopeIncludes(
    spotifyAccount?.scope,
    SPOTIFY_RECENTLY_PLAYED_SCOPE,
  );
  const musicRepeatPolicy = {
    enabled: musicPolicyRaw?.enabled ?? false,
    windowValue: musicPolicyRaw?.windowValue ?? null,
    windowUnit: (musicPolicyRaw?.windowUnit ?? null) as MusicRepeatUnit | null,
    historyKnownSince: musicPolicyRaw?.historyKnownSince ?? null,
    lastSyncAt: musicPolicyRaw?.lastSyncAt ?? null,
  };

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
    compositionMode: target.compositionMode,
    musicOrderMode: target.musicOrderMode,
    podcastPercent: target.podcastPercent,
    podcastEpisodeMaxDurationMode: target.podcastEpisodeMaxDurationMode,
    podcastEpisodeMaxDurationSeconds: target.podcastEpisodeMaxDurationSeconds,
    sequence: parseSequence(target.sequencePattern),
    maxEpisodesPerProgram: target.maxEpisodesPerProgram,
    maxTracksPerArtist: target.maxTracksPerArtist,
    maxTracksPerAlbum: target.maxTracksPerAlbum,
    updatePolicy: target.updatePolicy,
    dailyScheduleMinutes: target.dailyScheduleMinutes,
    scheduleTimezone: target.scheduleTimezone,
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

  const needsMusic = targets.some((target) =>
    target.compositionMode === "SEQUENCE"
      ? target.sequence.includes("MUSIC")
      : target.podcastPercent < 100,
  );
  const needsPodcast = targets.some((target) =>
    target.compositionMode === "SEQUENCE"
      ? target.sequence.includes("PODCAST")
      : target.podcastPercent > 0,
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

  if (
    musicRepeatPolicy.enabled &&
    (!Number.isInteger(musicRepeatPolicy.windowValue) ||
      (musicRepeatPolicy.windowValue ?? 0) < 1 ||
      !musicRepeatPolicy.windowUnit)
  ) {
    pushIssue({
      code: "INVALID_MUSIC_REPEAT_POLICY",
      message: "Configure um período válido para evitar repetição de músicas.",
      href: "/dashboard/configuracao/musica",
    });
  }

  if (musicRepeatPolicy.enabled && !hasSpotifyRecentlyPlayedScope) {
    pushIssue({
      code: "SPOTIFY_RECENTLY_PLAYED_SCOPE_REQUIRED",
      message: "Reconecte o Spotify para permitir que o Sonoriza consulte as músicas tocadas recentemente.",
      href: "/dashboard/configuracao/musica",
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

    if (
      rawTarget.compositionMode === "SEQUENCE" &&
      !hasOnlyValidSequenceEntries(rawTarget.sequencePattern)
    ) {
      pushIssue({
        code: `INVALID_SEQUENCE:${rawTarget.id}`,
        message: `${label}: configure uma sequência válida de música e podcast.`,
        href: "/dashboard/configuracao/destinos",
      });
    }

    if (
      rawTarget.compositionMode === "PROPORTION" &&
      (rawTarget.podcastPercent < 0 || rawTarget.podcastPercent > 100)
    ) {
      pushIssue({
        code: `INVALID_PROPORTION:${rawTarget.id}`,
        message: `${label}: informe uma proporção de podcast entre 0% e 100%.`,
        href: "/dashboard/configuracao/destinos",
      });
    }

    if (
      rawTarget.maxTracksPerArtist !== null &&
      (!Number.isInteger(rawTarget.maxTracksPerArtist) ||
        rawTarget.maxTracksPerArtist < 1 ||
        rawTarget.maxTracksPerArtist > 50)
    ) {
      pushIssue({
        code: `INVALID_MUSIC_ARTIST_DIVERSITY:${rawTarget.id}`,
        message: `${label}: configure o limite por artista entre 1 e 50 músicas.`,
        href: "/dashboard/configuracao/destinos",
      });
    }

    if (
      rawTarget.maxTracksPerAlbum !== null &&
      (!Number.isInteger(rawTarget.maxTracksPerAlbum) ||
        rawTarget.maxTracksPerAlbum < 1 ||
        rawTarget.maxTracksPerAlbum > 50)
    ) {
      pushIssue({
        code: `INVALID_MUSIC_ALBUM_DIVERSITY:${rawTarget.id}`,
        message: `${label}: configure o limite por álbum entre 1 e 50 músicas.`,
        href: "/dashboard/configuracao/destinos",
      });
    }

    if (rawTarget.updatePolicy !== "MANUAL") {
      if (
        rawTarget.dailyScheduleMinutes === null ||
        !Number.isInteger(rawTarget.dailyScheduleMinutes) ||
        rawTarget.dailyScheduleMinutes < 0 ||
        rawTarget.dailyScheduleMinutes > 1439
      ) {
        pushIssue({
          code: `TARGET_SCHEDULE_REQUIRED:${rawTarget.id}`,
          message: `${label}: informe um horário diário válido para a atualização automática.`,
          href: "/dashboard/configuracao/destinos",
        });
      }
      if (
        !rawTarget.scheduleTimezone?.trim() ||
        !isValidTimeZone(rawTarget.scheduleTimezone)
      ) {
        pushIssue({
          code: `TARGET_SCHEDULE_TIMEZONE_INVALID:${rawTarget.id}`,
          message: `${label}: informe um fuso horário IANA válido para a atualização automática.`,
          href: "/dashboard/configuracao/destinos",
        });
      }
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
    musicRepeatPolicy: {
      enabled: musicRepeatPolicy.enabled,
      windowValue: musicRepeatPolicy.enabled ? musicRepeatPolicy.windowValue : null,
      windowUnit: musicRepeatPolicy.enabled ? musicRepeatPolicy.windowUnit : null,
    },
    sources: sources
      .map((source) => ({
        kind: source.kind,
        spotifyType: source.spotifyType,
        spotifyId: source.spotifyId,
        includePlayed: source.includePlayed,
        episodeOrder: source.spotifyType === "SHOW" ? source.episodeOrder : "SOURCE_DEFAULT",
      }))
      .sort((a, b) =>
        `${a.kind}:${a.spotifyType}:${a.spotifyId}:${a.includePlayed}:${a.episodeOrder}`.localeCompare(
          `${b.kind}:${b.spotifyType}:${b.spotifyId}:${b.includePlayed}:${b.episodeOrder}`,
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
      compositionMode: target.compositionMode,
      musicOrderMode: target.musicOrderMode,
      podcastPercent:
        target.compositionMode === "PROPORTION" ? target.podcastPercent : null,
      podcastEpisodeMaxDurationMode: target.podcastEpisodeMaxDurationMode,
      podcastEpisodeMaxDurationSeconds: target.podcastEpisodeMaxDurationSeconds,
      sequence: target.compositionMode === "SEQUENCE" ? target.sequence : null,
      maxEpisodesPerProgram: target.maxEpisodesPerProgram,
      maxTracksPerArtist: target.maxTracksPerArtist,
      maxTracksPerAlbum: target.maxTracksPerAlbum,
      updatePolicy: target.updatePolicy,
      dailyScheduleMinutes:
        target.updatePolicy === "MANUAL" ? null : target.dailyScheduleMinutes,
      scheduleTimezone:
        target.updatePolicy === "MANUAL" ? null : target.scheduleTimezone,
    })),
  };

  return {
    hasGoogle,
    hasSpotify,
    hasSpotifyLibraryScope,
    hasSpotifyPlaybackScope,
    hasSpotifyRecentlyPlayedScope,
    musicRepeatPolicy,
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

export function readSimulationInconclusive(summary: unknown): boolean {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
  return (summary as Record<string, unknown>).inconclusive === true;
}

export function evaluateCurrentSimulationGate(
  current: ConfigurationAssessment,
  latestSimulation: LatestSimulationForGate,
): FirstRunGate {
  if (current.issues.length > 0) {
    return {
      realRunAllowed: false,
      requiresSimulation: true,
      reason: "Revise as pendências da configuração antes de executar uma playlist real.",
      latestSimulationAt: null,
    };
  }

  if (!latestSimulation) {
    return {
      realRunAllowed: false,
      requiresSimulation: true,
      reason: "Faça uma simulação bem-sucedida da configuração atual antes da geração real.",
      latestSimulationAt: null,
    };
  }

  if (latestSimulation.status !== "SUCCESS") {
    return {
      realRunAllowed: false,
      requiresSimulation: true,
      reason: readSimulationInconclusive(latestSimulation.summary)
        ? "A última simulação foi inconclusiva porque o Spotify não permitiu ler todas as fontes. Tente novamente mais tarde; nenhuma configuração foi considerada incorreta."
        : "A última simulação não foi concluída com sucesso. Execute uma nova simulação antes da geração real.",
      latestSimulationAt: latestSimulation.startedAt,
    };
  }

  if (readConfigurationFingerprint(latestSimulation.summary) !== current.fingerprint) {
    return {
      realRunAllowed: false,
      requiresSimulation: true,
      reason: "A configuração mudou desde a última simulação. Simule novamente antes da geração real.",
      latestSimulationAt: latestSimulation.startedAt,
    };
  }

  if (!readSimulationQualityPassed(latestSimulation.summary)) {
    return {
      realRunAllowed: false,
      requiresSimulation: true,
      reason: "A última simulação não conseguiu atender às regras de composição configuradas. Ajuste as fontes ou limites e simule novamente.",
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

export async function getFirstRunGate(
  userId: string,
  assessment?: ConfigurationAssessment,
): Promise<FirstRunGate> {
  const current = assessment ?? (await assessConfiguration(userId));

  // Always evaluate the actual latest simulation for the current configuration.
  // A previous real run is historical evidence only; it never bypasses a newer
  // failed/inconclusive simulation or a changed configuration fingerprint.
  const latestSimulation = await prisma.generationRun.findFirst({
    where: { userId, simulation: true },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, status: true, summary: true },
  });

  return evaluateCurrentSimulationGate(current, latestSimulation);
}
