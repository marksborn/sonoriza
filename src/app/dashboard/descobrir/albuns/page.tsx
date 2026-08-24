import Link from "next/link";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { getAlbumUiRecommendations } from "@/services/album-discovery/ui-snapshot";

export default async function AlbumsPage({
  searchParams,
}: {
  searchParams: Promise<{ added?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const query = await searchParams;

  let report: Awaited<ReturnType<typeof getAlbumUiRecommendations>> | null = null;
  let loadFailed = false;
  try {
    report = await getAlbumUiRecommendations(session.user.id);
  } catch (error) {
    loadFailed = true;
    console.error("ALBUM-UI recommendation snapshot load failed", error);
  }

  return (
    <div className="space-y-5">
      {query.added === "1" ? (
        <div className="status-success flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm font-bold">
          <UiIcon name="check" size={18} className="mt-0.5 shrink-0" />
          <span>Álbum adicionado à playlist Adicionar e registrado como enfileirado.</span>
        </div>
      ) : null}

      <section className="product-panel p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">Álbuns</p>
            <h2 className="mt-1 text-2xl font-black tracking-tight text-ink-inverse sm:text-3xl">
              Álbuns para conhecer
            </h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-inverse">
              O Sonoriza cruza afinidade, cobertura do álbum, atividade recente e sinais de escuta para sugerir onde vale aprofundar agora.
            </p>
          </div>
          {report ? (
            <div className="flex flex-wrap gap-2 text-xs font-bold text-muted-inverse sm:justify-end">
              <span className="product-badge px-3 py-1.5">
                {report.visibleRecommendations.length} sugestões
              </span>
              <span className="product-badge px-3 py-1.5">{report.queuedCount} enfileirado</span>
              <span className="product-badge px-3 py-1.5">{snapshotAge(report.generatedAt)}</span>
            </div>
          ) : null}
        </div>
      </section>

      {loadFailed || !report ? (
        <section className="product-panel p-6">
          <div className="status-warning flex items-start gap-3 rounded-2xl border px-4 py-4">
            <UiIcon name="warning" size={20} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-black">Não foi possível carregar as recomendações agora.</p>
              <p className="mt-1 text-sm opacity-80">
                Nenhuma alteração foi feita. O último snapshot válido permanece separado do fluxo de escrita do Spotify.
              </p>
            </div>
          </div>
        </section>
      ) : report.visibleRecommendations.length === 0 ? (
        <section className="product-panel p-8 text-center">
          <span className="product-icon-tile mx-auto h-12 w-12">
            <UiIcon name="check" size={22} />
          </span>
          <h3 className="mt-4 text-xl font-black text-ink-inverse">Nada urgente para aprofundar</h3>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-muted-inverse">
            As edições já enfileiradas são conferidas diretamente na memória do Sonoriza e não voltam a ocupar o ranking enquanto estiverem em QUEUED.
          </p>
        </section>
      ) : (
        <section className="grid gap-4 lg:grid-cols-2">
          {report.visibleRecommendations.map((candidate, index) => (
            <article
              key={candidate.spotifyAlbumId}
              className={`product-panel flex flex-col overflow-hidden p-5 sm:p-6 ${
                index === 0 ? "lg:col-span-2" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-4">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-brand-400/25 bg-brand/15 text-lg font-black text-accent-400">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-brand-400">{candidate.artistName}</p>
                    <h3 className="mt-1 text-xl font-black leading-tight text-ink-inverse sm:text-2xl">
                      {candidate.albumName}
                    </h3>
                    <p className="mt-1 text-xs text-muted-inverse">
                      {candidate.releaseDate ? candidate.releaseDate.slice(0, 4) : "Ano não informado"} · edição Spotify exata
                    </p>
                  </div>
                </div>
                <span className="rounded-2xl border border-accent/25 bg-accent/10 px-3 py-2 text-center">
                  <strong className="block text-lg font-black text-accent-400">{candidate.score}</strong>
                  <span className="text-[10px] font-black uppercase tracking-[0.12em] text-muted-inverse">score</span>
                </span>
              </div>

              <div className="mt-5 rounded-2xl border border-line-dark/55 bg-surface-subtle/65 p-4">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-bold text-ink-inverse">{candidate.coverageSummary}</span>
                  <span className="text-muted-inverse">{candidate.plays30d} plays em 30d</span>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-elevated">
                  <div
                    className="h-full rounded-full bg-brand-400"
                    style={{ width: `${Math.max(2, Math.min(100, candidate.coveragePercent))}%` }}
                  />
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {candidate.reasons.map((reason) => (
                  <span key={reason} className="product-badge px-3 py-1.5 text-xs">
                    {reason}
                  </span>
                ))}
              </div>

              <div className="mt-auto pt-6">
                <Link
                  href={`/dashboard/descobrir/albuns/${candidate.spotifyAlbumId}`}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 text-sm font-black text-brand-900 shadow-action transition hover:bg-accent-400 sm:w-auto"
                >
                  Revisar álbum
                  <UiIcon name="arrow-right" size={17} />
                </Link>
              </div>
            </article>
          ))}
        </section>
      )}

      {report && report.providerFailureCount > 0 ? (
        <p className="px-1 text-xs text-muted-inverse">
          Algumas fontes não responderam ({report.providerFailureCount}); o snapshot exibido usa apenas dados válidos disponíveis.
        </p>
      ) : null}
    </div>
  );
}

function snapshotAge(generatedAt: string): string {
  const ageMs = Math.max(0, Date.now() - new Date(generatedAt).getTime());
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "atualizado agora";
  if (minutes === 1) return "atualizado há 1 min";
  if (minutes < 60) return `atualizado há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "atualizado há 1 h" : `atualizado há ${hours} h`;
}
