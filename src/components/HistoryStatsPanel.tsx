import { UiIcon } from "@/components/UiIcon";
import type { ListeningHistoryStats } from "@/services/listening-history/stats";

export function HistoryStatsPanel({ stats }: { stats: ListeningHistoryStats }) {
  return (
    <section className="product-panel overflow-hidden p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
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
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-line-dark/65 bg-surface-subtle/70 px-3 py-1.5 text-xs font-bold text-muted-inverse">
          <UiIcon name="history" size={15} />
          Histórico local
        </span>
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
          value={formatListeningDuration(stats.measuredListeningMs)}
          label="Tempo medido"
          detail={
            stats.playCount > 0
              ? `${stats.measuredPlayEvents.toLocaleString("pt-BR")} de ${stats.playCount.toLocaleString("pt-BR")} eventos · ${formatPercent(stats.measuredCoveragePercent)}`
              : "Sem eventos neste filtro"
          }
        />
      </div>

      <p className="mt-3 text-[11px] leading-5 text-muted-inverse/85">
        Tempo medido soma apenas reproduções com evidência factual de duração do Spotify Extended History. Eventos sem essa evidência continuam nas contagens e rankings, sem duração estimada.
      </p>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
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
}: {
  value: string;
  label: string;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl border border-line-dark/55 bg-surface-subtle/65 px-4 py-4">
      <p className="text-xl font-black text-ink-inverse sm:text-2xl">{value}</p>
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
    <div className="rounded-2xl border border-line-dark/55 bg-surface-subtle/55 p-4">
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
