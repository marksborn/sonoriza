"use client";

import React, { useState } from "react";
import { explainAudiobookPreviewFailure } from "@/services/audiobooks/d4-preview-guidance";

export type ExistingAudiobookOverlay = Readonly<{
  targetPlaylistId: string;
  targetName: string;
  spotifyPlaylistId: string;
  spotifyAudiobookId: string;
  selectedChapterId: string;
  chapterDurationMs: number;
  manualConsumedMs: number;
  selectionMode: "FULL_CHAPTER" | "MANUAL_REMAINDER";
  revision: number;
  targetDurationMs: number;
}>;

type Catalogue = Readonly<{
  audiobookName: string;
  chapters: Array<Readonly<{
    id: string;
    name: string;
    durationMs: number;
    playable: boolean;
  }>>;
  total: number;
  truncated: boolean;
}>;
type ChangeInput = Readonly<{
  targetPlaylistId: string;
  expectedRevision: number;
  selectedChapterId: string;
  selection: { mode: "FULL_CHAPTER" } | { mode: "MANUAL_REMAINDER"; consumedMs: number };
}>;
type Preview = Readonly<{
  status: "READY";
  selectedChapterId: string;
  previousChapterId: string;
  chapterName: string;
  audiobookName: string;
  expectedRevision: number;
  effectivePlanningDurationMs: number;
  remainingPlanningDurationMs: number;
  targetDurationMs: number;
  manualSpotifyControlRequired: true;
}>;
type Updated = Preview & Readonly<{ revision: number }>;
type ManualHandoffResult =
  | Readonly<{
      status: "BLOCKED";
      reason: string;
      spotifyWrites: false;
      authorizedForAutomaticWrite: false;
    }>
  | Readonly<{
      status: "MANUAL_HANDOFF_ONLY";
      runId: string;
      spotifyPlaylistUrl: string;
      snapshotId: string;
      virtualChapterDurationMs: number;
      remainingBudgetMs: number;
      extraDurationMs: number;
      projectedTotalMs: number;
      leftoverMs: number;
      itemCount: number;
      audiobookIdentityVerified: false;
      spotifyWrites: false;
      authorizedForAutomaticWrite: false;
      items: readonly Readonly<{
        uri: string;
        spotifyUrl: string;
        contentType: "MUSIC" | "PODCAST";
      }>[];
    }>;

type RemoteObservation = Readonly<{
  status: "BOOK_ID_UNVERIFIABLE";
  snapshotId: string;
  stableSnapshotRead: true;
  listedItemCount: number;
  opaqueItemCount: number;
  opaquePositions: readonly number[];
  remoteBookPresenceVerified: false;
  safeToMutatePlaylist: false;
}>;

const fieldClass =
  "w-full rounded-xl border border-line-dark bg-surface-subtle px-4 py-3 text-sm text-ink-inverse";
function fmt(ms: number) {
  return Math.floor(ms / 60000) + "min " +
    String(Math.floor((ms % 60000) / 1000)).padStart(2, "0") + "," +
    String(ms % 1000).padStart(3, "0") + "s";
}
async function requestJson<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const data = await response.json() as T & { code?: string; error?: string };
  if (!response.ok) {
    const error = new Error(data.error ?? data.code ?? "Serviço indisponível.") as Error & { code?: string };
    error.code = data.code;
    throw error;
  }
  return data;
}

