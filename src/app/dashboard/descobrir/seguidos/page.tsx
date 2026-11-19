import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  grantHasFollowScope,
  isFollowedCatalogRefreshRunning,
  lastFollowedCatalogRefreshOutcome,
  resolveFollowedCatalogMode,
  runFollowedCatalogRefresh,
  startFollowedCatalogRefresh,
} from "@/services/followed-artists/followed-catalog-auto";
import {
  FOLLOWED_CATALOG_POLICY,
  readFollowedCatalog,
  type FollowedCatalogExclusion,
} from "@/services/followed-artists/followed-catalog";
import { getActiveSpotifyBackoff } from "@/services/spotify/backoff";

import { FollowedRefreshButton, FollowedRefreshPoller } from "./refresh-controls";

const PAGE_PATH = "/dashboard/descobrir/seguidos";

const EXCLUSION_LABELS: Record<FollowedCatalogExclusion, string> = {
  LIKED: "já curtidas",
  HEARD_SPOTIFY_STATE: "já tocadas pelo Sonoriza",
  HEARD_LASTFM_NAME: "já no seu Last.fm",
  VERSION_AMBIGUOUS: "versões (ao vivo, remaster, remix...)",
  NOT_PRIMARY_ARTIST: "participações",
  NOT_OWN_RELEASE: "coletâneas e lançamentos de terceiros",
  DURATION: "duração fora de 1:30 a 10 min",
  UNPLAYABLE: "indisponíveis",
  CAP: "acima do limite por álbum/artista",
  DUPLICATE: "repetidas",
};

async function refreshCatalog() {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const userId = session.user.id;

  const current = await readFollowedCatalog(userId);
  if (
    current &&
    Date.now() - current.fetchedAt.getTime() < FOLLOWED_CATALOG_POLICY.minRefreshIntervalMs
  ) {
    redirect(`${PAGE_PATH}?status=recent`);
  }
  if (await getActiveSpotifyBackoff()) redirect(`${PAGE_PATH}?status=blocked`);

  // A first read takes over a minute; run it in the background so the browser
  // never waits on (and aborts) the form post. The page polls until it ends.
  startFollowedCatalogRefresh(userId, () => runFollowedCatalogRefresh(userId));
  revalidatePath(PAGE_PATH);
  redirect(`${PAGE_PATH}?status=started`);
}

type PageProps = { searchParams: Promise<{ status?: string }> };

