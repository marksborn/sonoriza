import { ProbableLikeDismissButton } from "@/components/ProbableLikeDismissButton";
import { ProbableLikeLikeButton } from "@/components/ProbableLikeLikeButton";
import { ProgressiveList } from "@/components/ProgressiveList";
import { ProductSectionHeader } from "@/components/ProductSectionHeader";
import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import type { ProbableLikeShadowResult } from "@/services/listening-history/probable-like";
import { applyProbableLikeCooldowns } from "@/services/listening-history/probable-like-dismissal";

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

  const cooldown = await applyProbableLikeCooldowns(session.user.id, result);
  const visibleResult = cooldown.result;
  const visibleCandidates = visibleResult.candidates.slice(0, 6);
  const additionalCandidateCount = Math.max(0, visibleCandidates.length - 3);

  return (
    <section className="product-panel overflow-hidden p-4 sm:p-6">
      <ProductSectionHeader
        eyebrow="Curadoria"
        title="Talvez você queira curtir"
        description="Músicas que você já ouviu e demonstrou gostar."
        icon="music"
        iconTone="accent"
        titleAccessory={
          <span className="inline-flex items-center rounded-full border border-warning/30 bg-warning-soft/70 px-2.5 py-1 text-[10px] font-black text-warning">
            Cooldown de 90 dias
          </span>
        }
      />

      {visibleResult.candidates.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-dashed border-line-dark/70 bg-surface-subtle/55 px-4 py-7 text-center">
          <p className="font-black text-ink-inverse">Nenhuma candidata forte agora</p>
          <p className="mt-1 text-sm text-muted-inverse">
            Novas sugestões aparecem quando há evidência positiva suficiente.
          </p>
        </div>
      ) : (
        <ProgressiveList
          initialCount={3}
          className="mt-4 grid gap-3 lg:grid-cols-2"
          moreLabel={`Ver mais ${additionalCandidateCount} ${
            additionalCandidateCount === 1 ? "sugestão" : "sugestões"
          }`}
        >
          {visibleCandidates.map((candidate, index) => (
            <li
              key={candidate.spotifyTrackId}
              className="rounded-2xl border border-line-dark/60 bg-surface-subtle/60 p-3.5 sm:p-4"
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

                  <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px] font-bold">
                    <span className="rounded-full border border-line-dark/60 bg-surface-elevated/70 px-2.5 py-1 text-muted-inverse">
                      {candidate.playCount} reproduções
                    </span>
                    <span className="rounded-full border border-line-dark/60 bg-surface-elevated/70 px-2.5 py-1 text-muted-inverse">
                      {candidate.distinctDays} dias
                    </span>
                  </div>

                  <p className="mt-2.5 line-clamp-2 text-xs leading-5 text-muted-inverse">
                    {candidate.reasons[0] ?? "Seu histórico indica afinidade com esta música."}
                  </p>

                  <details className="group mt-1.5 text-xs text-muted-inverse">
                    <summary className="min-h-10 cursor-pointer list-none rounded-lg py-2 font-black text-brand-300 transition hover:text-accent-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400 group-open:text-accent-300">
                      <span className="inline-flex items-center gap-1.5">
                        <UiIcon name="list" size={14} />
                        Ver evidências
                        <span aria-hidden="true" className="transition group-open:rotate-180">⌄</span>
                      </span>
                    </summary>
                    <div className="rounded-xl border border-line-dark/50 bg-surface-elevated/45 p-3">
                      <ul className="space-y-1 leading-5">
                        {candidate.reasons.map((reason) => (
                          <li key={reason}>• {reason}</li>
                        ))}
                      </ul>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-bold text-muted-inverse/80">
                        {candidate.factualCompleteCount > 0 ? (
                          <span>{candidate.factualCompleteCount} conclusões factuais</span>
                        ) : null}
                        {candidate.inferredCompleteCount > 0 ? (
                          <span>{candidate.inferredCompleteCount} conclusões inferidas</span>
                        ) : null}
                        <span>Última: {dateFormatter.format(candidate.lastPlayedAt)}</span>
                      </div>
                    </div>
                  </details>

                  <div className="mt-2.5 grid grid-cols-3 gap-2">
                    <ProbableLikeLikeButton
                      spotifyTrackId={candidate.spotifyTrackId}
                      compact
                    />
                    <a
                      href={`/api/history/probable-like/open?spotifyTrackId=${encodeURIComponent(candidate.spotifyTrackId)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-success/35 bg-success-soft/60 px-3 py-2 text-center text-xs font-black text-success transition hover:border-success/60 hover:bg-success-soft"
                    >
                      <UiIcon name="play" size={15} />
                      Spotify
                    </a>
                    <div className="min-w-0">
                      <ProbableLikeDismissButton
                        spotifyTrackId={candidate.spotifyTrackId}
                        compact
                      />
                    </div>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ProgressiveList>
      )}

      <details className="group mt-4 border-t border-line-dark/45 pt-2 text-[11px] font-bold text-muted-inverse/85">
        <summary className="min-h-10 cursor-pointer list-none rounded-lg py-2 text-brand-300 transition hover:text-accent-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400">
          <span className="inline-flex items-center gap-1.5">
            Sobre este ranking
            <span aria-hidden="true" className="transition group-open:rotate-180">⌄</span>
          </span>
        </summary>
        <div className="flex flex-wrap gap-x-5 gap-y-2 pb-1">
          <span>{visibleResult.evaluatedTrackCount.toLocaleString("pt-BR")} faixas examinadas</span>
          <span>{visibleResult.excludedLikedCount.toLocaleString("pt-BR")} já curtidas excluídas</span>
          <span>{visibleResult.excludedStrongNegativeCount.toLocaleString("pt-BR")} excluídas por sinal negativo forte</span>
          {visibleResult.excludedShortContentCount > 0 ? (
            <span>{visibleResult.excludedShortContentCount.toLocaleString("pt-BR")} ultracurtas excluídas</span>
          ) : null}
          {cooldown.excludedCooldownCount > 0 ? (
            <span>{cooldown.excludedCooldownCount.toLocaleString("pt-BR")} em cooldown</span>
          ) : null}
        </div>
      </details>
    </section>
  );
}
