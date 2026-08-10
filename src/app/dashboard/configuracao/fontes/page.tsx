import { PodcastEpisodeOrder, SourceKind, SpotifySourceType } from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { auth, signIn } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  SpotifyClient,
  type SpotifyPlaylistSummary,
  type SpotifyShowSummary,
} from "@/services/spotify";

const LIBRARY_SCOPE = "user-library-read";
const PLAYBACK_SCOPE = "user-read-playback-position";
const SAVED_EPISODES_ID = "me";

const selectClass =
  "min-w-0 flex-1 rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2 text-sm font-bold text-ink-inverse outline-none transition focus:border-accent-400/70 focus:ring-2 focus:ring-accent/15";
const neutralButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-xl border border-line-dark/70 bg-surface-elevated/70 px-3 py-2 text-xs font-black text-ink-inverse transition hover:border-brand-400/55 hover:bg-surface-elevated";

function scopeIncludes(scope: string | null | undefined, expected: string) {
  return new Set((scope ?? "").split(/\s+/).filter(Boolean)).has(expected);
}

function sourceKey(type: SpotifySourceType, spotifyId: string) {
  return `${type}:${spotifyId}`;
}

function revalidateConfiguration() {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/configuracao");
  revalidatePath("/dashboard/configuracao/fontes");
  revalidatePath("/dashboard/configuracao/revisao");
}

async function addSource(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const spotifyId = String(formData.get("spotifyId") ?? "").trim();
  const spotifyTypeRaw = String(formData.get("spotifyType") ?? "").trim();
  const kindRaw = String(formData.get("kind") ?? "").trim();
  const episodeOrderRaw = String(formData.get("episodeOrder") ?? "").trim();

  const spotifyType =
    spotifyTypeRaw === SpotifySourceType.PLAYLIST
      ? SpotifySourceType.PLAYLIST
      : spotifyTypeRaw === SpotifySourceType.SHOW
        ? SpotifySourceType.SHOW
        : spotifyTypeRaw === SpotifySourceType.SAVED_EPISODES
          ? SpotifySourceType.SAVED_EPISODES
          : null;

  const episodeOrder =
    episodeOrderRaw === PodcastEpisodeOrder.OLDEST_FIRST
      ? PodcastEpisodeOrder.OLDEST_FIRST
      : episodeOrderRaw === PodcastEpisodeOrder.NEWEST_FIRST
        ? PodcastEpisodeOrder.NEWEST_FIRST
        : PodcastEpisodeOrder.SOURCE_DEFAULT;

  const requestedKind =
    kindRaw === SourceKind.MUSIC
      ? SourceKind.MUSIC
      : kindRaw === SourceKind.PODCAST
        ? SourceKind.PODCAST
        : null;

  if (!spotifyId || !spotifyType || !requestedKind) {
    redirect("/dashboard/configuracao/fontes?error=invalid");
  }

  const spotifyAccount = await prisma.account.findFirst({
    where: { userId: session.user.id, provider: "spotify" },
    select: { id: true, scope: true },
  });
  if (!spotifyAccount) redirect("/dashboard/configuracao/fontes?error=spotify");

  const hasLibraryScope = scopeIncludes(spotifyAccount.scope, LIBRARY_SCOPE);
  const hasPlaybackScope = scopeIncludes(spotifyAccount.scope, PLAYBACK_SCOPE);

  let sourceName: string | undefined;
  let kind = requestedKind;

  try {
    const client = await SpotifyClient.forUser(session.user.id);

    if (spotifyType === SpotifySourceType.PLAYLIST) {
      if (requestedKind === SourceKind.PODCAST && !hasPlaybackScope) {
        redirect("/dashboard/configuracao/fontes?error=scope");
      }
      const playlists = await client.listCurrentUserPlaylists();
      sourceName = playlists.find((playlist) => playlist.id === spotifyId)?.name;
    } else if (spotifyType === SpotifySourceType.SHOW) {
      if (!hasLibraryScope || !hasPlaybackScope) {
        redirect("/dashboard/configuracao/fontes?error=scope");
      }
      const shows = await client.listSavedShows();
      sourceName = shows.find((show) => show.id === spotifyId)?.name;
      kind = SourceKind.PODCAST;
    } else {
      if (
        spotifyId !== SAVED_EPISODES_ID ||
        !hasLibraryScope ||
        !hasPlaybackScope
      ) {
        redirect("/dashboard/configuracao/fontes?error=scope");
      }
      sourceName = "Seus episódios";
      kind = SourceKind.PODCAST;
    }
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    redirect("/dashboard/configuracao/fontes?error=spotify");
  }

  if (!sourceName) redirect("/dashboard/configuracao/fontes?error=invalid");

  await prisma.sourcePlaylist.upsert({
    where: {
      userId_spotifyType_spotifyId: {
        userId: session.user.id,
        spotifyType,
        spotifyId,
      },
    },
    create: {
      userId: session.user.id,
      spotifyType,
      spotifyId,
      name: sourceName,
      kind,
      enabled: true,
      includePlayed: false,
      episodeOrder:
        spotifyType === SpotifySourceType.SHOW
          ? episodeOrder
          : PodcastEpisodeOrder.SOURCE_DEFAULT,
    },
    update: {
      name: sourceName,
      kind,
      enabled: true,
      ...(spotifyType === SpotifySourceType.SHOW ? { episodeOrder } : {}),
    },
  });

  revalidateConfiguration();
  redirect("/dashboard/configuracao/fontes?saved=added");
}

