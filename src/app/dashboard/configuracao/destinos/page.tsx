import { SpotifySourceType } from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  TargetPlaylistForm,
  type CalendarOption,
  type SpotifyDestinationOption,
} from "@/components/TargetPlaylistForm";
import { UiIcon } from "@/components/UiIcon";
import { auth, signIn } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  parseSequencePattern,
  type ContentType,
} from "@/services/playlist-planner";
import { canPreserveLegacyTargetCalendar } from "@/services/target-calendar-selection";
import {
  SpotifyClient,
  type SpotifyPlaylistSummary,
} from "@/services/spotify";
import {
  dailyScheduleSlot,
  formatScheduleTime,
  isValidTimeZone,
  nextScheduleLabel,
  parseScheduleTime,
} from "@/services/target-schedule";

const CONFIG_PATH = "/dashboard/configuracao/destinos";
const CREATE_NEW = "__NEW__";
const KEEP_CURRENT = "__KEEP__";

function fail(code: string): never {
  redirect(`${CONFIG_PATH}?error=${code}`);
}

function integerBetween(raw: FormDataEntryValue | null, min: number, max: number) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function readSequence(raw: FormDataEntryValue | null): ContentType[] | null {
  if (typeof raw !== "string") return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 20) return null;
    if (!parsed.every((item) => item === "MUSIC" || item === "PODCAST")) return null;
    return parsed as ContentType[];
  } catch {
    return null;
  }
}

async function assertDestinationAvailable(
  userId: string,
  spotifyPlaylistId: string,
  targetId?: string,
) {
  const [sourceConflict, targetConflict] = await Promise.all([
    prisma.sourcePlaylist.count({
      where: {
        userId,
        spotifyType: SpotifySourceType.PLAYLIST,
        spotifyId: spotifyPlaylistId,
      },
    }),
    prisma.targetPlaylist.count({
      where: {
        userId,
        spotifyPlaylistId,
        ...(targetId ? { id: { not: targetId } } : {}),
      },
    }),
  ]);

  if (sourceConflict > 0) fail("source-conflict");
  if (targetConflict > 0) fail("target-conflict");
}

async function loadOwnedSpotifyPlaylists(userId: string) {
  const client = await SpotifyClient.forUser(userId);
  const [spotifyUserId, playlists] = await Promise.all([
    client.getCurrentUserId(),
    client.listCurrentUserPlaylists(),
  ]);

  return {
    client,
    playlists: playlists.filter((playlist) => playlist.ownerId === spotifyUserId),
  };
}

async function normalizePriorities(userId: string) {
  const targets = await prisma.targetPlaylist.findMany({
    where: { userId },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });

  if (targets.length === 0) return;

  await prisma.$transaction(
    targets.map((target, index) =>
      prisma.targetPlaylist.update({
        where: { id: target.id },
        data: { priority: index },
      }),
    ),
  );
}

function revalidateConfiguration() {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/configuracao");
  revalidatePath(CONFIG_PATH);
}

