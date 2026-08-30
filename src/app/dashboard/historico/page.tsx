import Link from "next/link";
import { redirect } from "next/navigation";

import { BrandLogo } from "@/components/BrandLogo";
import { HistoryStatsPanel } from "@/components/HistoryStatsPanel";
import { ProbableLikesShadowPanel } from "@/components/ProbableLikesShadowPanel";
import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { getListeningHistorySummary } from "@/services/listening-history/analytics";
import {
  historyFilterQueryString,
  LISTENING_HISTORY_SOURCES,
  listListeningHistory,
  listeningHistorySourceLabel,
  resolveListeningHistoryFilters,
  type ListeningHistoryFilters,
  type ListeningHistoryPeriod,
} from "@/services/listening-history/explorer";
import { getProbableLikeShadow } from "@/services/listening-history/probable-like";
import { getListeningHistoryStats } from "@/services/listening-history/stats";

type SearchParams = Record<string, string | string[] | undefined>;

const PERIODS: Array<{ value: ListeningHistoryPeriod; label: string }> = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "7d", label: "7 dias" },
  { value: "30d", label: "30 dias" },
  { value: "year", label: "Este ano" },
  { value: "all", label: "Tudo" },
];

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export default async function ListeningHistoryPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const params = (await searchParams) ?? {};
  const filters = resolveListeningHistoryFilters(params);
  const [history, summary, stats, probableLikes] = await Promise.all([
    listListeningHistory(session.user.id, filters),
    getListeningHistorySummary(session.user.id),
    getListeningHistoryStats(session.user.id, filters),
    getProbableLikeShadow(session.user.id),
  ]);

  return (
    <main className="product-shell min-h-screen pb-24">
      <div className="product-ambient" />
      <div className="pointer-events-none absolute left-1/2 top-12 h-[30rem] w-[30rem] -translate-x-1/2 rounded-full bg-brand/10 blur-3xl" />

      <header className="relative z-10 border-b border-line-dark/50 bg-surface-dark/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-8 lg:px-10">
          <BrandLogo compact variant="light" />
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-xl border border-line-dark/70 bg-surface-subtle/70 px-3 py-2 text-sm font-bold text-muted-inverse transition hover:border-brand-400/50 hover:text-ink-inverse"
          >
            <UiIcon name="arrow-left" size={17} />
            Painel
          </Link>
        </div>
      </header>

      <div className="relative z-10 mx-auto max-w-7xl space-y-5 px-5 py-6 sm:space-y-6 sm:px-8 lg:px-10 lg:py-8">
        <section className="product-panel overflow-hidden p-5 sm:p-6 lg:p-7">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-accent-400">
                Histórico de audição
              </p>
              <h1 className="mt-2 text-3xl font-black tracking-[-0.035em] text-ink-inverse sm:text-4xl">
                O que você realmente ouviu.
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted-inverse sm:text-base">
                Timeline canônica do Sonoriza, construída apenas com eventos já persistidos. Abrir ou filtrar esta tela não consulta nem altera o Spotify.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:min-w-[28rem]">
              <SummaryCard
                label="Eventos conhecidos"
                value={summary.totalPlayEvents.toLocaleString("pt-BR")}
              />
              <SummaryCard
                label="Neste filtro"
                value={history.totalCount.toLocaleString("pt-BR")}
              />
              <SummaryCard
                label="Fontes"
                value={String(summary.sources.length)}
                className="col-span-2 sm:col-span-1"
              />
            </div>
          </div>

          {summary.firstPlayedAt && summary.lastPlayedAt ? (
            <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 border-t border-line-dark/45 pt-4 text-xs text-muted-inverse">
              <span>
                Primeiro evento: <strong className="text-ink-inverse">{dateFormatter.format(summary.firstPlayedAt)}</strong>
              </span>
              <span>
                Mais recente: <strong className="text-ink-inverse">{dateTimeFormatter.format(summary.lastPlayedAt)}</strong>
              </span>
            </div>
          ) : null}
        </section>

        <section className="product-panel p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="product-icon-tile h-11 w-11 shrink-0">
              <UiIcon name="search" size={20} />
            </span>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
                Filtros
              </p>
              <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
                Encontre uma reprodução
              </h2>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {PERIODS.map((period) => (
              <Link
                key={period.value}
                href={`/dashboard/historico?${historyFilterQueryString(filters, {
                  period: period.value,
                  page: 1,
                })}`}
                className={periodClass(filters, period.value)}
              >
                {period.label}
              </Link>
            ))}
          </div>

          <details
            open={Boolean(filters.query || filters.source || filters.period === "custom")}
            className="group mt-4 border-t border-line-dark/45 pt-2"
          >
            <summary className="min-h-11 cursor-pointer list-none rounded-lg py-3 text-sm font-black text-brand-300 transition hover:text-accent-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400">
              <span className="inline-flex items-center gap-2">
                <UiIcon name="search" size={16} />
                Busca e período personalizado
                <span aria-hidden="true" className="transition group-open:rotate-180">⌄</span>
              </span>
            </summary>
            <div className="mt-2 grid gap-4 xl:grid-cols-[1fr_auto]">
            <form method="get" className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,0.45fr)_auto]">
              <input type="hidden" name="period" value={filters.period} />
              {filters.period === "custom" ? (
                <>
                  <input type="hidden" name="from" value={filters.fromInput} />
                  <input type="hidden" name="to" value={filters.toInput} />
                </>
              ) : null}
              <label className="block">
                <span className="sr-only">Música, artista ou álbum</span>
                <input
                  name="q"
                  defaultValue={filters.query}
                  maxLength={120}
                  placeholder="Música, artista ou álbum"
                  className="w-full rounded-xl border border-line-dark/70 bg-surface-subtle/75 px-4 py-3 text-sm text-ink-inverse outline-none transition placeholder:text-muted-inverse/70 focus:border-brand-400/70"
                />
              </label>
              <label className="block">
                <span className="sr-only">Origem</span>
                <select
                  name="source"
                  defaultValue={filters.source ?? ""}
                  className="w-full rounded-xl border border-line-dark/70 bg-surface-subtle/75 px-4 py-3 text-sm text-ink-inverse outline-none transition focus:border-brand-400/70"
                >
                  <option value="">Todas as origens</option>
                  {LISTENING_HISTORY_SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {listeningHistorySourceLabel(source)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-black text-white transition hover:bg-brand-400"
              >
                <UiIcon name="search" size={17} />
                Buscar
              </button>
            </form>

            <form method="get" className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
              <input type="hidden" name="period" value="custom" />
              {filters.query ? <input type="hidden" name="q" value={filters.query} /> : null}
              {filters.source ? <input type="hidden" name="source" value={filters.source} /> : null}
              <label className="block">
                <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted-inverse">De</span>
                <input
                  type="date"
                  name="from"
                  defaultValue={filters.fromInput}
                  className="w-full rounded-xl border border-line-dark/70 bg-surface-subtle/75 px-3 py-2.5 text-sm text-ink-inverse outline-none transition focus:border-brand-400/70"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-bold uppercase tracking-wide text-muted-inverse">Até</span>
                <input
                  type="date"
                  name="to"
                  defaultValue={filters.toInput}
                  className="w-full rounded-xl border border-line-dark/70 bg-surface-subtle/75 px-3 py-2.5 text-sm text-ink-inverse outline-none transition focus:border-brand-400/70"
                />
              </label>
              <button
                type="submit"
                className="col-span-2 mt-1 inline-flex items-center justify-center gap-2 rounded-xl border border-brand-400/40 bg-surface-elevated/80 px-4 py-2.5 text-sm font-black text-ink-inverse transition hover:border-brand-400/70 sm:mt-5"
              >
                <UiIcon name="calendar" size={17} />
                Período
              </button>
            </form>
            </div>

            {(filters.query || filters.source || filters.period === "custom") ? (
              <div className="mt-4">
              <Link
                href="/dashboard/historico?period=7d"
                className="text-xs font-bold text-brand-400 transition hover:text-accent-400"
              >
                Limpar filtros
              </Link>
              </div>
            ) : null}
          </details>
        </section>

        <HistoryStatsPanel stats={stats} />

        <ProbableLikesShadowPanel result={probableLikes} />

        <section className="product-panel overflow-hidden p-5 sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
                Timeline
              </p>
              <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
                {history.totalCount === 1
                  ? "1 reprodução encontrada"
                  : `${history.totalCount.toLocaleString("pt-BR")} reproduções encontradas`}
              </h2>
              <p className="mt-1 text-sm text-muted-inverse">
                Mais recentes primeiro · página {history.page} de {history.totalPages}
              </p>
            </div>
            <span className="inline-flex w-fit items-center gap-2 rounded-full border border-line-dark/65 bg-surface-subtle/70 px-3 py-1.5 text-xs font-bold text-muted-inverse">
              <UiIcon name="history" size={15} />
              Read-only
            </span>
          </div>

          {history.items.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-dashed border-line-dark/70 bg-surface-subtle/55 px-5 py-10 text-center">
              <UiIcon name="history" size={28} className="mx-auto text-muted-inverse" />
              <p className="mt-3 font-black text-ink-inverse">Nenhum evento neste filtro</p>
              <p className="mt-1 text-sm text-muted-inverse">
                Tente ampliar o período ou remover a busca por texto/origem.
              </p>
            </div>
          ) : (
            <ol className="mt-5 divide-y divide-line-dark/45 overflow-hidden rounded-2xl border border-line-dark/55 bg-surface-subtle/55">
              {history.items.map((item) => {
                const strongIdentity = Boolean(item.spotifyTrackId || item.trackMbid || item.isrc);
                return (
                  <li key={item.id} className="px-3.5 py-3 sm:px-5 sm:py-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-3">
                          <span className="product-icon-tile mt-0.5 h-9 w-9 shrink-0 rounded-xl">
                            <UiIcon name="music" size={16} />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate font-black text-ink-inverse">{item.trackName}</p>
                            <p className="mt-0.5 truncate text-sm font-semibold text-muted-inverse">
                              {item.artistName}
                              {item.albumName ? ` · ${item.albumName}` : ""}
                            </p>
                            <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] font-bold">
                              <span className="rounded-full border border-line-dark/60 bg-surface-elevated/70 px-2.5 py-1 text-muted-inverse">
                                {listeningHistorySourceLabel(item.source)}
                              </span>
                              {item.contextType ? (
                                <span className="rounded-full border border-line-dark/60 bg-surface-elevated/70 px-2.5 py-1 text-muted-inverse">
                                  {item.contextType}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </div>
                      <time
                        dateTime={item.playedAt.toISOString()}
                        title={strongIdentity ? "Identidade vinculada" : "Identidade por metadados"}
                        className="w-[5.25rem] shrink-0 text-right text-[11px] font-bold leading-4 text-muted-inverse sm:w-auto sm:text-xs"
                      >
                        {dateTimeFormatter.format(item.playedAt)}
                      </time>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {history.totalPages > 1 ? (
            <div className="mt-5 flex items-center justify-between gap-3">
              {history.page > 1 ? (
                <Link
                  href={`/dashboard/historico?${historyFilterQueryString(filters, {
                    page: history.page - 1,
                  })}`}
                  className="inline-flex items-center gap-2 rounded-xl border border-line-dark/70 bg-surface-subtle/70 px-3 py-2 text-sm font-bold text-ink-inverse transition hover:border-brand-400/60"
                >
                  <UiIcon name="arrow-left" size={16} />
                  Mais recentes
                </Link>
              ) : (
                <span />
              )}
              {history.page < history.totalPages ? (
                <Link
                  href={`/dashboard/historico?${historyFilterQueryString(filters, {
                    page: history.page + 1,
                  })}`}
                  className="inline-flex items-center gap-2 rounded-xl border border-brand-400/40 bg-surface-elevated/80 px-3 py-2 text-sm font-black text-ink-inverse transition hover:border-brand-400/70"
                >
                  Mais antigas
                  <UiIcon name="arrow-right" size={16} />
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

function SummaryCard({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-line-dark/55 bg-surface-subtle/65 px-4 py-3 ${className}`}>
      <p className="text-xl font-black text-ink-inverse">{value}</p>
      <p className="mt-0.5 text-xs text-muted-inverse">{label}</p>
    </div>
  );
}

function periodClass(
  filters: ListeningHistoryFilters,
  period: ListeningHistoryPeriod,
): string {
  const active = filters.period === period;
  return `rounded-full border px-3 py-1.5 text-xs font-black transition ${
    active
      ? "border-brand-400/70 bg-brand/25 text-ink-inverse"
      : "border-line-dark/65 bg-surface-subtle/65 text-muted-inverse hover:border-brand-400/45 hover:text-ink-inverse"
  }`;
}
