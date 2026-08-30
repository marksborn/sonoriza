import { ProductMetricCard } from "@/components/ProductMetricCard";
import { ProductSectionHeader } from "@/components/ProductSectionHeader";
import type { ListeningHistoryStats } from "@/services/listening-history/stats";

export function HistoryStatsPanel({ stats }: { stats: ListeningHistoryStats }) {
  const hasUnmeasuredEvents =
    stats.playCount > 0 && stats.measuredPlayEvents === 0;

  return (
    <section className="product-panel overflow-hidden p-5 sm:p-6">
      <ProductSectionHeader
        eyebrow="Estatísticas"
        title="Seu padrão neste filtro"
        icon="list"
        iconTone="accent"
      />

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <ProductMetricCard
          value={stats.distinctTracks.toLocaleString("pt-BR")}
          label="Faixas distintas"
        />
        <ProductMetricCard
          value={stats.distinctArtists.toLocaleString("pt-BR")}
          label="Artistas distintos"
        />
        <ProductMetricCard
          value={stats.distinctAlbums.toLocaleString("pt-BR")}
          label="Álbuns distintos"
        />
        <ProductMetricCard
          value={
            hasUnmeasuredEvents
              ? "Sem duração medida"
              : formatListeningDuration(stats.measuredListeningMs)
          }
          label={
            hasUnmeasuredEvents
              ? `${stats.playCount.toLocaleString("pt-BR")} eventos sem cobertura`
              : "Tempo medido"
          }
          compact={hasUnmeasuredEvents}
          detail={
            stats.playCount === 0
              ? "Sem eventos neste filtro"
              : hasUnmeasuredEvents
                ? undefined
                : `${stats.measuredPlayEvents.toLocaleString("pt-BR")} de ${stats.playCount.toLocaleString("pt-BR")} eventos · ${formatPercent(stats.measuredCoveragePercent)}`
          }
        />
      </div>

      <details className="group mt-2 text-[11px] text-muted-inverse/85">
        <summary className="min-h-10 cursor-pointer list-none rounded-lg py-2 font-black text-brand-300 transition hover:text-accent-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400">
          <span className="inline-flex items-center gap-1.5">
            Como calculamos o tempo
            <span aria-hidden="true" className="transition group-open:rotate-180">⌄</span>
          </span>
        </summary>
        <p className="rounded-xl border border-line-dark/50 bg-surface-elevated/45 p-3 leading-5">
          Somamos apenas reproduções com duração factual disponível no histórico importado. Eventos sem essa informação continuam nas contagens e rankings, sem estimativa de tempo.
        </p>
      </details>

      <div
        className="-mx-5 mt-5 flex snap-x snap-mandatory gap-3 overflow-x-auto px-5 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0 lg:pb-0"
        aria-label="Rankings do período"
      >
        <RankingCard
          title="Faixas mais ouvidas"
          empty="Nenhuma faixa neste filtro"
          rows={stats.topTracks.map((item) => ({
            key: `${item.artistName}\u0000${item.trackName}`,
            primary: item.trackName,
            secondary: item.artistName,
            count: item.playCount,
          }))}
        />
        <RankingCard
          title="Artistas mais ouvidos"
          empty="Nenhum artista neste filtro"
          rows={stats.topArtists.map((item) => ({
            key: item.artistName,
            primary: item.artistName,
            secondary: null,
            count: item.playCount,
          }))}
        />
        <RankingCard
          title="Álbuns mais ouvidos"
          empty="Nenhum álbum neste filtro"
          rows={stats.topAlbums.map((item) => ({
            key: `${item.artistName}\u0000${item.albumName}`,
            primary: item.albumName,
            secondary: item.artistName,
            count: item.playCount,
          }))}
        />
      </div>
    </section>
  );
}

function RankingCard({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: Array<{
    key: string;
    primary: string;
    secondary: string | null;
    count: number;
  }>;
  empty: string;
}) {
  return (
    <div className="w-[84%] shrink-0 snap-start rounded-2xl border border-line-dark/55 bg-surface-subtle/55 p-4 sm:w-[55%] lg:w-auto">
      <h3 className="text-sm font-black text-ink-inverse">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-4 text-xs text-muted-inverse">{empty}</p>
      ) : (
        <ol className="mt-3 space-y-2.5">
          {rows.map((row, index) => (
            <li key={row.key} className="flex items-center gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-elevated/80 text-[11px] font-black text-brand-400">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-black text-ink-inverse">{row.primary}</p>
                {row.secondary ? (
                  <p className="truncate text-[11px] text-muted-inverse">{row.secondary}</p>
                ) : null}
              </div>
              <span className="shrink-0 text-[11px] font-black text-muted-inverse">
                {row.count.toLocaleString("pt-BR")}×
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function formatListeningDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 min";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}min`;
  return `${Math.max(1, minutes)} min`;
}

function formatPercent(value: number): string {
  return `${value.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% medidos`;
}