async function toggleSource(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const id = String(formData.get("id") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "") === "true";
  if (!id) redirect("/dashboard/configuracao/fontes?error=invalid");

  const result = await prisma.sourcePlaylist.updateMany({
    where: { id, userId: session.user.id },
    data: { enabled },
  });
  if (result.count !== 1) redirect("/dashboard/configuracao/fontes?error=invalid");

  revalidateConfiguration();
  redirect("/dashboard/configuracao/fontes?saved=updated");
}

async function updateEpisodeOrder(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const id = String(formData.get("id") ?? "").trim();
  const raw = String(formData.get("episodeOrder") ?? "").trim();
  const episodeOrder =
    raw === PodcastEpisodeOrder.OLDEST_FIRST
      ? PodcastEpisodeOrder.OLDEST_FIRST
      : raw === PodcastEpisodeOrder.NEWEST_FIRST
        ? PodcastEpisodeOrder.NEWEST_FIRST
        : null;
  if (!id || !episodeOrder) redirect("/dashboard/configuracao/fontes?error=invalid");

  const result = await prisma.sourcePlaylist.updateMany({
    where: {
      id,
      userId: session.user.id,
      kind: SourceKind.PODCAST,
      spotifyType: SpotifySourceType.SHOW,
    },
    data: { episodeOrder },
  });
  if (result.count !== 1) redirect("/dashboard/configuracao/fontes?error=invalid");

  revalidateConfiguration();
  redirect("/dashboard/configuracao/fontes?saved=order");
}

async function updatePlaybackPolicy(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const id = String(formData.get("id") ?? "").trim();
  const includePlayed = String(formData.get("includePlayed") ?? "") === "true";
  if (!id) redirect("/dashboard/configuracao/fontes?error=invalid");

  const result = await prisma.sourcePlaylist.updateMany({
    where: { id, userId: session.user.id, kind: SourceKind.PODCAST },
    data: { includePlayed },
  });
  if (result.count !== 1) redirect("/dashboard/configuracao/fontes?error=invalid");

  revalidateConfiguration();
  redirect("/dashboard/configuracao/fontes?saved=policy");
}

async function removeSource(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const id = String(formData.get("id") ?? "").trim();
  if (!id) redirect("/dashboard/configuracao/fontes?error=invalid");

  const result = await prisma.sourcePlaylist.deleteMany({
    where: { id, userId: session.user.id },
  });
  if (result.count !== 1) redirect("/dashboard/configuracao/fontes?error=invalid");

  revalidateConfiguration();
  redirect("/dashboard/configuracao/fontes?saved=removed");
}

async function connectSpotify() {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  await signIn("spotify", {
    redirectTo: "/dashboard/configuracao/fontes",
  });
}

type SpotifySourcesPageProps = {
  searchParams: Promise<{ saved?: string; error?: string }>;
};

