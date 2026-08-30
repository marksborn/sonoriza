import { UiIcon } from "@/components/UiIcon";
import type { ListeningHistoryStats } from "@/services/listening-history/stats";

export function HistoryStatsPanel({ stats }: { stats: ListeningHistoryStats }) {
  const hasUnmeasuredEvents =
    stats.playCount > 0 && stats.measuredPlayEvents === 0;

  return (
    <section className="product-panel overflow-hidden p-5 sm:p-6">
      <div className="flex items-start gap-3">
          <span className="product-icon-tile h-11 w-11 shrink-0">
            <UiIcon name="list" size={20} />
          </span>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
              Estatísticas
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
              Seu padrão neste filtro
            </h2>
          </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          value={stats.distinctTracks.toLocaleString("pt-BR")}
          label="Faixas distintas"
        />
        <StatCard
          value={stats.distinctArtists.toLocaleString("pt-BR")}
          label="Artistas distintos"
        />
        <StatCard
          value={stats.distinctAlbums.toLocaleString("pt-BR")}
          label="Álbuns distintos"
        />
        <StatCard
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

function StatCard({
  value,
  label,
  detail,
  compact = false,
}: {
  value: string;
  label: string;
  detail?: string;
  compact?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-line-dark/55 bg-surface-subtle/65 px-4 py-4">
      <p className={`${compact ? "text-base leading-5 sm:text-lg" : "text-xl sm:text-2xl"} font-black text-ink-inverse`}>{value}</p>
      <p className="mt-1 text-xs font-semibold text-muted-inverse">{label}</p>
      {detail ? <p className="mt-1 text-[10px] leading-4 text-muted-inverse/75">{detail}</p> : null}
    </div>
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