async function saveTarget(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const userId = session.user.id;
  const id = String(formData.get("id") ?? "").trim() || undefined;
  const name = String(formData.get("name") ?? "").trim();
  const destination = String(formData.get("destination") ?? "").trim();
  const durationMode = String(formData.get("durationMode") ?? "").trim();
  const compositionMode = String(formData.get("compositionMode") ?? "").trim();
  const musicOrderMode = String(formData.get("musicOrderMode") ?? "STANDARD").trim();
  const updatePolicy = String(formData.get("updatePolicy") ?? "MANUAL").trim();
  const dailyScheduleTime = String(formData.get("dailyScheduleTime") ?? "").trim();
  const scheduleTimezone = String(formData.get("scheduleTimezone") ?? "").trim();
  const emptyCalendarBehavior = String(
    formData.get("emptyCalendarBehavior") ?? "CLEAR",
  ).trim();
  const calendarEventFilterMode = String(
    formData.get("calendarEventFilterMode") ?? "ALL",
  ).trim();
  const calendarEventMarker = String(
    formData.get("calendarEventMarker") ?? "",
  ).trim();
  const calendarDurationStrategy = String(
    formData.get("calendarDurationStrategy") ?? "SUMMED",
  ).trim();
  const calendarSelectionId = String(
    formData.get("calendarSelectionId") ?? "",
  ).trim();
  const podcastEpisodeMaxDurationMode = String(
    formData.get("podcastEpisodeMaxDurationMode") ?? "NONE",
  ).trim();
  const podcastPercent = integerBetween(formData.get("podcastPercent"), 0, 100);
  const maxEpisodesPerProgram = integerBetween(
    formData.get("maxEpisodesPerProgram"),
    1,
    50,
  );
  const artistDiversityEnabled = formData.get("limitTracksPerArtist") === "on";
  const albumDiversityEnabled = formData.get("limitTracksPerAlbum") === "on";
  const maxTracksPerArtist = artistDiversityEnabled
    ? integerBetween(formData.get("maxTracksPerArtist"), 1, 50)
    : null;
  const maxTracksPerAlbum = albumDiversityEnabled
    ? integerBetween(formData.get("maxTracksPerAlbum"), 1, 50)
    : null;
  const sequencePattern = readSequence(formData.get("sequencePattern"));
  const enabled = formData.get("enabled") === "on";

  if (!name || name.length > 100) fail("invalid");
  if (durationMode !== "FIXED" && durationMode !== "CALENDAR") fail("invalid");
  const normalizedCompositionMode =
    compositionMode === "PROPORTION" || compositionMode === "SEQUENCE"
      ? compositionMode
      : null;
  if (!normalizedCompositionMode) fail("invalid");
  const normalizedMusicOrderMode =
    musicOrderMode === "STANDARD" || musicOrderMode === "RANDOMIZED"
      ? musicOrderMode
      : null;
  if (!normalizedMusicOrderMode) fail("invalid");
  const normalizedUpdatePolicy =
    updatePolicy === "MANUAL" ||
    updatePolicy === "KEEP_FILLED" ||
    updatePolicy === "REBUILD_DAILY"
      ? updatePolicy
      : null;
  if (!normalizedUpdatePolicy) fail("schedule");
  const dailyScheduleMinutes =
    normalizedUpdatePolicy === "MANUAL" ? null : parseScheduleTime(dailyScheduleTime);
  if (
    normalizedUpdatePolicy !== "MANUAL" &&
    (dailyScheduleMinutes === null || !isValidTimeZone(scheduleTimezone))
  ) {
    fail("schedule");
  }
  if (!sequencePattern || podcastPercent === null || maxEpisodesPerProgram === null) {
    fail("invalid");
  }
  if (
    (artistDiversityEnabled && maxTracksPerArtist === null) ||
    (albumDiversityEnabled && maxTracksPerAlbum === null)
  ) {
    fail("invalid");
  }

  const fixedDurationMinutes =
    durationMode === "FIXED"
      ? integerBetween(formData.get("fixedDurationMinutes"), 1, 1440)
      : null;

  if (durationMode === "FIXED" && fixedDurationMinutes === null) fail("duration");

  const normalizedEmptyBehavior =
    emptyCalendarBehavior === "CLEAR" ||
    emptyCalendarBehavior === "KEEP" ||
    emptyCalendarBehavior === "SKIP"
      ? emptyCalendarBehavior
      : null;

  if (durationMode === "CALENDAR" && !normalizedEmptyBehavior) fail("invalid");

  const normalizedCalendarEventFilterMode =
    calendarEventFilterMode === "ALL" || calendarEventFilterMode === "MARKER"
      ? calendarEventFilterMode
      : null;

  if (durationMode === "CALENDAR" && !normalizedCalendarEventFilterMode) fail("invalid");

  const normalizedCalendarDurationStrategy =
    calendarDurationStrategy === "SUMMED" ||
    calendarDurationStrategy === "PER_EVENT"
      ? calendarDurationStrategy
      : null;

  if (
    durationMode === "CALENDAR" &&
    !normalizedCalendarDurationStrategy
  ) {
    fail("invalid");
  }

  if (
    durationMode === "CALENDAR" &&
    normalizedCalendarEventFilterMode === "MARKER" &&
    (!calendarEventMarker || calendarEventMarker.length > 80)
  ) {
    fail("marker");
  }

  const normalizedPodcastEpisodeMaxDurationMode =
    podcastEpisodeMaxDurationMode === "NONE" ||
    podcastEpisodeMaxDurationMode === "FIXED" ||
    podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT"
      ? podcastEpisodeMaxDurationMode
      : null;

  if (!normalizedPodcastEpisodeMaxDurationMode) fail("episode-duration");
  if (
    normalizedPodcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT" &&
    durationMode !== "CALENDAR"
  ) {
    fail("episode-duration");
  }

  const podcastEpisodeMaxDurationMinutes =
    normalizedPodcastEpisodeMaxDurationMode === "FIXED"
      ? integerBetween(formData.get("podcastEpisodeMaxDurationMinutes"), 1, 1440)
      : null;

  if (
    normalizedPodcastEpisodeMaxDurationMode === "FIXED" &&
    podcastEpisodeMaxDurationMinutes === null
  ) {
    fail("episode-duration");
  }

  const existingTarget = id
    ? await prisma.targetPlaylist.findFirst({ where: { id, userId } })
    : null;

  if (id && !existingTarget) fail("invalid");

  let normalizedCalendarSelectionId: string | null = null;
  if (durationMode === "CALENDAR") {
    const allowLegacyCalendar = canPreserveLegacyTargetCalendar(existingTarget);

    if (!calendarSelectionId) {
      if (!allowLegacyCalendar) fail("calendar-selection");

      const durationCalendarCount = await prisma.calendarSelection.count({
        where: {
          userId,
          selected: true,
          usedForDuration: true,
        },
      });
      if (durationCalendarCount === 0) fail("calendar");
    } else {
      const calendarSelection = await prisma.calendarSelection.findFirst({
        where: {
          id: calendarSelectionId,
          userId,
          selected: true,
        },
        select: { id: true },
      });
      if (!calendarSelection) fail("calendar-selection");
      normalizedCalendarSelectionId = calendarSelection.id;
    }
  }

  let spotifyPlaylistId = existingTarget?.spotifyPlaylistId ?? null;

  if (destination === KEEP_CURRENT) {
    if (!existingTarget?.spotifyPlaylistId) fail("invalid");
    await assertDestinationAvailable(userId, existingTarget.spotifyPlaylistId, id);
  } else {
    const spotifyAccount = await prisma.account.findFirst({
      where: { userId, provider: "spotify" },
      select: { id: true },
    });
    if (!spotifyAccount) fail("spotify");

    if (destination !== CREATE_NEW) {
      if (!destination || destination.length > 128) fail("invalid");
      await assertDestinationAvailable(userId, destination, id);
    }

    let spotify: SpotifyClient;
    let ownedPlaylists: SpotifyPlaylistSummary[];
    try {
      const result = await loadOwnedSpotifyPlaylists(userId);
      spotify = result.client;
      ownedPlaylists = result.playlists;
    } catch {
      fail("spotify");
    }

    if (destination === CREATE_NEW) {
      try {
        spotifyPlaylistId = await spotify!.createPlaylist(
          name,
          "Gerada e gerenciada pelo Sonoriza",
        );
      } catch {
        fail("spotify");
      }
    } else {
      const selectedPlaylist = ownedPlaylists!.find(
        (playlist) => playlist.id === destination,
      );
      if (!selectedPlaylist) fail("unavailable");
      spotifyPlaylistId = selectedPlaylist.id;
    }
  }

  const data = {
    name,
    spotifyPlaylistId,
    enabled,
    compositionMode: normalizedCompositionMode,
    musicOrderMode: normalizedMusicOrderMode,
    durationMode,
    fixedDurationSeconds:
      durationMode === "FIXED" ? fixedDurationMinutes! * 60 : null,
    calendarSelectionId:
      durationMode === "CALENDAR" ? normalizedCalendarSelectionId : null,
    emptyCalendarBehavior:
      durationMode === "CALENDAR" ? normalizedEmptyBehavior! : "CLEAR",
    calendarEventFilterMode:
      durationMode === "CALENDAR" ? normalizedCalendarEventFilterMode! : "ALL",
    calendarEventMarker:
      durationMode === "CALENDAR" &&
      normalizedCalendarEventFilterMode === "MARKER"
        ? calendarEventMarker
        : null,
    calendarDurationStrategy:
      durationMode === "CALENDAR"
        ? normalizedCalendarDurationStrategy!
        : "SUMMED",
    podcastPercent: podcastPercent!,
    podcastEpisodeMaxDurationMode: normalizedPodcastEpisodeMaxDurationMode,
    podcastEpisodeMaxDurationSeconds:
      normalizedPodcastEpisodeMaxDurationMode === "FIXED"
        ? podcastEpisodeMaxDurationMinutes! * 60
        : null,
    sequencePattern,
    maxEpisodesPerProgram: maxEpisodesPerProgram!,
    maxTracksPerArtist,
    maxTracksPerAlbum,
    updatePolicy: normalizedUpdatePolicy,
    dailyScheduleMinutes,
    scheduleTimezone:
      normalizedUpdatePolicy === "MANUAL" ? null : scheduleTimezone,
  } as const;

  if (existingTarget) {
    await prisma.targetPlaylist.update({
      where: { id: existingTarget.id },
      data,
    });
  } else {
    const maxPriority = await prisma.targetPlaylist.aggregate({
      where: { userId },
      _max: { priority: true },
    });

    await prisma.targetPlaylist.create({
      data: {
        userId,
        priority: (maxPriority._max.priority ?? -1) + 1,
        ...data,
      },
    });
  }

  await normalizePriorities(userId);
  revalidateConfiguration();
  redirect(`${CONFIG_PATH}?saved=${existingTarget ? "updated" : "created"}`);
}