export default async function SpotifySourcesPage({
  searchParams,
}: SpotifySourcesPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const params = await searchParams;

  const [spotifyAccount, configuredSources] = await Promise.all([
    prisma.account.findFirst({
      where: { userId: session.user.id, provider: "spotify" },
      select: { id: true, scope: true },
    }),
    prisma.sourcePlaylist.findMany({
      where: { userId: session.user.id },
      orderBy: [{ enabled: "desc" }, { kind: "asc" }, { name: "asc" }],
    }),
  ]);

  const hasLibraryScope = scopeIncludes(spotifyAccount?.scope, LIBRARY_SCOPE);
  const hasPlaybackScope = scopeIncludes(spotifyAccount?.scope, PLAYBACK_SCOPE);
  const podcastReady = hasLibraryScope && hasPlaybackScope;

  let playlists: SpotifyPlaylistSummary[] = [];
  let shows: SpotifyShowSummary[] = [];
  let playlistLoadError = false;
  let showLoadError = false;

  if (spotifyAccount) {
    try {
      const client = await SpotifyClient.forUser(session.user.id);
      playlists = await client.listCurrentUserPlaylists();
      playlists.sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));

      if (hasLibraryScope) {
        try {
          shows = await client.listSavedShows();
          shows.sort((left, right) => left.name.localeCompare(right.name, "pt-BR"));
        } catch {
          showLoadError = true;
        }
      }
    } catch {
      playlistLoadError = true;
    }
  }

  const configuredKeys = new Set(
    configuredSources.map((source) => sourceKey(source.spotifyType, source.spotifyId)),
  );

  const availablePlaylists = playlists.filter(
    (playlist) =>
      !configuredKeys.has(sourceKey(SpotifySourceType.PLAYLIST, playlist.id)),
  );
  const availableShows = shows.filter(
    (show) => !configuredKeys.has(sourceKey(SpotifySourceType.SHOW, show.id)),
  );
  const savedEpisodesConfigured = configuredKeys.has(
    sourceKey(SpotifySourceType.SAVED_EPISODES, SAVED_EPISODES_ID),
  );

  return (
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />

      <div className="relative mx-auto max-w-6xl">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Link
              href="/dashboard/configuracao"
              className="inline-flex items-center gap-2 text-sm font-bold text-muted-inverse transition hover:text-ink-inverse"
            >
              <UiIcon name="arrow-left" size={18} />
              Central de configuração
            </Link>
            <p className="mt-6 text-xs font-black uppercase tracking-[0.17em] text-accent-400">CONFIG-02</p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
              Fontes do Spotify
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-inverse sm:text-base">
              Escolha músicas e podcasts que alimentam o Sonoriza. Para podcasts, você pode usar Seus episódios de uma vez ou selecionar programas específicos.
            </p>
          </div>

          <div className="product-card px-4 py-3 text-sm">
            <p className="font-bold text-ink-inverse">Conta atual</p>
            <p className="mt-1 text-muted-inverse">{session.user.email}</p>
          </div>
        </header>

        {params.saved && (
          <div className="status-success mt-7 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="check" size={17} className="mt-0.5 shrink-0" />
            <span>
              {params.saved === "added" && "Fonte adicionada. Nenhuma geração foi iniciada."}
              {params.saved === "updated" && "Estado da fonte atualizado."}
              {params.saved === "policy" && "Política de episódios atualizada. Uma nova simulação será necessária."}
              {params.saved === "order" && "Ordem do programa atualizada. Uma nova simulação será necessária."}
              {params.saved === "removed" && "Fonte removida da configuração."}
            </span>
          </div>
        )}

        {params.error && (
          <div className="status-warning mt-7 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="warning" size={17} className="mt-0.5 shrink-0" />
            <span>
              {params.error === "scope"
                ? "Reconecte o Spotify para permitir leitura dos episódios salvos e da posição de reprodução."
                : params.error === "invalid"
                  ? "A fonte não pôde ser validada na sua conta Spotify. Atualize a página e tente novamente."
                  : "Não foi possível consultar o Spotify agora. Revise a conexão e tente novamente."}
            </span>
          </div>
        )}

        {!spotifyAccount ? (
          <section className="product-panel mt-7 p-6 sm:p-8">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">Conexão necessária</p>
            <h2 className="mt-2 text-2xl font-black text-ink-inverse">Conecte o Spotify primeiro</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-inverse">
              A configuração usa somente conteúdo visível na sua própria conta e não aceita IDs técnicos digitados manualmente.
            </p>
            <form action={connectSpotify}>
              <button type="submit" className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 shadow-action transition hover:bg-accent-400">
                <UiIcon name="repeat" size={17} />
                Conectar Spotify
              </button>
            </form>
          </section>
        ) : (
          <>
            {!podcastReady && (
              <section className="status-warning mt-7 flex flex-col gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="flex items-center gap-2 font-black">
                    <UiIcon name="warning" size={18} />
                    Reconecte para liberar o controle de podcasts
                  </p>
                  <p className="mt-1 max-w-3xl text-sm leading-6 opacity-75">
                    O novo acesso permite ler Seus episódios, saber quais já foram concluídos e considerar somente o tempo restante dos que você começou a ouvir. O Sonoriza não recebe acesso ao áudio nem à sua senha.
                  </p>
                </div>
                <form action={connectSpotify}>
                  <button type="submit" className="inline-flex whitespace-nowrap items-center gap-2 rounded-xl border border-warning/35 bg-warning/10 px-4 py-2.5 text-sm font-black transition hover:bg-warning/15">
                    <UiIcon name="repeat" size={17} />
                    Reconectar Spotify
                  </button>
                </form>
              </section>
            )}

            <section className="product-panel mt-7 p-5 sm:p-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Configuradas</p>
                  <h2 className="mt-1 text-xl font-black text-ink-inverse">Fontes em uso</h2>
                  <p className="mt-1 text-sm text-muted-inverse">
                    Desativar mantém a fonte cadastrada, mas ela deixa de alimentar a próxima geração.
                  </p>
                </div>
                <span className="product-badge">
                  {configuredSources.filter((source) => source.enabled).length} ativas
                </span>
              </div>

              {configuredSources.length === 0 ? (
                <div className="mt-5 rounded-2xl border border-dashed border-line-dark bg-surface-subtle/55 p-6 text-center">
                  <p className="font-bold text-ink-inverse">Nenhuma fonte configurada</p>
                  <p className="mt-1 text-sm text-muted-inverse">Adicione uma playlist, Seus episódios ou um programa abaixo.</p>
                </div>
              ) : (
                <div className="mt-5 grid gap-3 md:grid-cols-2">
                  {configuredSources.map((source) => (
                    <article
                      key={source.id}
                      className={`rounded-2xl border p-4 transition ${
                        source.enabled
                          ? "border-line-dark/65 bg-surface-subtle/70"
                          : "border-line-dark/40 bg-surface-subtle/35 opacity-70"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="product-badge px-2.5 py-1 text-[0.68rem] uppercase tracking-wide">
                              {source.spotifyType === SpotifySourceType.SAVED_EPISODES
                                ? "Biblioteca"
                                : source.spotifyType === SpotifySourceType.SHOW
                                  ? "Programa"
                                  : "Playlist"}
                            </span>
                            <span className="product-badge border-accent/30 bg-accent/10 px-2.5 py-1 text-[0.68rem] uppercase tracking-wide text-accent-400">
                              {source.kind === SourceKind.MUSIC ? "Música" : "Podcast"}
                            </span>
                          </div>
                          <h3 className="mt-3 truncate font-black text-ink-inverse">{source.name ?? "Fonte do Spotify"}</h3>
                        </div>
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.68rem] font-black ${source.enabled ? "status-success" : "product-badge"}`}>
                          <UiIcon name={source.enabled ? "check" : "warning"} size={13} />
                          {source.enabled ? "Ativa" : "Desativada"}
                        </span>
                      </div>

                      {source.spotifyType === SpotifySourceType.SHOW && (
                        <div className="mt-4 rounded-xl border border-accent/20 bg-accent/5 p-3">
                          <p className="text-xs font-black text-accent-400">Ordem dos episódios</p>
                          <p className="mt-1 text-xs leading-5 text-muted-inverse">
                            Este programa tem prioridade sobre “Seus episódios” e playlists genéricas para o mesmo show.
                          </p>
                          <form action={updateEpisodeOrder} className="mt-3 flex gap-2">
                            <input type="hidden" name="id" value={source.id} />
                            <select
                              name="episodeOrder"
                              defaultValue={
                                source.episodeOrder === PodcastEpisodeOrder.NEWEST_FIRST
                                  ? PodcastEpisodeOrder.NEWEST_FIRST
                                  : PodcastEpisodeOrder.OLDEST_FIRST
                              }
                              className={selectClass}
                            >
                              <option value={PodcastEpisodeOrder.OLDEST_FIRST}>Mais antigos primeiro</option>
                              <option value={PodcastEpisodeOrder.NEWEST_FIRST}>Mais novos primeiro</option>
                            </select>
                            <button type="submit" className={neutralButtonClass}>
                              <UiIcon name="check" size={15} />
                              Salvar
                            </button>
                          </form>
                        </div>
                      )}

                      {source.kind === SourceKind.PODCAST && (
                        <div className="mt-4 rounded-xl border border-line-dark/55 bg-surface-dark/45 p-3">
                          <p className="text-xs font-black text-ink-inverse">Episódios já concluídos</p>
                          <p className="mt-1 text-xs leading-5 text-muted-inverse">
                            {source.includePlayed
                              ? "Podem voltar à seleção e contam com a duração inteira."
                              : "Ficam de fora. Episódios em andamento contam apenas pelo tempo restante."}
                          </p>
                          <form action={updatePlaybackPolicy} className="mt-3">
                            <input type="hidden" name="id" value={source.id} />
                            <input type="hidden" name="includePlayed" value={source.includePlayed ? "false" : "true"} />
                            <button type="submit" className={neutralButtonClass}>
                              <UiIcon name="repeat" size={15} />
                              {source.includePlayed ? "Usar somente não concluídos" : "Incluir já escutados"}
                            </button>
                          </form>
                        </div>
                      )}

                      <div className="mt-4 flex flex-wrap gap-2">
                        <form action={toggleSource}>
                          <input type="hidden" name="id" value={source.id} />
                          <input type="hidden" name="enabled" value={source.enabled ? "false" : "true"} />
                          <button type="submit" className={neutralButtonClass}>
                            <UiIcon name={source.enabled ? "warning" : "check"} size={15} />
                            {source.enabled ? "Desativar" : "Ativar"}
                          </button>
                        </form>
                        <form action={removeSource}>
                          <input type="hidden" name="id" value={source.id} />
                          <button type="submit" className="inline-flex items-center gap-1.5 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-black text-danger transition hover:bg-danger/15">
                            <UiIcon name="trash" size={15} />
                            Remover
                          </button>
                        </form>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <section className="product-panel p-5 sm:p-6">
                <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">Playlists</p>
                <h2 className="mt-1 text-xl font-black text-ink-inverse">Adicionar playlist</h2>
                <p className="mt-1 text-sm leading-6 text-muted-inverse">
                  Escolha se a playlist fornece músicas ou, quando ela realmente contiver episódios, podcasts.
                </p>

                {playlistLoadError ? (
                  <div className="status-warning mt-5 flex items-center gap-2 rounded-2xl border p-4 text-sm">
                    <UiIcon name="warning" size={17} />
                    Não foi possível listar suas playlists agora.
                  </div>
                ) : availablePlaylists.length === 0 ? (
                  <div className="mt-5 rounded-2xl border border-dashed border-line-dark bg-surface-subtle/55 p-5 text-sm text-muted-inverse">
                    Todas as playlists visíveis já estão configuradas, ou sua conta não possui playlists disponíveis.
                  </div>
                ) : (
                  <div className="mt-5 max-h-[38rem] space-y-3 overflow-y-auto pr-1">
                    {availablePlaylists.map((playlist) => (
                      <form key={playlist.id} action={addSource} className="product-card p-4">
                        <input type="hidden" name="spotifyId" value={playlist.id} />
                        <input type="hidden" name="spotifyType" value={SpotifySourceType.PLAYLIST} />
                        <div className="min-w-0">
                          <h3 className="truncate font-black text-ink-inverse">{playlist.name}</h3>
                          <p className="mt-1 truncate text-xs text-muted-inverse/65">
                            {playlist.ownerName ?? "Spotify"}{playlist.collaborative ? " · colaborativa" : ""}
                          </p>
                        </div>
                        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                          <select name="kind" defaultValue={SourceKind.MUSIC} className={selectClass}>
                            <option value={SourceKind.MUSIC}>Usar como música</option>
                            <option value={SourceKind.PODCAST}>Usar como podcast</option>
                          </select>
                          <button type="submit" className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-sm font-black text-brand-900 transition hover:bg-accent-400">
                            <UiIcon name="plus" size={16} />
                            Adicionar
                          </button>
                        </div>
                      </form>
                    ))}
                  </div>
                )}
              </section>

              <section className="product-panel p-5 sm:p-6">
                <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Podcasts</p>
                <h2 className="mt-1 text-xl font-black text-ink-inverse">Seus episódios ou programas</h2>
                <p className="mt-1 text-sm leading-6 text-muted-inverse">
                  Seus episódios evita escolher programa por programa. O limite por programa continua valendo porque cada episódio mantém o programa de origem.
                </p>

                {!podcastReady ? (
                  <div className="status-warning mt-5 rounded-2xl border p-5">
                    <p className="flex items-center gap-2 font-black">
                      <UiIcon name="warning" size={17} />
                      Autorização adicional necessária
                    </p>
                    <p className="mt-2 text-sm leading-6 opacity-75">
                      Reconecte o Spotify acima para liberar episódios salvos, estado de escuta e tempo restante.
                    </p>
                  </div>
                ) : (
                  <>
                    {!savedEpisodesConfigured && (
                      <form action={addSource} className="mt-5 rounded-2xl border border-brand-400/35 bg-brand/10 p-5">
                        <input type="hidden" name="spotifyId" value={SAVED_EPISODES_ID} />
                        <input type="hidden" name="spotifyType" value={SpotifySourceType.SAVED_EPISODES} />
                        <input type="hidden" name="kind" value={SourceKind.PODCAST} />
                        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="text-xs font-black uppercase tracking-[0.12em] text-brand-400">Recomendado</p>
                            <h3 className="mt-1 text-lg font-black text-ink-inverse">Seus episódios</h3>
                            <p className="mt-1 max-w-xl text-sm leading-6 text-muted-inverse">
                              Usa diretamente a coleção que aparece no Spotify como “Seus episódios”. Por padrão, episódios concluídos ficam de fora.
                            </p>
                          </div>
                          <button type="submit" className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-brand-400/35 bg-brand/15 px-4 py-2.5 text-sm font-black text-ink-inverse transition hover:bg-brand/25">
                            <UiIcon name="plus" size={16} />
                            Adicionar Seus episódios
                          </button>
                        </div>
                      </form>
                    )}

                    <div className="mt-5 border-t border-line-dark/50 pt-5">
                      <p className="text-sm font-black text-ink-inverse">Ou selecione programas individuais</p>
                      {showLoadError ? (
                        <div className="status-warning mt-4 flex items-center gap-2 rounded-2xl border p-4 text-sm">
                          <UiIcon name="warning" size={17} />
                          Não foi possível listar seus programas salvos agora.
                        </div>
                      ) : availableShows.length === 0 ? (
                        <div className="mt-4 rounded-2xl border border-dashed border-line-dark bg-surface-subtle/55 p-5 text-sm text-muted-inverse">
                          Nenhum programa salvo disponível para adicionar.
                        </div>
                      ) : (
                        <div className="mt-4 max-h-[31rem] space-y-3 overflow-y-auto pr-1">
                          {availableShows.map((show) => (
                            <form key={show.id} action={addSource} className="product-card p-4">
                              <input type="hidden" name="spotifyId" value={show.id} />
                              <input type="hidden" name="spotifyType" value={SpotifySourceType.SHOW} />
                              <input type="hidden" name="kind" value={SourceKind.PODCAST} />
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <h3 className="truncate font-black text-ink-inverse">{show.name}</h3>
                                  <p className="mt-1 truncate text-xs text-muted-inverse/65">{show.publisher ?? "Programa do Spotify"}</p>
                                </div>
                              </div>
                              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                                <select name="episodeOrder" defaultValue={PodcastEpisodeOrder.OLDEST_FIRST} className={selectClass}>
                                  <option value={PodcastEpisodeOrder.OLDEST_FIRST}>Mais antigos primeiro</option>
                                  <option value={PodcastEpisodeOrder.NEWEST_FIRST}>Mais novos primeiro</option>
                                </select>
                                <button type="submit" className={neutralButtonClass}>
                                  <UiIcon name="plus" size={15} />
                                  Adicionar
                                </button>
                              </div>
                            </form>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </section>
            </div>

            <p className="mt-6 text-center text-xs leading-5 text-muted-inverse/60">
              Alterar fontes não executa nem modifica playlists de destino automaticamente.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
