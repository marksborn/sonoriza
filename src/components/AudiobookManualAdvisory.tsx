"use client";

import { useState } from "react";
import {
  formatManualDuration,
  parseManualSecondsToMs,
} from "@/services/audiobooks/d6-self-reported-preview";
import type { ManualAdvisoryResult } from "@/services/audiobooks/d8-manual-advisory-shadow";

const cls = "mt-2 w-full rounded-xl border border-line-dark bg-surface-subtle px-4 py-3 text-sm text-ink-inverse";

function parseBlocks(raw: string): number[] | null {
  if (!raw.trim()) return [];
  const cells = raw.split(";");
  if (cells.length > 12) return null;
  const entries = cells.map(s => parseManualSecondsToMs(s.trim()));
  return entries.some(ms => ms === null || ms <= 0) ? null : entries as number[];
}

const reasons: Record<string, string> = {
  OWNER_OR_DESTINATION_MISMATCH: "A playlist não corresponde à conta e ao caderno.",
  INVALID_PROVENANCE: "Os dados não são uma anotação autodeclarada válida.",
  STALE_OR_INVALID_NOTEBOOK_REVISION: "A revisão mudou. Recarregue o caderno e tente novamente.",
  VERIFIED_OVERLAY_PRESENT: "Este destino já possui um vínculo Spotify verificado.",
  TARGET_CONFIGURATION_UNSUPPORTED_OR_DRIFTED:
    "A configuração ou duração da playlist mudou, ou o modo não é FIXED + PROPORTION + MANUAL.",
  INVALID_HYPOTHETICAL_SAMPLES: "Informe ao menos um bloco de exemplo com duração válida.",
};

export function AudiobookManualAdvisory({
  targetPlaylistId, expectedRevision,
}: Readonly<{ targetPlaylistId: string; expectedRevision: number }>) {
  const [musicSeconds, setMusicSeconds] = useState("90; 120");
  const [podcastSeconds, setPodcastSeconds] = useState("120");
  const [result, setResult] = useState<ManualAdvisoryResult | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function preview() {
    if (pending) return;
    setResult(null);
    setError("");
    const music = parseBlocks(musicSeconds);
    const podcasts = parseBlocks(podcastSeconds);
    if (!music || !podcasts || music.length + podcasts.length === 0) {
      setError("Informe durações positivas em segundos separadas por ponto e vírgula. Ex.: 90; 120.");
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/audiobooks/manual-advisory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          targetPlaylistId, expectedRevision,
          sampleMusicDurationsMs: music,
          samplePodcastDurationsMs: podcasts,
        }),
      });
      const data = await response.json() as ManualAdvisoryResult & { code?: string };
      if (data.status === "ABSTAIN") {
        setError(reasons[data.reason] ?? "Não é seguro calcular esta prévia. Atualize os dados.");
        return;
      }
      if (!response.ok || data.status !== "READY_ADVISORY") {
        setError("Prévia indisponível. Confira o caderno e as configurações do destino.");
        return;
      }
      setResult(data);
    } catch {
      setError("Não foi possível obter a prévia consultiva.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border border-line-dark p-4">
      <h3 className="font-bold text-ink-inverse">Gate D.8 · Simulação consultiva de orçamento</h3>
      <p className="text-sm leading-6 text-muted-inverse">
        Use somente a revisão {expectedRevision} do capítulo já salvo.
        Informe durações <strong>hipotéticas</strong> de músicas e podcasts:
        isso não lê o catálogo Spotify, não seleciona faixas reais e não
        usa o planejador de geração. Nenhuma playlist será alterada.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-semibold text-ink-inverse">
          Músicas imaginárias (segundos, separados por ; )
          <input className={cls} type="text" inputMode="text" value={musicSeconds}
            placeholder="90; 120"
            onChange={e => { setMusicSeconds(e.target.value); setResult(null); setError(""); }} />
        </label>
        <label className="text-sm font-semibold text-ink-inverse">
          Podcasts imaginários (segundos, separados por ; )
          <input className={cls} type="text" inputMode="text" value={podcastSeconds}
            placeholder="120"
            onChange={e => { setPodcastSeconds(e.target.value); setResult(null); setError(""); }} />
        </label>
      </div>
      <button type="button" className="secondary-button" disabled={pending}
        onClick={preview}>{pending ? "Calculando..." : "Simular mistura hipotética (sem salvar)"}</button>
      {error ? <p role="alert" className="text-sm text-ink-inverse">{error}</p> : null}
      {result?.status === "READY_ADVISORY" ? (
        <div className="space-y-3" role="status">
          <p className="font-bold text-ink-inverse">
            Resultado orientativo — revisão {result.notebookRevision},
            USER_DECLARED_UNVERIFIED
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <p className="text-sm text-ink-inverse">
              Capítulo informado: <strong>{formatManualDuration(result.virtualChapterDurationMs)}</strong>
            </p>
            <p className="text-sm text-ink-inverse">
              Saldo após capítulo: <strong>{formatManualDuration(result.remainingBudgetMs)}</strong>
            </p>
            <p className="text-sm text-ink-inverse">
              Faixa estimada para música: <strong>{formatManualDuration(result.musicBudgetMs)}</strong>
            </p>
            <p className="text-sm text-ink-inverse">
              Faixa estimada para podcasts ({result.podcastPercentOfRemainingBudget}%):
              {" "}<strong>{formatManualDuration(result.podcastBudgetMs)}</strong>
            </p>
            <p className="text-sm text-ink-inverse">
              Músicas fictícias que caberiam: <strong>{result.hypotheticalMusicCount}</strong>,
              {" "}{formatManualDuration(result.hypotheticalMusicDurationMs)}
            </p>
            <p className="text-sm text-ink-inverse">
              Podcasts fictícios que caberiam: <strong>{result.hypotheticalPodcastCount}</strong>,
              {" "}{formatManualDuration(result.hypotheticalPodcastDurationMs)}
            </p>
            <p className="text-sm text-ink-inverse">
              Total virtual estimado: <strong>{formatManualDuration(result.hypotheticalTotalVirtualDurationMs)}</strong>
            </p>
            <p className="text-sm text-ink-inverse">
              Tempo livre após amostras: <strong>{formatManualDuration(result.budgetUnfilledMs)}</strong>
            </p>
          </div>
          <p className="text-xs leading-5 text-muted-inverse">
            Duração do livro e amostras não verificadas pelo Spotify.
            Esta não é uma prévia de faixas reais, não cria GenerationRun,
            não verifica presença de audiolivro e não serve como autorização
            de escrita ou substituição de playlist. A troca de capítulo permanece manual.
          </p>
        </div>
      ) : null}
    </section>
  );
}