async function toggleTarget(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const id = String(formData.get("id") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "") === "true";
  if (!id) fail("invalid");

  const result = await prisma.targetPlaylist.updateMany({
    where: { id, userId: session.user.id },
    data: { enabled },
  });
  if (result.count !== 1) fail("invalid");

  revalidateConfiguration();
  redirect(`${CONFIG_PATH}?saved=${enabled ? "enabled" : "disabled"}`);
}

async function reorderTarget(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const id = String(formData.get("id") ?? "").trim();
  const direction = String(formData.get("direction") ?? "").trim();
  if (!id || (direction !== "up" && direction !== "down")) fail("invalid");

  const targets = await prisma.targetPlaylist.findMany({
    where: { userId: session.user.id },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    select: { id: true },
  });

  const currentIndex = targets.findIndex((target) => target.id === id);
  if (currentIndex < 0) fail("invalid");

  const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= targets.length) {
    redirect(CONFIG_PATH);
  }

  const reordered = [...targets];
  const current = reordered[currentIndex]!;
  reordered[currentIndex] = reordered[nextIndex]!;
  reordered[nextIndex] = current;

  await prisma.$transaction(
    reordered.map((target, index) =>
      prisma.targetPlaylist.update({
        where: { id: target.id },
        data: { priority: index },
      }),
    ),
  );

  revalidateConfiguration();
  redirect(`${CONFIG_PATH}?saved=reordered`);
}

