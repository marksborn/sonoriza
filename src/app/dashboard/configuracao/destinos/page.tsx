import { SpotifySourceType } from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  TargetPlaylistForm,
  type SpotifyDestinationOption,
} from "@/components/TargetPlaylistForm";
import { auth, signIn } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  parseSequencePattern,
  type ContentType,
} from "@/services/playlist-planner";
import {
  SpotifyClient,
  type SpotifyPlaylistSummary,
} from "@/services/spotify";

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
  const emptyCalendarBehavior = String(
    formData.get("emptyCalendarBehavior") ?? "CLEAR",
  ).trim();
  const podcastPercent = integerBetween(formData.get("podcastPercent"), 0, 100);
  const maxEpisodesPerProgram = integerBetween(
    formData.get("maxEpisodesPerProgram"),
    1,
    50,
  );
  const sequencePattern = readSequence(formData.get("sequencePattern"));
  const enabled = formData.get("enabled") === "on";

  if (!name || name.length > 100) fail("invalid");
  if (durationMode !== "FIXED" && durationMode !== "CALENDAR") fail("invalid");
  if (!sequencePattern || podcastPercent === null || maxEpisodesPerProgram === null) {
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

  if (durationMode === "CALENDAR") {
    const tripCalendarCount = await prisma.calendarSelection.count({
      where: {
        userId,
        selected: true,
        usedForTrips: true,
      },
    });
    if (tripCalendarCount === 0) fail("calendar");
  }

  const existingTarget = id
    ? await prisma.targetPlaylist.findFirst({ where: { id, userId } })
    : null;

  if (id && !existingTarget) fail("invalid");

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
    durationMode,
    fixedDurationSeconds:
      durationMode === "FIXED" ? fixedDurationMinutes! * 60 : null,
    emptyCalendarBehavior:
      durationMode === "CALENDAR" ? normalizedEmptyBehavior! : "CLEAR",
    podcastPercent: podcastPercent!,
    sequencePattern,
    maxEpisodesPerProgram: maxEpisodesPerProgram!,
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
  if (target.durationMode === "CALENDAR") return "Tempo das viagens";
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

export default async function DestinationsPage({ searchParams }: DestinationsPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const params = await searchParams;
  const userId = session.user.id;

  const [spotifyAccount, targets, tripCalendars, playlistSources] = await Promise.all([
    prisma.account.findFirst({
      where: { userId, provider: "spotify" },
      select: { id: true },
    }),
    prisma.targetPlaylist.findMany({
      where: { userId },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    }),
    prisma.calendarSelection.findMany({
      where: { userId, selected: true, usedForTrips: true },
      orderBy: { summary: "asc" },
      select: { googleCalendarId: true, summary: true },
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
  const tripCalendarNames = tripCalendars.map(
    (calendar) => calendar.summary?.trim() || "Calendário de viagens",
  );

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
      ? "Para usar o tempo das viagens, marque ao menos um calendário como viagem no CONFIG-01."
      : params.error === "duration"
        ? "Informe uma duração fixa entre 1 minuto e 24 horas."
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
    <main className="relative min-h-screen overflow-hidden bg-[#0b021f] px-5 py-8 text-white sm:px-8 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_5%,rgba(126,34,206,0.3),transparent_31rem),radial-gradient(circle_at_90%_10%,rgba(255,107,0,0.12),transparent_25rem),linear-gradient(180deg,#12032f_0%,#0b021f_55%,#090119_100%)]" />

      <div className="relative mx-auto max-w-6xl">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Link
              href="/dashboard/configuracao"
              className="inline-flex items-center gap-2 text-sm font-bold text-violet-300 transition hover:text-white"
            >
              <span aria-hidden="true">←</span>
              Central de configuração
            </Link>
            <p className="mt-6 text-xs font-black uppercase tracking-[0.17em] text-orange-400">
              CONFIG-03
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">
              Destinos e regras
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-violet-200/75 sm:text-base">
              Defina onde o Sonoriza monta suas playlists, quanto conteúdo preparar e como música e podcast se alternam. Nenhuma alteração nesta tela inicia uma geração.
            </p>
          </div>

          <div className="rounded-2xl border border-violet-400/20 bg-violet-950/45 px-4 py-3 text-sm text-violet-200/75">
            <p className="font-bold text-white">Conta atual</p>
            <p className="mt-1">{session.user.email}</p>
          </div>
        </header>

        {params.saved && (
          <div className="mt-7 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-3 text-sm font-bold text-emerald-200">
            {params.saved === "created" && "Destino criado. Nenhuma geração foi iniciada."}
            {params.saved === "updated" && "Regras atualizadas. Nenhuma geração foi iniciada."}
            {params.saved === "enabled" && "Destino ativado para as próximas gerações."}
            {params.saved === "disabled" && "Destino desativado. As regras continuam salvas."}
            {params.saved === "reordered" && "Ordem de geração atualizada."}
          </div>
        )}

        {errorMessage && (
          <div className="mt-7 rounded-2xl border border-orange-400/25 bg-orange-400/10 px-4 py-3 text-sm font-bold leading-6 text-orange-200">
            {errorMessage}
          </div>
        )}

        <section className="mt-7 rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.92),rgba(22,6,53,0.94))] p-5 shadow-[0_24px_70px_-40px_rgba(139,92,246,0.75)] sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">
                Tempo pelas viagens
              </p>
              <h2 className="mt-1 text-xl font-black">Calendários que entram no cálculo</h2>
              {tripCalendarNames.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {tripCalendarNames.map((name) => (
                    <span
                      key={name}
                      className="rounded-full border border-violet-300/20 bg-violet-400/10 px-3 py-1.5 text-xs font-black text-violet-200"
                    >
                      {name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-2 max-w-3xl text-sm leading-6 text-orange-200/80">
                  Nenhum calendário está marcado para viagens. Destinos com duração pela agenda só poderão ser salvos depois dessa definição.
                </p>
              )}
            </div>
            <Link
              href="/dashboard/configuracao/calendarios"
              className="w-fit rounded-xl border border-violet-300/25 bg-violet-400/10 px-4 py-2.5 text-sm font-black text-violet-100 transition hover:bg-violet-400/20"
            >
              Configurar calendários
            </Link>
          </div>
        </section>

        {!spotifyAccount ? (
          <section className="mt-5 rounded-[1.75rem] border border-orange-400/20 bg-orange-400/10 p-6">
            <h2 className="text-xl font-black">Conecte o Spotify para escolher destinos</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-orange-100/70">
              O Sonoriza valida playlists diretamente na sua conta e nunca pede que você digite IDs.
            </p>
            <form action={connectSpotify}>
              <button
                type="submit"
                className="mt-4 rounded-xl bg-gradient-to-r from-[#ff6b00] to-[#ff8a00] px-5 py-3 text-sm font-black text-white transition hover:brightness-110"
              >
                Conectar Spotify
              </button>
            </form>
          </section>
        ) : spotifyLoadError ? (
          <section className="mt-5 rounded-[1.75rem] border border-orange-400/20 bg-orange-400/10 p-6">
            <h2 className="text-xl font-black">Não foi possível carregar suas playlists</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-orange-100/70">
              Revise a conexão com o Spotify antes de criar ou trocar o destino de uma playlist.
            </p>
            <form action={connectSpotify}>
              <button
                type="submit"
                className="mt-4 rounded-xl border border-orange-300/30 bg-orange-300/10 px-4 py-2.5 text-sm font-black text-orange-100 transition hover:bg-orange-300/20"
              >
                Reconectar Spotify
              </button>
            </form>
          </section>
        ) : (
          <details
            open={targets.length === 0}
            className="group mt-5 rounded-[1.75rem] border border-orange-400/25 bg-[linear-gradient(145deg,rgba(62,17,116,0.96),rgba(30,8,66,0.96))] p-5 shadow-[0_24px_70px_-40px_rgba(255,107,0,0.55)] sm:p-6"
          >
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.15em] text-orange-400">
                    Novo destino
                  </p>
                  <h2 className="mt-1 text-xl font-black">Adicionar playlist gerenciada</h2>
                  <p className="mt-1 text-sm text-violet-200/65">
                    Nova playlist entra por último na ordem de geração e pode ser reorganizada depois.
                  </p>
                </div>
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-orange-300/25 bg-orange-400/10 text-xl font-black text-orange-200 transition group-open:rotate-45">
                  +
                </span>
              </div>
            </summary>

            <div className="mt-6 border-t border-violet-400/15 pt-6">
              <TargetPlaylistForm
                saveAction={saveTarget}
                submitLabel="Criar destino"
                spotifyOptions={spotifyOptions()}
                tripCalendarNames={tripCalendarNames}
                initial={{
                  name: "",
                  enabled: true,
                  durationMode: "FIXED",
                  fixedDurationMinutes: 45,
                  emptyCalendarBehavior: "KEEP",
                  podcastPercent: 60,
                  sequencePattern: ["MUSIC", "PODCAST", "MUSIC", "MUSIC", "PODCAST"],
                  maxEpisodesPerProgram: 1,
                  destinationValue: CREATE_NEW,
                }}
              />
            </div>
          </details>
        )}

        <section className="mt-5 rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.92),rgba(22,6,53,0.94))] p-5 shadow-[0_24px_70px_-40px_rgba(139,92,246,0.75)] sm:p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">
                Ordem de geração
              </p>
              <h2 className="mt-1 text-xl font-black">Playlists configuradas</h2>
              <p className="mt-1 text-sm leading-6 text-violet-200/65">
                As primeiras playlists reservam conteúdo antes das seguintes. Use as setas para definir essa ordem sem lidar com números técnicos.
              </p>
            </div>
            <span className="w-fit rounded-full border border-violet-400/20 bg-violet-400/10 px-3 py-1.5 text-xs font-black text-violet-200">
              {targets.filter((target) => target.enabled).length} ativas
            </span>
          </div>

          {targets.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-violet-400/25 bg-violet-950/30 p-7 text-center">
              <p className="font-black">Nenhum destino configurado</p>
              <p className="mt-1 text-sm text-violet-200/60">
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

                return (
                  <article
                    key={target.id}
                    className={`rounded-2xl border p-4 sm:p-5 ${
                      target.enabled
                        ? "border-violet-300/25 bg-violet-900/30"
                        : "border-violet-500/15 bg-violet-950/25 opacity-75"
                    }`}
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-orange-400/25 bg-orange-400/10 px-2.5 py-1 text-xs font-black text-orange-200">
                            {index + 1}ª na geração
                          </span>
                          <span
                            className={`rounded-full border px-2.5 py-1 text-xs font-black ${
                              target.enabled
                                ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200"
                                : "border-violet-400/20 bg-violet-400/10 text-violet-300"
                            }`}
                          >
                            {target.enabled ? "Ativa" : "Inativa"}
                          </span>
                        </div>
                        <h3 className="mt-3 text-lg font-black text-white">{target.name}</h3>
                        <p className="mt-1 text-sm leading-6 text-violet-200/65">
                          {durationLabel(target)} · {target.podcastPercent}% podcast / {100 - target.podcastPercent}% música
                          {target.durationMode === "CALENDAR"
                            ? ` · sem viagem: ${emptyBehaviorLabel(target.emptyCalendarBehavior)}`
                            : ""}
                        </p>
                        <p className="mt-1 text-xs text-violet-300/50">
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
                            className="rounded-xl border border-violet-400/25 bg-violet-400/10 px-3 py-2 text-xs font-black text-violet-100 transition hover:bg-violet-400/20 disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            ↑ Subir
                          </button>
                        </form>
                        <form action={reorderTarget}>
                          <input type="hidden" name="id" value={target.id} />
                          <input type="hidden" name="direction" value="down" />
                          <button
                            type="submit"
                            disabled={index === targets.length - 1}
                            className="rounded-xl border border-violet-400/25 bg-violet-400/10 px-3 py-2 text-xs font-black text-violet-100 transition hover:bg-violet-400/20 disabled:cursor-not-allowed disabled:opacity-30"
                          >
                            ↓ Descer
                          </button>
                        </form>
                        <form action={toggleTarget}>
                          <input type="hidden" name="id" value={target.id} />
                          <input type="hidden" name="enabled" value={String(!target.enabled)} />
                          <button
                            type="submit"
                            className="rounded-xl border border-orange-400/25 bg-orange-400/10 px-3 py-2 text-xs font-black text-orange-100 transition hover:bg-orange-400/20"
                          >
                            {target.enabled ? "Desativar" : "Ativar"}
                          </button>
                        </form>
                      </div>
                    </div>

                    <details className="mt-4 rounded-2xl border border-violet-400/15 bg-[#12052d]/55 p-4">
                      <summary className="cursor-pointer text-sm font-black text-violet-100">
                        Editar regras e destino
                      </summary>
                      <div className="mt-5 border-t border-violet-400/15 pt-5">
                        <TargetPlaylistForm
                          saveAction={saveTarget}
                          submitLabel="Salvar alterações"
                          spotifyOptions={spotifyOptions(target.spotifyPlaylistId)}
                          tripCalendarNames={tripCalendarNames}
                          initial={{
                            id: target.id,
                            name: target.name,
                            enabled: target.enabled,
                            durationMode: target.durationMode,
                            fixedDurationMinutes: Math.max(
                              1,
                              Math.round((target.fixedDurationSeconds ?? 45 * 60) / 60),
                            ),
                            emptyCalendarBehavior: target.emptyCalendarBehavior,
                            podcastPercent: target.podcastPercent,
                            sequencePattern,
                            maxEpisodesPerProgram: target.maxEpisodesPerProgram,
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
