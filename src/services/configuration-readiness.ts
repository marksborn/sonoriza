import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";

type SequenceEntry = "MUSIC" | "PODCAST";

type ConfigurationHref =
  | "/dashboard/configuracao/calendarios"
  | "/dashboard/configuracao/fontes"
  | "/dashboard/configuracao/destinos";

export type ConfigurationIssue = {
  code: string;
  message: string;
  href: ConfigurationHref;
};

export type ConfigurationAssessment = {
  hasGoogle: boolean;
  hasSpotify: boolean;
  calendars: Array<{
    id: string;
    summary: string | null;
    usedForTrips: boolean;
  }>;
  sources: Array<{
    id: string;
    kind: "MUSIC" | "PODCAST";
    spotifyType: "PLAYLIST" | "SHOW";
    spotifyId: string;
    name: string | null;
  }>;
  targets: Array<{
    id: string;
    name: string;
    spotifyPlaylistId: string | null;
    priority: number;
    durationMode: "FIXED" | "CALENDAR";
    fixedDurationSeconds: number | null;
    emptyCalendarBehavior: "CLEAR" | "KEEP" | "SKIP";
    podcastPercent: number;
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

export async function assessConfiguration(
  userId: string,
): Promise<ConfigurationAssessment> {
  const [accounts, calendarsRaw, sourcesRaw, targetsRaw] = await Promise.all([
    prisma.account.findMany({
      where: { userId, provider: { in: ["google", "spotify"] } },
      select: { provider: true },
    }),
    prisma.calendarSelection.findMany({
      where: { userId, selected: true },
      orderBy: [{ usedForTrips: "desc" }, { summary: "asc" }],
      select: {
        googleCalendarId: true,
        summary: true,
        usedForTrips: true,
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
        podcastPercent: true,
        sequencePattern: true,
        maxEpisodesPerProgram: true,
      },
    }),
  ]);

  const providers = new Set(accounts.map((account) => account.provider));
  const hasGoogle = providers.has("google");
  const hasSpotify = providers.has("spotify");

  const calendars = calendarsRaw.map((calendar) => ({
    id: calendar.googleCalendarId,
    summary: calendar.summary,
    usedForTrips: calendar.usedForTrips,
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
    podcastPercent: target.podcastPercent,
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
  const tripCalendars = calendars.filter((calendar) => calendar.usedForTrips);

  if (calendarTargets.length > 0 && !hasGoogle) {
    pushIssue({
      code: "GOOGLE_REQUIRED",
      message: "Conecte o Google para calcular o tempo das playlists que usam viagens.",
      href: "/dashboard/configuracao/calendarios",
    });
  }

  if (calendarTargets.length > 0 && tripCalendars.length === 0) {
    pushIssue({
      code: "TRIP_CALENDAR_REQUIRED",
      message: "Marque pelo menos um calendário para entrar no cálculo de viagens.",
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
    tripCalendars: tripCalendars.map((calendar) => calendar.id).sort(),
    sources: sources
      .map((source) => ({
        kind: source.kind,
        spotifyType: source.spotifyType,
        spotifyId: source.spotifyId,
      }))
      .sort((a, b) =>
        `${a.kind}:${a.spotifyType}:${a.spotifyId}`.localeCompare(
          `${b.kind}:${b.spotifyType}:${b.spotifyId}`,
        ),
      ),
    targets: targets.map((target) => ({
      name: target.name,
      spotifyPlaylistId: target.spotifyPlaylistId,
      priority: target.priority,
      durationMode: target.durationMode,
      fixedDurationSeconds: target.fixedDurationSeconds,
      emptyCalendarBehavior: target.emptyCalendarBehavior,
      podcastPercent: target.podcastPercent,
      sequence: target.sequence,
      maxEpisodesPerProgram: target.maxEpisodesPerProgram,
    })),
  };

  return {
    hasGoogle,
    hasSpotify,
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

  return {
    realRunAllowed: true,
    requiresSimulation: true,
    reason: null,
    latestSimulationAt: latestSimulation.startedAt,
  };
}
