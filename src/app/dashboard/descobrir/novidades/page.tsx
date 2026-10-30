import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import {
  RELEASE_RADAR_DEFAULTS,
  readReleaseRadar,
  refreshReleaseRadar,
} from "@/services/releases/release-radar";
import { getActiveSpotifyBackoff } from "@/services/spotify/backoff";
import { SpotifyClient } from "@/services/spotify/client";

const PAGE_PATH = "/dashboard/descobrir/novidades";

async function refreshRadar() {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const userId = session.user.id;

  // Each refresh costs ~1 Spotify read per seed artist plus one per release.
  const current = await readReleaseRadar(userId);
  if (
    current &&
    Date.now() - current.fetchedAt.getTime() < RELEASE_RADAR_DEFAULTS.minRefreshIntervalMs
  ) {
    redirect(`${PAGE_PATH}?status=recent`);
  }

  if (await getActiveSpotifyBackoff()) redirect(`${PAGE_PATH}?status=blocked`);

  let persisted = false;
  try {
    const client = await SpotifyClient.forUser(userId);
    ({ persisted } = await refreshReleaseRadar({
      userId,
      reader: {
        artistReleases: (artistId) => client.getArtistRecentReleases(artistId),
        releaseTracks: (albumId) => client.getReleaseTracks(albumId),
      },
    }));
  } catch (error) {
    console.error("RELEASES-01 refresh failed", error);
    redirect(`${PAGE_PATH}?status=failed`);
  }
  revalidatePath(PAGE_PATH);
  redirect(`${PAGE_PATH}?status=${persisted ? "updated" : "failed"}`);
}

type PageProps = { searchParams: Promise<{ status?: string }> };

export default async function NewReleasesPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const params = await searchParams;
  const radar = await readReleaseRadar(session.user.id);

  const notice =
    params.status === "updated"
      ? { tone: "status-success", text: "Radar atualizado. Nenhuma playlist foi alterada." }
      : params.status === "recent"
        ? { tone: "status-info", text: "O radar foi atualizado há poucos minutos. Tente de novo daqui a pouco." }
        : params.status === "blocked"
          ? { tone: "status-warning", text: "O Spotify está temporariamente bloqueado (cota). O último radar foi mantido; tente depois do horário indicado no aviso." }
          : params.status === "failed"
          ? { tone: "status-danger", text: "Não foi possível consultar o Spotify agora. O último radar foi mantido." }
          : null;

  return (
    <div className="space-y-5">
      <section className="product-panel p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="product-icon-tile-accent h-12 w-12 shrink-0">
              <UiIcon name="bell" size={22} />
            </span>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Novidades</p>
              <h2 className="mt-1 text-2xl font-black text-ink-inverse">Radar de lançamentos</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-inverse">
                Álbuns e singles lançados nos últimos {RELEASE_RADAR_DEFAULTS.windowDays} dias pelos artistas das suas curtidas e dos que você mais ouviu nos últimos 90 dias. Esta tela só consulta o Spotify; nenhuma playlist é alterada.
              </p>
            </div>
          </div>
          <form action={refreshRadar}>
            <button type="submit" className="primary-button w-full sm:w-auto">
              Atualizar radar
            </button>
          </form>
        </div>
        {notice && (
          <p className={`${notice.tone} mt-4 rounded-2xl border px-4 py-3 text-sm font-bold`}>
            {notice.text}
          </p>
        )}
        {radar && (
          <p className="mt-4 text-xs text-muted-inverse/70">
            Atualizado em {formatDateTime(radar.fetchedAt)} · {radar.seedCount} artistas consultados ·{" "}
            {radar.releases.length} lançamentos
            {radar.evidence?.failures
              ? ` · ${radar.evidence.failures} consulta(s) falharam`
              : ""}
          </p>
        )}
      </section>

      {!radar ? (
        <section className="product-panel p-7 text-center">
          <p className="font-black text-ink-inverse">Radar ainda vazio</p>
          <p className="mt-2 text-sm text-muted-inverse">
            Clique em “Atualizar radar” para buscar os lançamentos recentes dos seus artistas.
          </p>
        </section>
      ) : radar.releases.length === 0 ? (
        <section className="product-panel p-7 text-center">
          <p className="font-black text-ink-inverse">Nenhum lançamento recente</p>
          <p className="mt-2 text-sm text-muted-inverse">
            Nenhum dos seus artistas lançou álbum ou single nos últimos {radar.windowDays} dias.
          </p>
        </section>
      ) : (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {radar.releases.map((release) => {
            const fresh = release.tracks.filter((track) => !track.alreadyHeard).length;
            return (
              <article key={release.albumId} className="product-card flex gap-4 p-4">
                {release.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- Spotify CDN art, fixed size
                  <img
                    src={release.imageUrl}
                    alt=""
                    width={88}
                    height={88}
                    className="h-[88px] w-[88px] shrink-0 rounded-xl object-cover"
                  />
                ) : (
                  <span className="product-icon-tile h-[88px] w-[88px] shrink-0">
                    <UiIcon name="music" size={28} />
                  </span>
                )}
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-1.5">
                    <span className="product-badge">{release.albumType === "single" ? "Single" : "Álbum"}</span>
                    <span className="product-badge">{formatReleaseDate(release.releaseDate)}</span>
                  </div>
                  <h3 className="mt-2 truncate font-black text-ink-inverse" title={release.name}>
                    {release.name}
                  </h3>
                  <p className="truncate text-sm text-muted-inverse">{release.artists.join(", ")}</p>
                  <p className="mt-1 text-xs text-muted-inverse/70">
                    {release.tracks.length} faixa(s){fresh < release.tracks.length ? ` · ${fresh} ainda não ouvida(s)` : ""}
                  </p>
                  <a
                    href={`https://open.spotify.com/album/${release.albumId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="product-link mt-2 text-xs"
                  >
                    Abrir no Spotify
                    <UiIcon name="arrow-right" size={14} />
                  </a>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(value);
}

function formatReleaseDate(value: string) {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) return value || "data desconhecida";
  return match[3] ? `${match[3]}/${match[2]}/${match[1]}` : `${match[2]}/${match[1]}`;
}