async function connectSpotify() {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");
  await signIn("spotify", { redirectTo: CONFIG_PATH });
}

type DestinationsPageProps = {
  searchParams: Promise<{
    saved?: string;
    error?: string;
  }>;
};

function durationLabel(target: {
  durationMode: string;
  fixedDurationSeconds: number | null;
}) {
  if (target.durationMode === "CALENDAR") return "Baseada no calendário";
  const minutes = Math.max(1, Math.round((target.fixedDurationSeconds ?? 0) / 60));
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hora" : "horas"}`;
  }
  return `${minutes} min`;
}

function emptyBehaviorLabel(value: string) {
  if (value === "KEEP") return "manter playlist";
  if (value === "SKIP") return "não tocar na playlist";
  return "esvaziar playlist";
}

function podcastEpisodeMaxDurationLabel(target: {
  podcastEpisodeMaxDurationMode: string;
  podcastEpisodeMaxDurationSeconds: number | null;
}) {
  if (target.podcastEpisodeMaxDurationMode === "CALENDAR_MAX_EVENT") {
    return "máx. por podcast: maior evento elegível";
  }
  if (target.podcastEpisodeMaxDurationMode === "FIXED") {
    return `máx. por podcast: ${Math.max(
      1,
      Math.round((target.podcastEpisodeMaxDurationSeconds ?? 0) / 60),
    )} min`;
  }
  return "sem limite de duração por podcast";
}


function musicDiversityLabel(target: {
  maxTracksPerArtist: number | null;
  maxTracksPerAlbum: number | null;
}) {
  const rules: string[] = [];
  if (target.maxTracksPerArtist !== null) {
    rules.push(`até ${target.maxTracksPerArtist} por artista`);
  }
  if (target.maxTracksPerAlbum !== null) {
    rules.push(`até ${target.maxTracksPerAlbum} por álbum`);
  }
  return rules.length > 0
    ? `diversidade: ${rules.join(" + ")}`
    : "diversidade sem limite";
}

function schedulePresentation(
  target: {
    id: string;
    updatePolicy: "MANUAL" | "KEEP_FILLED" | "REBUILD_DAILY";
    dailyScheduleMinutes: number | null;
    scheduleTimezone: string | null;
  },
  latest: {
    status: string;
    scheduledLocalDate: string;
    finishedAt: Date | null;
    preservedCount: number;
    removedCount: number;
    addedCount: number;
    reason: string | null;
  } | null,
): { policy: string; audit: string | null } {
  if (target.updatePolicy === "MANUAL") {
    return { policy: "atualização manual", audit: null };
  }
  const label =
    target.updatePolicy === "KEEP_FILLED"
      ? "manter completa"
      : "refazer diariamente";
  const minutes = target.dailyScheduleMinutes;
  const timeZone = target.scheduleTimezone ?? "";
  if (minutes === null || !isValidTimeZone(timeZone)) {
    return { policy: `${label} · agenda inválida`, audit: null };
  }
  const now = new Date();
  const slot = dailyScheduleSlot(target.id, minutes, timeZone, now);
  const completedToday = Boolean(
    latest &&
      latest.scheduledLocalDate === slot.localDate &&
      ["SUCCESS", "NOOP", "PARTIAL"].includes(latest.status),
  );
  const next = nextScheduleLabel(minutes, timeZone, now, completedToday);
  if (!latest) {
    return {
      policy: `${label} às ${formatScheduleTime(minutes)}`,
      audit: `Ainda sem execução automática · próxima: ${next}`,
    };
  }
  const finished = latest.finishedAt
    ? new Intl.DateTimeFormat("pt-BR", {
        timeZone,
        dateStyle: "short",
        timeStyle: "short",
      }).format(latest.finishedAt)
    : "em andamento";
  const movement = `preservados ${latest.preservedCount} · removidos ${latest.removedCount} · adicionados ${latest.addedCount}`;
  return {
    policy: `${label} às ${formatScheduleTime(minutes)}`,
    audit: `Última automática: ${latest.status} em ${finished} · ${movement}${
      latest.reason ? ` · ${latest.reason}` : ""
    } · próxima: ${next}`,
  };
}

