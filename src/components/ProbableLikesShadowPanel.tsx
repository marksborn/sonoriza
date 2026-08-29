import { ProbableLikeLikeButton } from "@/components/ProbableLikeLikeButton";
import { ProbableLikePilotFeedbackControls } from "@/components/ProbableLikePilotFeedbackControls";
import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import type { ProbableLikeShadowResult } from "@/services/listening-history/probable-like";
import { getProbableLikePilotSummary } from "@/services/listening-history/probable-like-pilot";

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export async function ProbableLikesShadowPanel({
  result,
}: {
  result: ProbableLikeShadowResult;
}) {
  const session = await auth();
  if (!session?.user?.id) return null;
  const pilot = await getProbableLikePilotSummary(session.user.id);

  return (
    <section className="product-panel overflow-hidden p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="product-icon-tile h-11 w-11 shrink-0">
            <UiIcon name="music" size={20} />
          </span>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
              Gate 5 · Curtir
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
              Talvez você queira curtir
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-inverse">
              O ranking continua explicável, mas agora você pode confirmar um LIKE explícito no Sonoriza. A faixa sai desta fila e passa a alimentar a afinidade da #184 e a fonte de Músicas Curtidas.
            </p>
          </div>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-success/30 bg-success-soft/70 px-3 py-1.5 text-xs font-black text-success">
          Curtir ativo
        </span>
      </div>

      {pilot.evaluatedCount > 0 ? (
        <div className="mt-5 grid grid-cols-2 gap-2 rounded-2xl border border-line-dark/55 bg-surface-subtle/55 p-3 sm:grid-cols-5">
          <PilotMetric label="Avaliadas" value={pilot.evaluatedCount} />
          <PilotMetric label="Gostei" value={pilot.likedCount} />
          <PilotMetric label="Indiferente" value={pilot.indifferentCount} />
          <PilotMetric label="Não gostei" value={pilot.dislikedCount} />
          <div className="col-span-2 rounded-xl border border-success/25 bg-success-soft/60 px-3 py-2 sm:col-span-1">
            <p className="text-[10px] font-black uppercase tracking-wide text-success/80">
              Precisão piloto
            </p>
            <p className="mt-0.5 text-lg font-black text-success">
              {pilot.precisionPercent.toLocaleString("pt-BR", {
                maximumFractionDigits: 1,
              })}%
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-5 rounded-2xl border border-dashed border-accent-400/30 bg-accent-400/5 px-4 py-3 text-xs leading-5 text-muted-inverse">
          A avaliação do piloto continua disponível como medição separada. <strong className="text-ink-inverse">Curtir no Sonoriza</strong> é uma ação explícita e produtiva diferente de “Gostei mesmo”.
        </div>
      )}

      {result.candidates.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-dashed border-line-dark/70 bg-surface-subtle/55 px-5 py-8 text-center">
          <p className="font-black text-ink-inverse">Nenhuma candidata forte agora</p>
          <p className="mt-1 text-sm text-muted-inverse">
            O ranking exige repetição em dias diferentes e evidência positiva suficiente.
          </p>
        </div>
      ) : (
        <ol className="mt-5 grid gap-3 lg:grid-cols-2">
          {result.candidates.slice(0, 6).map((candidate, index) => {
            const currentFeedback = pilot.feedbackByTrackId[candidate.spotifyTrackId];
            return (
              <li
                key={candidate.spotifyTrackId}
                className="rounded-2xl border border-line-dark/60 bg-surface-subtle/60 p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-brand-400/30 bg-brand/10 text-xs font-black text-brand-300">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-black text-ink-inverse">
                      {candidate.trackName}
                    </p>
                    <p className="mt-0.5 truncate text-sm font-semibold text-muted-inverse">
                      {candidate.artistName}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-bold">
                      <span className="rounded-full border border-line-dark/60 bg-surface-elevated/70 px-2.5 py-1 text-muted-inverse">
                        {candidate.playCount} reproduções
                      </span>
                      <span className="rounded-full border border-line-dark/60 bg-surface-elevated/70 px-2.5 py-1 text-muted-inverse">
                        {candidate.distinctDays} dias
                      </span>
                      {candidate.factualCompleteCount > 0 ? (
                        <span className="rounded-full border border-success/30 bg-success-soft px-2.5 py-1 text-success">
                          {candidate.factualCompleteCount} factual
                        </span>
                      ) : null}
                      {candidate.inferredCompleteCount > 0 ? (
                        <span className="rounded-full border border-accent-400/30 bg-accent-400/10 px-2.5 py-1 text-accent-300">
                          {candidate.inferredCompleteCount} inferida
                        </span>
                      ) : null}
                    </div>
                    <ul className="mt-3 space-y-1 text-xs leading-5 text-muted-inverse">
                      {candidate.reasons.slice(0, 3).map((reason) => (
                        <li key={reason}>• {reason}</li>
                      ))}
                    </ul>
                    <p className="mt-3 text-[11px] font-bold text-muted-inverse/80">
                      Última reprodução: {dateFormatter.format(candidate.lastPlayedAt)}
                    </p>
                    <div className="mt-3 flex flex-wrap items-start gap-2">
                      <a
                        href={`https://open.spotify.com/track/${encodeURIComponent(candidate.spotifyTrackId)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 rounded-xl border border-success/30 bg-success-soft/70 px-3 py-2 text-xs font-black text-success transition hover:border-success/50 hover:bg-success-soft"
                      >
                        <UiIcon name="play" size={15} />
                        Abrir no Spotify
                      </a>
                      <ProbableLikeLikeButton spotifyTrackId={candidate.spotifyTrackId} />
                    </div>
                    <ProbableLikePilotFeedbackControls
                      spotifyTrackId={candidate.spotifyTrackId}
                      initialVerdict={currentFeedback?.verdict ?? null}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-line-dark/45 pt-4 text-[11px] font-bold text-muted-inverse/85">
        <span>{result.evaluatedTrackCount.toLocaleString("pt-BR")} faixas examinadas pelo ranking</span>
        <span>{result.excludedLikedCount.toLocaleString("pt-BR")} já curtidas excluídas</span>
        <span>{result.excludedStrongNegativeCount.toLocaleString("pt-BR")} excluídas por sinal negativo forte</span>
        {result.excludedShortContentCount > 0 ? (
          <span>{result.excludedShortContentCount.toLocaleString("pt-BR")} ultracurtas excluídas</span>
        ) : null}
      </div>
    </section>
  );
}

function PilotMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-line-dark/55 bg-surface-elevated/55 px-3 py-2">
      <p className="text-[10px] font-black uppercase tracking-wide text-muted-inverse/75">
        {label}
      </p>
      <p className="mt-0.5 text-lg font-black text-ink-inverse">
        {value.toLocaleString("pt-BR")}
      </p>
    </div>
  );
}