export function AudiobookChapterChangeEditor({
  overlay,
  changeEnabled,
  handoffPreviewEnabled,
}: Readonly<{
  overlay: ExistingAudiobookOverlay;
  changeEnabled: boolean;
  handoffPreviewEnabled: boolean;
}>) {
  const [revision, setRevision] = useState(overlay.revision);
  const [currentChapterId, setCurrentChapterId] = useState(overlay.selectedChapterId);
  const [chapterId, setChapterId] = useState(overlay.selectedChapterId);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [mode, setMode] = useState<"FULL_CHAPTER" | "MANUAL_REMAINDER">(overlay.selectionMode);
  const [seconds, setSeconds] = useState(String(overlay.manualConsumedMs / 1000));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [remoteEvidence, setRemoteEvidence] = useState<RemoteObservation | null>(null);
  const [handoff, setHandoff] = useState<ManualHandoffResult | null>(null);
  const [previewInput, setPreviewInput] = useState<ChangeInput | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  function resetPreview() {
    setPreview(null);
    setPreviewInput(null);
    setConfirmed(false);
    setMessage("");
    setError("");
  }
  function input(): ChangeInput {
    return {
      targetPlaylistId: overlay.targetPlaylistId,
      expectedRevision: revision,
      selectedChapterId: chapterId,
      selection: mode === "FULL_CHAPTER"
        ? { mode: "FULL_CHAPTER" }
        : { mode: "MANUAL_REMAINDER", consumedMs: Math.round(Number(seconds) * 1000) },
    };
  }
  async function observeRemote() {
    if (pending) return;
    setPending(true);
    setError("");
    setRemoteEvidence(null);
    try {
      setRemoteEvidence(await requestJson<RemoteObservation>(
        "/api/audiobooks/remote-observation", {
          targetPlaylistId: overlay.targetPlaylistId,
          expectedRevision: revision,
        },
      ));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Estado remoto indisponível.");
    } finally {
      setPending(false);
    }
  }

  async function assessManualHandoff() {
    if (pending || !handoffPreviewEnabled) return;
    setPending(true);
    setHandoff(null);
    setError("");
    try {
      const result = await requestJson<ManualHandoffResult>(
        "/api/audiobooks/manual-handoff", {
          targetPlaylistId: overlay.targetPlaylistId,
          expectedRevision: revision,
        },
      );
      setHandoff(result);
    } catch (e) {
      const code = e instanceof Error ? (e as Error & { code?: string }).code : undefined;
      setError(code ? explainAudiobookPreviewFailure(code)
        : e instanceof Error ? e.message : "Prévia manual indisponível.");
    } finally {
      setPending(false);
    }
  }

  async function load() {
    setPending(true);
    resetPreview();
    try {
      const data = await requestJson<Catalogue>("/api/audiobooks/catalog", {
        spotifyAudiobookId: overlay.spotifyAudiobookId,
      });
      setCatalogue(data);
      if (!data.chapters.some(c => c.id === chapterId && c.playable)) {
        const next = data.chapters.find(c => c.playable);
        setChapterId(next?.id ?? "");
      }
    } catch (e) {
      setCatalogue(null);
      const code = e instanceof Error ? (e as Error & { code?: string }).code : undefined;
      setError(code ? explainAudiobookPreviewFailure(code)
        : e instanceof Error ? e.message : "Não foi possível consultar os capítulos.");
    } finally {
      setPending(false);
    }
  }
  async function runPreview() {
    if (!catalogue || !chapterId || pending) return;
    resetPreview();
    const requested = input();
    setPending(true);
    try {
      const data = await requestJson<Preview>(
        "/api/audiobooks/manual-chapter-preview", { ...requested },
      );
      if (data.status !== "READY" || data.expectedRevision !== requested.expectedRevision ||
          data.selectedChapterId !== requested.selectedChapterId) {
        throw new Error("A prévia não corresponde à seleção atual.");
      }
      setPreviewInput(requested);
      setPreview(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível validar a duração.");
    } finally {
      setPending(false);
    }
  }
  async function commit() {
    if (!changeEnabled || !confirmed || !preview || !previewInput || pending) return;
    setPending(true);
    setError("");
    try {
      const result = await requestJson<Updated>(
        "/api/audiobooks/manual-chapter-update",
        {
          ...previewInput,
          confirmation: "CONFIRMAR_TROCA_MANUAL_CAPITULO",
        },
      );
      setRevision(result.revision);
      setHandoff(null);
      setRemoteEvidence(null);
      setCurrentChapterId(result.selectedChapterId);
      setChapterId(result.selectedChapterId);
      setMessage("Capítulo atualizado apenas no planejamento local. A reprodução e o capítulo no Spotify continuam sob seu controle.");
      setPreview(null);
      setPreviewInput(null);
      setConfirmed(false);
    } catch (e) {
      resetPreview();
      setError(e instanceof Error ? e.message : "Não foi possível atualizar o capítulo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="product-panel space-y-5 p-5 sm:p-7">
      <div>
        <span className="product-badge">Gate C · Capítulo já vinculado</span>
        <h2 className="mt-3 text-xl font-black text-ink-inverse">{overlay.targetName}</h2>
        <p className="mt-1 text-sm leading-6 text-muted-inverse">
          Livro Spotify: <code>{overlay.spotifyAudiobookId}</code>. Capítulo atual:
          {" "}<code>{currentChapterId}</code> (revisão {revision}).
          O livro e a playlist permanecem os mesmos.
        </p>
      </div>
      <div className="space-y-3 rounded-2xl border border-line-dark/55 p-4">
        <h3 className="font-bold text-ink-inverse">Estado da playlist Spotify (somente leitura)</h3>
        <p className="text-sm leading-6 text-muted-inverse">
          O snapshot da playlist não identifica com segurança qual audiolivro está no item opaco.
          Esta consulta não libera a inclusão, remoção ou reorganização de músicas.
        </p>
        <button type="button" className="secondary-button" disabled={pending}
          onClick={observeRemote}>Consultar snapshot remoto</button>
        {remoteEvidence ? (
          <div className="space-y-2 text-sm text-ink-inverse" role="status">
            <p>Snapshot estável: <code>{remoteEvidence.snapshotId}</code></p>
            <p>Itens observados: {remoteEvidence.listedItemCount}.
              Itens sem identidade verificável: {remoteEvidence.opaqueItemCount}.</p>
            <p>
              {remoteEvidence.opaqueItemCount === 0
                ? "Nenhum item opaco foi reconhecido. Isso não comprova que o livro foi removido."
                : "Itens opacos encontrados; nenhum deles comprova a identidade do livro associado."}
            </p>
            <p className="font-bold">
              Escrita automática no Spotify: bloqueada. Conferência manual continua necessária.
            </p>
          </div>
        ) : null}
      </div>
      {handoffPreviewEnabled ? (
        <div className="space-y-3 rounded-2xl border border-line-dark/55 p-4">
          <h3 className="font-bold text-ink-inverse">Gate D.3 · Lista para inclusão manual</h3>
          <p className="text-sm leading-6 text-muted-inverse">
            A partir de uma simulação SHADOW recente, confira músicas ou episódios
            que poderiam completar o orçamento virtual. O Sonoriza não os enviará
            ao Spotify e não pode comprovar qual dos itens opacos é o audiolivro.
            Se sua conta Spotify estiver no mercado BR, a API de capítulos pode estar
            indisponível mesmo que o livro apareça no aplicativo. Nenhuma duração
            será inventada para contornar a restrição.
          </p>
          <button type="button" className="secondary-button"
            onClick={assessManualHandoff} disabled={pending}>
            Avaliar lista manual da simulação
          </button>
          {handoff?.status === "BLOCKED" ? (
            <p role="status" className="text-sm text-ink-inverse">
              Lista não disponível: {handoff.reason}. Gere ou revise a simulação
              e confira o livro no Spotify. Nenhum item foi adicionado.
            </p>
          ) : null}
          {handoff?.status === "MANUAL_HANDOFF_ONLY" ? (
            <div className="space-y-3 text-sm leading-6 text-ink-inverse" role="status">
              <p>Capítulo virtual: {fmt(handoff.virtualChapterDurationMs)} ·
                Músicas/episódios projetados: {fmt(handoff.extraDurationMs)} ·
                Saldo: {fmt(handoff.leftoverMs)}.</p>
              <p>Snapshot consultado: <code>{handoff.snapshotId}</code>.
                Não é uma garantia de identidade ou preservação do audiolivro.</p>
              <p className="font-bold">
                Procedimento manual: abra a playlist no Spotify, confirme pessoalmente
                que o livro inteiro está presente e mantenha-o intacto. Depois,
                adicione individualmente os itens desejados e controle o capítulo
                e a reprodução manualmente.
              </p>
              <a href={handoff.spotifyPlaylistUrl} target="_blank" rel="noopener noreferrer"
                className="inline-block text-accent-400 underline">
                Abrir playlist no Spotify
              </a>
              <ol className="list-decimal space-y-2 pl-6">
                {handoff.items.map(item => (
                  <li key={item.uri}>
                    <a href={item.spotifyUrl} target="_blank" rel="noopener noreferrer"
                      className="text-accent-400 underline">
                      {item.contentType === "MUSIC" ? "Música" : "Podcast"} · {item.uri}
                    </a>
                  </li>
                ))}
              </ol>
              <p className="font-bold">
                Nenhuma escrita automática foi autorizada ou realizada.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
      <button type="button" className="secondary-button"
        disabled={pending} onClick={load}>
        {pending ? "Consultando..." : "Consultar capítulos deste livro"}
      </button>
      {catalogue ? (
        <div className="space-y-4">
          <p className="text-sm font-bold text-ink-inverse">
            {catalogue.audiobookName} · {catalogue.chapters.length} de {catalogue.total} capítulos
            {catalogue.truncated ? " (lista parcial)" : ""}
          </p>
          <label htmlFor={"chapter-" + overlay.targetPlaylistId}
            className="block text-sm font-bold text-ink-inverse">Capítulo para o Sonoriza</label>
          <select id={"chapter-" + overlay.targetPlaylistId} className={fieldClass}
            value={chapterId} disabled={pending}
            onChange={e => { setChapterId(e.target.value); resetPreview(); }}>
            {catalogue.chapters.filter(c => c.playable).map((c, index) => (
              <option key={c.id} value={c.id}>
                {index + 1}. {c.name} — {fmt(c.durationMs)}
              </option>
            ))}
          </select>
          <fieldset disabled={pending} className="space-y-3">
            <legend className="text-sm font-bold text-ink-inverse">Contar a partir de</legend>
            <label className="flex items-center gap-3 text-sm text-ink-inverse">
              <input type="radio" name={"progress-" + overlay.targetPlaylistId}
                checked={mode === "FULL_CHAPTER"}
                onChange={() => { setMode("FULL_CHAPTER"); resetPreview(); }} />
              Início do capítulo
            </label>
            <label className="flex items-center gap-3 text-sm text-ink-inverse">
              <input type="radio" name={"progress-" + overlay.targetPlaylistId}
                checked={mode === "MANUAL_REMAINDER"}
                onChange={() => { setMode("MANUAL_REMAINDER"); resetPreview(); }} />
              Tempo consumido informado manualmente
            </label>
            {mode === "MANUAL_REMAINDER" ? (
              <label className="block text-sm text-ink-inverse">
                Segundos consumidos
                <input type="number" min="0" step="0.001" className={"mt-2 " + fieldClass}
                  value={seconds} onChange={e => { setSeconds(e.target.value); resetPreview(); }} />
              </label>
            ) : null}
          </fieldset>
          <button type="button" className="secondary-button"
            disabled={pending || !chapterId} onClick={runPreview}>
            {pending ? "Validando..." : "Recalcular duração virtual"}
          </button>
        </div>
      ) : null}
      {preview ? (
        <div className="space-y-4 rounded-2xl border border-brand-400/30 bg-surface-subtle/70 p-4"
          aria-live="polite">
          <p className="font-black text-ink-inverse">{preview.chapterName}</p>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div><dt className="text-xs text-muted-inverse">Playlist</dt>
              <dd className="font-bold text-ink-inverse">{fmt(preview.targetDurationMs)}</dd></div>
            <div><dt className="text-xs text-muted-inverse">Capítulo virtual</dt>
              <dd className="font-bold text-accent-400">{fmt(preview.effectivePlanningDurationMs)}</dd></div>
            <div><dt className="text-xs text-muted-inverse">Tempo restante</dt>
              <dd className="font-bold text-ink-inverse">{fmt(preview.remainingPlanningDurationMs)}</dd></div>
          </dl>
          <label className="flex items-start gap-3 text-sm leading-6 text-ink-inverse">
            <input type="checkbox" className="mt-1" checked={confirmed}
              onChange={e => setConfirmed(e.target.checked)} />
            Confirmo esta alteração apenas no planejamento do Sonoriza.
            Vou trocar o capítulo manualmente no Spotify quando desejar.
          </label>
          <button type="button" className="primary-button" disabled={!changeEnabled || !confirmed || pending}
            onClick={commit}>Confirmar novo capítulo local</button>
          {!changeEnabled ? (
            <p className="text-sm text-muted-inverse" role="status">
              Modo de prévia: a atualização está desativada até aprovação do Gate C.
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="text-sm text-ink-inverse">{error}</p> : null}
      {message ? <p role="status" className="text-sm font-bold text-ink-inverse">{message}</p> : null}
    </section>
  );
}