export default async function DestinationsPage({ searchParams }: DestinationsPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const params = await searchParams;
  const userId = session.user.id;

  const [spotifyAccount, targets, durationCalendars, playlistSources] = await Promise.all([
    prisma.account.findFirst({
      where: { userId, provider: "spotify" },
      select: { id: true },
    }),
    prisma.targetPlaylist.findMany({
      where: { userId },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      include: {
        targetScheduleRuns: {
          orderBy: { startedAt: "desc" },
          take: 1,
        },
        calendarSelection: {
          select: {
            id: true,
            summary: true,
            googleCalendarId: true,
          },
        },
      },
    }),
    prisma.calendarSelection.findMany({
      where: { userId, selected: true },
      orderBy: [{ usedForDuration: "desc" }, { summary: "asc" }],
      select: {
        id: true,
        googleCalendarId: true,
        summary: true,
        usedForDuration: true,
      },
    }),
    prisma.sourcePlaylist.findMany({
      where: {
        userId,
        spotifyType: SpotifySourceType.PLAYLIST,
      },
      select: { spotifyId: true },
    }),
  ]);

  let ownedPlaylists: SpotifyPlaylistSummary[] = [];
  let spotifyLoadError = false;

  if (spotifyAccount) {
    try {
      ownedPlaylists = (await loadOwnedSpotifyPlaylists(userId)).playlists;
      ownedPlaylists.sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
    } catch {
      spotifyLoadError = true;
    }
  }

  const sourceIds = new Set(playlistSources.map((source) => source.spotifyId));
  const targetSpotifyIds = new Set(
    targets.flatMap((target) => (target.spotifyPlaylistId ? [target.spotifyPlaylistId] : [])),
  );
  const playlistNameById = new Map(
    ownedPlaylists.map((playlist) => [playlist.id, playlist.name]),
  );
  const durationCalendarNames = durationCalendars
    .filter((calendar) => calendar.usedForDuration)
    .map((calendar) => calendar.summary?.trim() || "Calendário");
  const calendarOptions: CalendarOption[] = durationCalendars.map((calendar) => ({
    id: calendar.id,
    googleCalendarId: calendar.googleCalendarId,
    name: calendar.summary?.trim() || "Calendário",
  }));

  function spotifyOptions(currentTargetSpotifyId?: string | null): SpotifyDestinationOption[] {
    return ownedPlaylists
      .filter((playlist) => {
        if (sourceIds.has(playlist.id)) return false;
        if (!targetSpotifyIds.has(playlist.id)) return true;
        return playlist.id === currentTargetSpotifyId;
      })
      .map((playlist) => ({ id: playlist.id, name: playlist.name }));
  }

  const errorMessage =
    params.error === "calendar"
      ? "Este destino ainda usa compatibilidade global. Habilite ao menos um calendário para duração no CONFIG-01 ou escolha um calendário próprio."
      : params.error === "calendar-selection"
        ? "Escolha um calendário disponível para este destino. Destinos novos não usam fallback global silencioso."
        : params.error === "marker"
        ? "Informe um marcador de evento com até 80 caracteres."
        : params.error === "duration"
          ? "Informe uma duração fixa entre 1 minuto e 24 horas."
          : params.error === "episode-duration"
            ? "Revise a duração máxima por episódio. O limite fixo deve ficar entre 1 minuto e 24 horas, e o maior evento só pode ser usado em destinos baseados no calendário."
            : params.error === "schedule"
              ? "Revise a política automática, o horário diário e o fuso horário do destino."
              : params.error === "source-conflict"
              ? "Essa playlist já é uma fonte de conteúdo. Escolha outro destino para evitar que a geração apague a própria fonte."
              : params.error === "target-conflict"
                ? "Essa playlist do Spotify já está ligada a outro destino do Sonoriza."
                : params.error === "unavailable"
                  ? "A playlist escolhida não está entre as playlists próprias disponíveis nesta conta Spotify."
                  : params.error === "spotify"
                    ? "Não foi possível validar ou criar a playlist no Spotify. Revise a conexão e tente novamente."
                    : params.error
                      ? "A configuração contém um valor inválido. Revise os campos e tente novamente."
                      : null;

  return (
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />

      <div className="relative mx-auto max-w-6xl">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Link href="/dashboard/configuracao" className="product-link">
              <UiIcon name="arrow-left" size={18} />
              Central de configuração
            </Link>
            <p className="mt-6 text-xs font-black uppercase tracking-[0.17em] text-accent-400">
              CONFIG-03
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
              Destinos e regras
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-inverse sm:text-base">
              Defina onde o Sonoriza monta suas playlists, quanto conteúdo preparar e como música e podcast se alternam. Nenhuma alteração nesta tela inicia uma geração.
            </p>
          </div>

          <div className="product-badge max-w-full px-4 py-3">
            <div className="min-w-0">
              <p className="font-black text-ink-inverse">Conta atual</p>
              <p className="mt-1 truncate">{session.user.email}</p>
            </div>
          </div>
        </header>

        {params.saved && (
          <div className="status-success mt-7 rounded-2xl border px-4 py-3 text-sm font-bold">
            {params.saved === "created" && "Destino criado. Nenhuma geração foi iniciada."}
            {params.saved === "updated" && "Regras atualizadas. Nenhuma geração foi iniciada."}
            {params.saved === "enabled" && "Destino ativado para as próximas gerações."}
            {params.saved === "disabled" && "Destino desativado. As regras continuam salvas."}
            {params.saved === "reordered" && "Ordem de geração atualizada."}
          </div>
        )}

        {errorMessage && (
          <div className="status-danger mt-7 flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm font-bold leading-6">
            <UiIcon name="warning" size={18} className="mt-0.5 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        <section className="product-panel mt-7 p-5 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
                Duração baseada no calendário
              </p>
              <h2 className="mt-1 text-xl font-black text-ink-inverse">
                Calendário escolhido em cada destino
              </h2>
              {calendarOptions.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {calendarOptions.map((calendar) => (
                    <span key={calendar.id} className="product-badge">
                      <UiIcon name="calendar" size={15} />
                      {calendar.name}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="status-warning mt-3 flex max-w-3xl items-start gap-3 rounded-2xl border px-4 py-3 text-sm leading-6">
                  <UiIcon name="warning" size={18} className="mt-0.5 shrink-0" />
                  <span>
                    Nenhum calendário está habilitado para consulta. Ative pelo menos um calendário no CONFIG-01 antes de criar um destino baseado em calendário.
                  </span>
                </div>
              )}
              <p className="mt-3 max-w-3xl text-xs leading-5 text-muted-inverse/65">
                A marcação global “Duração” permanece somente para destinos legados ainda sem calendário próprio.
              </p>
            </div>
            <Link
              href="/dashboard/configuracao/calendarios"
              className="inline-flex w-fit items-center gap-2 rounded-full border border-brand-400/25 bg-brand/15 px-4 py-2.5 text-sm font-black text-ink-inverse transition hover:bg-brand/25"
            >
              <UiIcon name="settings" size={17} />
              Configurar calendários
            </Link>
          </div>
        </section>

        {!spotifyAccount ? (
          <section className="product-panel mt-5 p-6">
            <div className="flex items-start gap-4">
              <div className="product-icon-tile-accent">
                <UiIcon name="music" size={22} />
              </div>
              <div>
                <h2 className="text-xl font-black text-ink-inverse">
                  Conecte o Spotify para escolher destinos
                </h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-inverse">
                  O Sonoriza valida playlists diretamente na sua conta e nunca pede que você digite IDs.
                </p>
                <form action={connectSpotify}>
                  <button type="submit" className="primary-button mt-4">
                    Conectar Spotify
                  </button>
                </form>
              </div>
            </div>
          </section>
        ) : spotifyLoadError ? (
          <section className="status-danger mt-5 rounded-[1.75rem] border p-6">
            <div className="flex items-start gap-4">
              <UiIcon name="warning" size={22} className="mt-0.5 shrink-0" />
              <div>
                <h2 className="text-xl font-black">Não foi possível carregar suas playlists</h2>
                <p className="mt-2 max-w-3xl text-sm leading-6 opacity-80">
                  Revise a conexão com o Spotify antes de criar ou trocar o destino de uma playlist.
                </p>
                <form action={connectSpotify}>
                  <button
                    type="submit"
                    className="mt-4 inline-flex items-center gap-2 rounded-full border border-danger/35 bg-danger/10 px-4 py-2.5 text-sm font-black transition hover:bg-danger/20"
                  >
                    <UiIcon name="repeat" size={17} />
                    Reconectar Spotify
                  </button>
                </form>
              </div>
            </div>
          </section>
        ) : (
          <details
            open={targets.length === 0}
            className="product-panel group mt-5 p-5 sm:p-6"
          >
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
                    Novo destino
                  </p>
                  <h2 className="mt-1 text-xl font-black text-ink-inverse">
                    Adicionar playlist gerenciada
                  </h2>
                  <p className="mt-1 text-sm text-muted-inverse">
                    Nova playlist entra por último na ordem de geração e pode ser reorganizada depois.
                  </p>
                </div>
                <span className="product-icon-tile-accent transition group-open:rotate-45">
                  <UiIcon name="plus" size={22} />
                </span>
              </div>
            </summary>

            <div className="mt-6 border-t border-line-dark/55 pt-6">
              <TargetPlaylistForm
                saveAction={saveTarget}
                submitLabel="Criar destino"
                spotifyOptions={spotifyOptions()}
                durationCalendarNames={durationCalendarNames}
                calendarOptions={calendarOptions}
                initial={{
                  name: "",
                  enabled: true,
                  durationMode: "FIXED",
                  fixedDurationMinutes: 45,
                  calendarSelectionId: null,
                  allowLegacyCalendar: false,
                  emptyCalendarBehavior: "KEEP",
                  calendarEventFilterMode: "ALL",
                  calendarEventMarker: "",
                  calendarDurationStrategy: "SUMMED",
                  compositionMode: "PROPORTION",
                  musicOrderMode: "STANDARD",
                  podcastPercent: 60,
                  podcastEpisodeMaxDurationMode: "NONE",
                  podcastEpisodeMaxDurationMinutes: 45,
                  sequencePattern: ["MUSIC", "PODCAST", "MUSIC", "MUSIC", "PODCAST"],
                  maxEpisodesPerProgram: 1,
                  maxTracksPerArtist: null,
                  maxTracksPerAlbum: null,
                  updatePolicy: "MANUAL",
                  dailyScheduleTime: "04:30",
                  scheduleTimezone: "",
                  destinationValue: CREATE_NEW,
                }}
              />
            </div>
          </details>
        )}

        <section className="product-panel mt-5 p-5 sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
                Ordem de geração
              </p>
              <h2 className="mt-1 text-xl font-black text-ink-inverse">
                Playlists configuradas
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted-inverse">
                As primeiras playlists reservam conteúdo antes das seguintes. Reordene sem lidar com números técnicos.
              </p>
            </div>
            <span className="product-badge">
              <UiIcon name="list" size={15} />
              {targets.filter((target) => target.enabled).length} ativas
            </span>
          </div>

          {targets.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-line-dark/60 bg-surface-subtle/55 p-7 text-center">
              <p className="font-black text-ink-inverse">Nenhum destino configurado</p>
              <p className="mt-1 text-sm text-muted-inverse">
                Abra “Adicionar playlist gerenciada” acima para criar o primeiro.
              </p>
            </div>
          ) : (
            <div className="mt-5 space-y-4">
              {targets.map((target, index) => {
                const currentSpotifyName = target.spotifyPlaylistId
                  ? playlistNameById.get(target.spotifyPlaylistId)
                  : undefined;
                const destinationUnavailable = Boolean(
                  !spotifyLoadError &&
                    target.spotifyPlaylistId &&
                    !playlistNameById.has(target.spotifyPlaylistId),
                );
                const sequencePattern = parseSequencePattern(target.sequencePattern);
                const latestSchedule = target.targetScheduleRuns[0] ?? null;
                const schedule = schedulePresentation(target, latestSchedule);

                return (
                  <article
                    key={target.id}
                    className={`product-card p-4 sm:p-5 ${
                      target.enabled ? "" : "opacity-65"
                    }`}
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs font-black text-accent-400">
                            {index + 1}ª na geração
                          </span>
                          <span
                            className={`rounded-full border px-2.5 py-1 text-xs font-black ${
                              target.enabled ? "status-success" : "product-badge"
                            }`}
                          >
                            {target.enabled ? "Ativa" : "Inativa"}
                          </span>
                        </div>
                        <h3 className="mt-3 text-lg font-black text-ink-inverse">{target.name}</h3>
                        <p className="mt-1 text-sm leading-6 text-muted-inverse">
                          {durationLabel(target)} ·{" "}
                          {target.compositionMode === "SEQUENCE"
                            ? `por sequência: ${sequencePattern
                                .map((entry) => (entry === "MUSIC" ? "M" : "P"))
                                .join(" → ")}`
                            : `${target.podcastPercent}% podcast / ${
                                100 - target.podcastPercent
                              }% música`}
                          {target.durationMode === "CALENDAR"
                            ? ` · calendário: ${
                                target.calendarSelection?.summary?.trim() ||
                                (target.calendarSelectionId
                                  ? "seleção indisponível"
                                  : "globais (legado)")
                              } · eventos: ${
                                target.calendarEventFilterMode === "MARKER"
                                  ? `marcador ${
                                      target.calendarEventMarker ?? "não informado"
                                    }`
                                  : "todos"
                              } · duração: ${
                                target.calendarDurationStrategy === "PER_EVENT"
                                  ? "por evento"
                                  : "somada"
                              } · sem evento: ${emptyBehaviorLabel(
                                target.emptyCalendarBehavior,
                              )}`
                            : ""}
                          {` · ${podcastEpisodeMaxDurationLabel(target)}`}
                          {` · músicas: ${
                            target.musicOrderMode === "RANDOMIZED"
                              ? "ordem randomizada"
                              : "ordem padrão"
                          }`}
                          {` · ${musicDiversityLabel(target)}`}
                          {` · ${schedule.policy}`}
                        </p>
                        {schedule.audit && (
                          <p className="mt-1 text-xs text-muted-inverse/65">
                            {schedule.audit}
                          </p>
                        )}
                        <p className="mt-1 text-xs text-muted-inverse/65">
                          {target.spotifyPlaylistId
                            ? currentSpotifyName
                              ? `Spotify: ${currentSpotifyName}`
                              : "Playlist do Spotify vinculada"
                            : "Ainda sem playlist do Spotify vinculada"}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <form action={reorderTarget}>
                          <input type="hidden" name="id" value={target.id} />
                          <input type="hidden" name="direction" value="up" />
                          <button
                            type="submit"
                            disabled={index === 0}
                            className="inline-flex items-center gap-1.5 rounded-full border border-line-dark/60 bg-surface-elevated/65 px-3 py-2 text-xs font-black text-ink-inverse transition hover:border-brand-400/45 hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            <UiIcon name="arrow-left" size={15} className="rotate-90" />
                            Subir
                          </button>
                        </form>
                        <form action={reorderTarget}>
                          <input type="hidden" name="id" value={target.id} />
                          <input type="hidden" name="direction" value="down" />
                          <button
                            type="submit"
                            disabled={index === targets.length - 1}
                            className="inline-flex items-center gap-1.5 rounded-full border border-line-dark/60 bg-surface-elevated/65 px-3 py-2 text-xs font-black text-ink-inverse transition hover:border-brand-400/45 hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            <UiIcon name="arrow-right" size={15} className="rotate-90" />
                            Descer
                          </button>
                        </form>
                        <form action={toggleTarget}>
                          <input type="hidden" name="id" value={target.id} />
                          <input type="hidden" name="enabled" value={String(!target.enabled)} />
                          <button
                            type="submit"
                            className="inline-flex items-center rounded-full border border-line-dark/60 bg-surface-elevated/65 px-3 py-2 text-xs font-black text-ink-inverse transition hover:border-brand-400/45 hover:bg-surface-elevated"
                          >
                            {target.enabled ? "Desativar" : "Ativar"}
                          </button>
                        </form>
                      </div>
                    </div>

                    <details className="mt-4 rounded-2xl border border-line-dark/55 bg-surface-dark/60 p-4">
                      <summary className="cursor-pointer text-sm font-black text-ink-inverse">
                        Editar regras e destino
                      </summary>
                      <div className="mt-5 border-t border-line-dark/55 pt-5">
                        <TargetPlaylistForm
                          saveAction={saveTarget}
                          submitLabel="Salvar alterações"
                          spotifyOptions={spotifyOptions(target.spotifyPlaylistId)}
                          durationCalendarNames={durationCalendarNames}
                          calendarOptions={calendarOptions}
                          initial={{
                            id: target.id,
                            name: target.name,
                            enabled: target.enabled,
                            durationMode: target.durationMode,
                            fixedDurationMinutes: Math.max(
                              1,
                              Math.round((target.fixedDurationSeconds ?? 45 * 60) / 60),
                            ),
                            calendarSelectionId: target.calendarSelectionId,
                            allowLegacyCalendar:
                              target.durationMode === "CALENDAR" &&
                              !target.calendarSelectionId,
                            emptyCalendarBehavior: target.emptyCalendarBehavior,
                            calendarEventFilterMode: target.calendarEventFilterMode,
                            calendarEventMarker: target.calendarEventMarker ?? "",
                            calendarDurationStrategy: target.calendarDurationStrategy,
                            compositionMode: target.compositionMode,
                            musicOrderMode: target.musicOrderMode,
                            podcastPercent: target.podcastPercent,
                            podcastEpisodeMaxDurationMode:
                              target.podcastEpisodeMaxDurationMode,
                            podcastEpisodeMaxDurationMinutes: Math.max(
                              1,
                              Math.round(
                                (target.podcastEpisodeMaxDurationSeconds ?? 45 * 60) / 60,
                              ),
                            ),
                            sequencePattern,
                            maxEpisodesPerProgram: target.maxEpisodesPerProgram,
                            maxTracksPerArtist: target.maxTracksPerArtist,
                            maxTracksPerAlbum: target.maxTracksPerAlbum,
                            updatePolicy: target.updatePolicy,
                            dailyScheduleTime:
                              target.dailyScheduleMinutes === null
                                ? "04:30"
                                : formatScheduleTime(target.dailyScheduleMinutes),
                            scheduleTimezone: target.scheduleTimezone ?? "",
                            destinationValue: target.spotifyPlaylistId
                              ? KEEP_CURRENT
                              : CREATE_NEW,
                            currentSpotifyName,
                            destinationUnavailable,
                          }}
                        />
                      </div>
                    </details>
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
