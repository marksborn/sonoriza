import Link from "next/link";
import { redirect } from "next/navigation";

import { UiIcon, type UiIconName } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import {
  forYouReasonTexts,
  forYouStrengthLabel,
  getForYouReport,
  type ForYouRecommendation,
} from "@/services/music-discovery/for-you-report";

export default async function ForYouPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  let report: Awaited<ReturnType<typeof getForYouReport>> | null = null;
  let loadFailed = false;
  try {
    report = await getForYouReport(session.user.id, { limitPerCategory: 4 });
  } catch (error) {
    loadFailed = true;
    console.error("DISCOVERY-UI for-you load failed", error);
  }

  return (
    <div className="space-y-5">
      <section className="product-panel p-5 sm:p-7">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="product-icon-tile-accent h-12 w-12 shrink-0">
              <UiIcon name="music" size={22} />
            </span>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
                Para você
              </p>
              <h2 className="mt-1 text-2xl font-black tracking-tight text-ink-inverse sm:text-3xl">
                Seu mix pessoal de descoberta
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-inverse">
                Familiaridade, redescoberta e músicas novas escolhidas pelo seu histórico real. O Sonoriza mostra poucas opções e explica por que cada uma apareceu.
              </p>
            </div>
          </div>

          {report ? (
            <div className="flex flex-wrap gap-2 text-xs font-bold text-muted-inverse sm:justify-end">
              <span className="product-badge px-3 py-1.5">
                {formatCount(report.coverage.totalCanonicalEvents)} escutas analisadas
              </span>
              <span className="product-badge px-3 py-1.5">DISCOVERY-01</span>
            </div>
          ) : null}
        </div>
      </section>

      {loadFailed || !report ? (
        <section className="product-panel p-6">
          <div className="status-warning flex items-start gap-3 rounded-2xl border px-4 py-4">
            <UiIcon name="warning" size={20} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-black">Não foi possível montar suas recomendações agora.</p>
              <p className="mt-1 text-sm opacity-80">
                Nenhuma alteração foi feita no Spotify. O seu histórico permanece intacto e você pode tentar novamente mais tarde.
              </p>
            </div>
          </div>
        </section>
      ) : (
        <>
          <RecommendationSection
            eyebrow="Familiaridade"
            title="Boas escolhas para voltar agora"
            description="Faixas fortes no seu histórico que já passaram pelas regras de repetição e cooldown."
            icon="repeat"
            rows={report.familiar}
            emptyText="Nenhuma faixa familiar está elegível agora. O Sonoriza prefere esperar a forçar repetição."
          />

          <RecommendationSection
            eyebrow="Redescoberta"
            title="Vale reencontrar"
            description="Músicas importantes no seu histórico que ficaram tempo suficiente longe para fazer sentido voltar."
            icon="history"
            rows={report.rediscovery}
            emptyText="Nenhuma redescoberta forte o bastante agora. Isso é normal: a categoria pode se abster."
          />

          <RecommendationSection
            eyebrow="Descoberta"
            title="Algo novo para você"
            description="Faixas ainda não observadas no seu histórico, relacionadas a referências pelas quais você já demonstrou afinidade."
            icon="plus"
            rows={report.discovery}
            emptyText="Nenhuma faixa nova ultrapassou os critérios de qualidade neste momento."
          />

          {report.external.status !== "READY" ? (
            <section className="product-panel p-4 sm:p-5">
              <div className="flex items-start gap-3 text-sm text-muted-inverse">
                <UiIcon
                  name={report.external.status === "PARTIAL" ? "warning" : "music"}
                  size={18}
                  className="mt-0.5 shrink-0 text-accent-400"
                />
                <div>
                  <p className="font-bold text-ink-inverse">
                    {report.external.status === "PARTIAL"
                      ? "Descoberta parcial"
                      : report.external.status === "ABSTAINED"
                        ? "Descoberta se absteve"
                        : "Descoberta externa indisponível"}
                  </p>
                  <p className="mt-1 leading-5">{report.external.note}</p>
                </div>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function RecommendationSection({
  eyebrow,
  title,
  description,
  icon,
  rows,
  emptyText,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: UiIconName;
  rows: ForYouRecommendation[];
  emptyText: string;
}) {
  return (
    <section className="space-y-3">
      <div className="px-1">
        <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
          {eyebrow}
        </p>
        <h3 className="mt-1 text-xl font-black text-ink-inverse sm:text-2xl">{title}</h3>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-inverse">{description}</p>
      </div>

      {rows.length === 0 ? (
        <div className="product-panel flex items-start gap-3 p-5 text-sm text-muted-inverse">
          <UiIcon name="check" size={18} className="mt-0.5 shrink-0 text-brand-400" />
          <p className="leading-6">{emptyText}</p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((row) => (
            <RecommendationCard key={row.key} row={row} icon={icon} />
          ))}
        </div>
      )}
    </section>
  );
}

function RecommendationCard({
  row,
  icon,
}: {
  row: ForYouRecommendation;
  icon: UiIconName;
}) {
  const reasons = forYouReasonTexts(row, 2);
  const href = spotifyHref(row);

  return (
    <article className="product-panel flex flex-col p-5 sm:p-6">
      <div className="flex items-start gap-4">
        <span className="product-icon-tile h-11 w-11 shrink-0">
          <UiIcon name={icon} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="product-badge px-2.5 py-1 text-[11px] font-black uppercase tracking-[0.08em]">
              {categoryLabel(row.category)}
            </span>
            <span className="text-xs font-bold text-brand-400">
              {forYouStrengthLabel(row.score)}
            </span>
          </div>
          <h4 className="mt-3 text-xl font-black leading-tight text-ink-inverse">
            {row.trackName}
          </h4>
          <p className="mt-1 text-sm font-bold text-brand-400">{row.artistName}</p>
          {row.albumName ? (
            <p className="mt-1 truncate text-xs text-muted-inverse">{row.albumName}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-5 space-y-2">
        {reasons.map((reason) => (
          <p key={reason} className="flex gap-2 text-sm leading-5 text-muted-inverse">
            <span
              aria-hidden="true"
              className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400"
            />
            <span>{reason}</span>
          </p>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap gap-2 text-xs text-muted-inverse">
        <span className="product-badge px-2.5 py-1.5">{provenanceLabel(row)}</span>
        {row.playCount !== null ? (
          <span className="product-badge px-2.5 py-1.5">
            {row.playCount} {row.playCount === 1 ? "escuta" : "escutas"} no histórico
          </span>
        ) : null}
        {row.lastPlayedAt ? (
          <span className="product-badge px-2.5 py-1.5">
            última {relativeDate(row.lastPlayedAt)}
          </span>
        ) : null}
      </div>

      <div className="mt-auto pt-5">
        <Link
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/10 px-4 py-2.5 text-sm font-black text-ink-inverse transition hover:bg-white/15 sm:w-auto"
        >
          <UiIcon name="play" size={17} />
          {row.spotifyTrackId ? "Abrir no Spotify" : "Buscar no Spotify"}
        </Link>
      </div>
    </article>
  );
}

function categoryLabel(category: ForYouRecommendation["category"]): string {
  if (category === "FAMILIAR") return "Familiar";
  if (category === "REDESCOBERTA") return "Redescoberta";
  return "Descoberta";
}

function provenanceLabel(row: ForYouRecommendation): string {
  if (row.provenance === "LISTENING_HISTORY") return "Seu histórico";
  if (row.provenance === "REDISCOVERY") return "Histórico + dormência";
  if (row.provenance === "LASTFM_SIMILAR_TRACK") return "Similaridade Last.fm";
  return "Artista relacionado no Last.fm";
}

function spotifyHref(row: ForYouRecommendation): string {
  if (row.spotifyTrackId) return `https://open.spotify.com/track/${row.spotifyTrackId}`;
  const query = encodeURIComponent(`${row.artistName} ${row.trackName}`);
  return `https://open.spotify.com/search/${query}`;
}

function relativeDate(value: Date): string {
  const days = Math.max(0, Math.floor((Date.now() - value.getTime()) / 86_400_000));
  if (days === 0) return "hoje";
  if (days === 1) return "há 1 dia";
  if (days < 30) return `há ${days} dias`;
  if (days < 365) {
    const months = Math.max(1, Math.floor(days / 30));
    return months === 1 ? "há 1 mês" : `há ${months} meses`;
  }
  const years = Math.max(1, Math.floor(days / 365));
  return years === 1 ? "há 1 ano" : `há ${years} anos`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("pt-BR").format(value);
}
