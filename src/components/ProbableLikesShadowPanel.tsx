import { UiIcon } from "@/components/UiIcon";
import type { ProbableLikeShadowResult } from "@/services/listening-history/probable-like";

const dateFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function ProbableLikesShadowPanel({
  result,
}: {
  result: ProbableLikeShadowResult;
}) {
  return (
    <section className="product-panel overflow-hidden p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="product-icon-tile h-11 w-11 shrink-0">
            <UiIcon name="music" size={20} />
          </span>
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
              Gate 3 · Shadow
            </p>
            <h2 className="mt-1 text-xl font-black tracking-tight text-ink-inverse">
              Talvez você queira curtir
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-inverse">
              Ranking explicável baseado apenas no histórico local. Nada é curtido ou alterado automaticamente nesta etapa.
            </p>
          </div>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-warning/30 bg-warning-soft px-3 py-1.5 text-xs font-black text-warning">
          Read-only
        </span>
      </div>

      {result.candidates.length === 0 ? (
        <div className="mt-5 rounded-2xl border border-dashed border-line-dark/70 bg-surface-subtle/55 px-5 py-8 text-center">
          <p className="font-black text-ink-inverse">Nenhuma candidata forte agora</p>
          <p className="mt-1 text-sm text-muted-inverse">
            O ranking exige repetição em dias diferentes e evidência positiva suficiente.
          </p>
        </div>
      ) : (
        <ol className="mt-5 grid gap-3 lg:grid-cols-2">
          {result.candidates.slice(0, 6).map((candidate, index) => (
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
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-line-dark/45 pt-4 text-[11px] font-bold text-muted-inverse/85">
        <span>{result.evaluatedTrackCount.toLocaleString("pt-BR")} faixas avaliadas</span>
        <span>{result.excludedLikedCount.toLocaleString("pt-BR")} já curtidas excluídas</span>
        <span>{result.excludedStrongNegativeCount.toLocaleString("pt-BR")} excluídas por sinal negativo forte</span>
        {result.excludedShortContentCount > 0 ? (
          <span>{result.excludedShortContentCount.toLocaleString("pt-BR")} ultracurtas excluídas</span>
        ) : null}
      </div>
    </section>
  );
}