export default async function FollowedArtistsPage({ searchParams }: PageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const params = await searchParams;
  const [catalog, account] = await Promise.all([
    readFollowedCatalog(session.user.id),
    prisma.account.findFirst({
      where: { userId: session.user.id, provider: "spotify" },
      select: { scope: true },
    }),
  ]);
  const hasScope = grantHasFollowScope(account?.scope);
  const running = isFollowedCatalogRefreshRunning(session.user.id);
  const outcome = params.status === "started" ? lastFollowedCatalogRefreshOutcome(session.user.id) : null;
  const status = params.status === "started" ? (running ? "running" : outcome) : params.status;
  const autoOn = resolveFollowedCatalogMode(process.env.FOLLOWED_ARTISTS_CATALOG_MODE) === "ACTIVE";

  const notice =
    running
      ? { tone: "status-info", text: "Lendo os artistas no Spotify. Leva cerca de 1 a 2 minutos; a página atualiza sozinha. Pode sair daqui, a leitura continua." }
      : status === "updated"
      ? { tone: "status-success", text: "Catálogo atualizado. Nenhuma playlist foi alterada." }
      : status === "recent"
        ? { tone: "status-info", text: "O catálogo já foi atualizado hoje. Para poupar a cota do Spotify, a próxima atualização fica disponível amanhã." }
        : status === "blocked"
          ? { tone: "status-warning", text: "O Spotify está temporariamente bloqueado (cota). O último catálogo foi mantido." }
          : status === "failed"
            ? { tone: "status-danger", text: "Não foi possível consultar o Spotify agora. O último catálogo foi mantido." }
            : null;

  const excluded = Object.entries(catalog?.evidence?.excluded ?? {})
    .filter(([, count]) => (count ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  const checkedTotal = catalog ? Object.keys(catalog.artistChecks).length : 0;

  return (
    <div className="space-y-5">
      <FollowedRefreshPoller active={running} />
      <section className="product-panel p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="product-icon-tile-accent h-12 w-12 shrink-0">
              <UiIcon name="search" size={22} />
            </span>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Artistas que sigo</p>
              <h2 className="mt-1 text-2xl font-black text-ink-inverse">Músicas que você ainda não curtiu</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-inverse">
                Faixas dos artistas que você segue no Spotify que não estão nas suas curtidas e não aparecem no seu histórico. Para poupar a cota, o Sonoriza lê {FOLLOWED_CATALOG_POLICY.artistsPerRefresh} artistas por dia em rodízio, 2 álbuns de cada vez, priorizando quem você mais ouve no Last.fm. Seguir um artista não vira preferência de gosto.{" "}
                <strong className="text-ink-inverse">Em teste: nenhuma destas faixas entra em playlist ainda.</strong>
              </p>
            </div>
          </div>
          {hasScope && (
            <form action={refreshCatalog}>
              <FollowedRefreshButton running={running} />
            </form>
          )}
        </div>
        {notice && (
          <p className={`${notice.tone} mt-4 rounded-2xl border px-4 py-3 text-sm font-bold`}>{notice.text}</p>
        )}
        {catalog && (
          <p className="mt-4 text-xs text-muted-inverse/70">
            Atualizado em {formatDateTime(catalog.fetchedAt)} · {catalog.followedCount} artistas seguidos ·{" "}
            {checkedTotal} já lidos · {catalog.candidates.length} faixas
            {catalog.evidence?.failures ? ` · ${catalog.evidence.failures} consulta(s) falharam` : ""}
            {autoOn ? " · atualização diária automática ligada" : " · atualização automática desligada"}
          </p>
        )}
      </section>

      {!hasScope ? (
        <section className="product-panel p-7 text-center">
          <p className="font-black text-ink-inverse">Permissão necessária</p>
          <p className="mt-2 text-sm text-muted-inverse">
            Reconecte o Spotify em Configuração → Fontes para liberar a leitura dos artistas que você segue.
          </p>
        </section>
      ) : !catalog ? (
        <section className="product-panel p-7 text-center">
          <p className="font-black text-ink-inverse">Catálogo ainda vazio</p>
          <p className="mt-2 text-sm text-muted-inverse">
            {running
              ? "A primeira leitura está em andamento."
              : "Clique em “Atualizar agora” para ler os primeiros artistas."}
          </p>
        </section>
      ) : (
        <>
          {excluded.length > 0 && (
            <section className="product-panel p-5">
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Ficaram de fora na última leitura</p>
              <ul className="mt-3 flex flex-wrap gap-2">
                {excluded.map(([reason, count]) => (
                  <li key={reason} className="product-badge">
                    {count} {EXCLUSION_LABELS[reason as FollowedCatalogExclusion] ?? reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {catalog.candidates.length === 0 ? (
            <section className="product-panel p-7 text-center">
              <p className="font-black text-ink-inverse">Nenhuma faixa nova por enquanto</p>
              <p className="mt-2 text-sm text-muted-inverse">
                Os álbuns lidos até agora só tinham faixas que você já conhece. A leitura continua amanhã.
              </p>
            </section>
          ) : (
            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {catalog.candidates.map((candidate) => (
                <article key={candidate.uri} className="product-card flex gap-4 p-4">
                  {candidate.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Spotify CDN art, fixed size
                    <img
                      src={candidate.imageUrl}
                      alt=""
                      width={72}
                      height={72}
                      className="h-[72px] w-[72px] shrink-0 rounded-xl object-cover"
                    />
                  ) : (
                    <span className="product-icon-tile h-[72px] w-[72px] shrink-0">
                      <UiIcon name="music" size={24} />
                    </span>
                  )}
                  <div className="min-w-0">
                    <h3 className="truncate font-black text-ink-inverse" title={candidate.name}>
                      {candidate.name}
                    </h3>
                    <p className="truncate text-sm text-muted-inverse">{candidate.artistName}</p>
                    <p className="truncate text-xs text-muted-inverse/70" title={candidate.albumName}>
                      {candidate.albumName}
                      {candidate.releaseDate ? ` · ${candidate.releaseDate.slice(0, 4)}` : ""}
                    </p>
                    <p className="mt-1 text-xs text-muted-inverse/70">
                      Artista que você segue; faixa ainda não curtida; sem escuta conhecida no histórico disponível.
                    </p>
                    <a
                      href={`https://open.spotify.com/track/${candidate.spotifyTrackId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="product-link mt-2 text-xs"
                    >
                      Abrir no Spotify
                      <UiIcon name="arrow-right" size={14} />
                    </a>
                  </div>
                </article>
              ))}
            </section>
          )}
        </>
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
