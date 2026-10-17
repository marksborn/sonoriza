"use client";

import { useState } from "react";
import { AudiobookCapabilityInspector } from "@/components/AudiobookCapabilityInspector";

type Target = Readonly<{
  id: string;
  name: string;
  spotifyPlaylistId: string;
  durationMs: number;
}>;
type Chapter = Readonly<{
  id: string;
  name: string;
  durationMs: number;
  playable: boolean;
}>;
type Catalogue = Readonly<{
  audiobookId: string;
  audiobookName: string;
  chapters: Chapter[];
  total: number;
  truncated: boolean;
}>;
type Preview = Readonly<{
  status: "READY";
  targetName: string;
  audiobookName: string;
  chapterName: string;
  spotifyPlaylistId: string;
  spotifyAudiobookId: string;
  selectedChapterId: string;
  chapterDurationMs: number;
  targetDurationMs: number;
  effectivePlanningDurationMs: number;
  remainingPlanningDurationMs: number;
  manualSpotifyControlRequired: true;
  manualBookPresenceConfirmationRequired: true;
}>;
type JsonError = { error?: string; code?: string };

const fieldClass =
  "w-full rounded-xl border border-line-dark bg-surface-subtle px-4 py-3 text-sm text-ink-inverse focus:border-brand-400 focus:outline-none";
const labelClass = "mb-2 block text-sm font-bold text-ink-inverse";

function spotifyId(input: string): string | null {
  const value = input.trim();
  if (/^[A-Za-z0-9]{22}$/.test(value)) return value;
  const uri = /^spotify:audiobook:([A-Za-z0-9]{22})$/.exec(value);
  if (uri?.[1]) return uri[1];
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" ||
      (url.hostname !== "open.spotify.com" && url.hostname !== "play.spotify.com")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length === 2 && parts[0] === "audiobook" && /^[A-Za-z0-9]{22}$/.test(parts[1] ?? "")) {
      return parts[1] ?? null;
    }
  } catch { /* Not a URL. */ }
  return null;
}
function fmt(ms: number) {
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const milli = Math.floor(ms % 1000);
  return min + "min " + String(sec).padStart(2, "0") + "," +
    String(milli).padStart(3, "0") + "s";
}
async function postJson<T>(path: string, data: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    cache: "no-store",
  });
  const value = await response.json() as JsonError & T;
  if (!response.ok) throw new Error(value.error || value.code || "Consulta indisponível.");
  return value;
}

export function AudiobookManualBindWizard({
  targets,
  bindingEnabled,
}: Readonly<{ targets: Target[]; bindingEnabled: boolean }>) {
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const [bookReference, setBookReference] = useState("");
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [chapterId, setChapterId] = useState("");
  const [mode, setMode] = useState<"FULL_CHAPTER" | "MANUAL_REMAINDER">("FULL_CHAPTER");
  const [consumedSeconds, setConsumedSeconds] = useState("0");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmPresence, setConfirmPresence] = useState(false);
  const [confirmManual, setConfirmManual] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [linked, setLinked] = useState(false);

  const selected = targets.find(target => target.id === targetId);
  const parsedBookId = spotifyId(bookReference);
  function resetPreview() {
    setPreview(null);
    setConfirmPresence(false);
    setConfirmManual(false);
    setLinked(false);
    setError("");
  }
  function changeBook(value: string) {
    setBookReference(value);
    setCatalogue(null);
    setChapterId("");
    resetPreview();
  }
  async function loadChapters() {
    if (!parsedBookId || pending) return;
    setPending(true);
    setError("");
    setCatalogue(null);
    setChapterId("");
    resetPreview();
    try {
      const value = await postJson<Catalogue>("/api/audiobooks/catalog", {
        spotifyAudiobookId: parsedBookId,
      });
      setCatalogue(value);
      const first = value.chapters.find(c => c.playable);
      setChapterId(first?.id ?? "");
      if (!first) setError("Nenhum capítulo disponível para a conta ou mercado atual.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Catálogo indisponível.");
    } finally {
      setPending(false);
    }
  }
  function buildInput() {
    const selection = mode === "FULL_CHAPTER" ? { mode } : {
      mode,
      consumedMs: Number(consumedSeconds) * 1000,
    };
    return {
      targetPlaylistId: targetId,
      spotifyAudiobookId: catalogue?.audiobookId ?? "",
      selectedChapterId: chapterId,
      selection,
    };
  }
  async function runPreview() {
    if (!selected || !catalogue || !chapterId || pending) return;
    resetPreview();
    setPending(true);
    try {
      const value = await postJson<Preview>("/api/audiobooks/manual-preview", buildInput());
      if (value.status !== "READY") throw new Error("A duração do capítulo não foi confirmada.");
      setPreview(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível montar a prévia.");
    } finally {
      setPending(false);
    }
  }
  async function bind() {
    if (!bindingEnabled || !preview || !confirmPresence || !confirmManual || pending || linked) return;
    setPending(true);
    setError("");
    try {
      await postJson("/api/audiobooks/manual-bind", {
        ...buildInput(),
        confirmation: "CONFIRMAR_VINCULO_AUDIOLIVRO",
      });
      setLinked(true);
    } catch (e) {
      resetPreview();
      setError(e instanceof Error ? e.message : "Não foi possível criar o vínculo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <section className="product-panel space-y-5 p-5 sm:p-7">
        <div>
          <span className="product-badge">1 · Playlist de destino</span>
          <h2 className="mt-3 text-lg font-black text-ink-inverse">Qual playlist já contém o livro completo?</h2>
          <p className="mt-1 text-sm text-muted-inverse">
            Apenas destinos de duração fixa, existentes no Sonoriza e sem audiolivro vinculado.
          </p>
        </div>
        <div>
          <label htmlFor="audiobook-target" className={labelClass}>Destino no Sonoriza</label>
          <select id="audiobook-target" value={targetId} className={fieldClass}
            onChange={event => { setTargetId(event.target.value); resetPreview(); }}>
            {targets.map(t => (
              <option key={t.id} value={t.id}>
                {t.name} — {fmt(t.durationMs)}
              </option>
            ))}
          </select>
        </div>
        {selected ? <p className="text-xs text-muted-inverse">
          Playlist Spotify: <code>{selected.spotifyPlaylistId}</code>. O livro deve ser adicionado manualmente no Spotify antes de prosseguir.
        </p> : <p className="text-sm text-muted-inverse">
          Nenhuma playlist elegível. Configure primeiro um destino FIXED com playlist Spotify.
        </p>}
      </section>

      <section className="product-panel space-y-5 p-5 sm:p-7">
        <div>
          <span className="product-badge">2 · Livro e capítulo</span>
          <h2 className="mt-3 text-lg font-black text-ink-inverse">Identifique o audiolivro no Spotify</h2>
          <p className="mt-1 text-sm text-muted-inverse">
            Cole o link do audiolivro ou informe o ID. Consultaremos os capítulos sem modificar a playlist.
          </p>
        </div>
        <div>
          <label htmlFor="audiobook-reference" className={labelClass}>Link ou ID do audiolivro</label>
          <input id="audiobook-reference" value={bookReference} className={fieldClass}
            placeholder="https://open.spotify.com/audiobook/..."
            onChange={event => changeBook(event.target.value)} />
        </div>
        <AudiobookCapabilityInspector audiobookId={parsedBookId} />
        <button type="button" className="secondary-button" onClick={loadChapters}
          disabled={!selected || !parsedBookId || pending}>
          {pending ? "Consultando..." : "Buscar capítulos no Spotify"}
        </button>
        {catalogue ? (
          <div className="space-y-3 rounded-2xl border border-line-dark p-4">
            <p className="font-bold text-ink-inverse">{catalogue.audiobookName}</p>
            <a className="product-link" href={"https://open.spotify.com/audiobook/" + catalogue.audiobookId}
              target="_blank" rel="noopener noreferrer">Abrir o livro no Spotify ↗</a>
            <p className="text-xs text-muted-inverse">
              {catalogue.chapters.length} de {catalogue.total} capítulos encontrados
              {catalogue.truncated ? " (lista parcial; vínculo restrito aos exibidos)" : ""}
            </p>
            <label htmlFor="audiobook-chapter" className={labelClass}>Capítulo para o planejamento</label>
            <select id="audiobook-chapter" className={fieldClass} value={chapterId}
              onChange={event => { setChapterId(event.target.value); resetPreview(); }}>
              {catalogue.chapters.filter(c => c.playable).map((chapter, index) =>
                <option key={chapter.id} value={chapter.id}>
                  {index + 1}. {chapter.name} — {fmt(chapter.durationMs)}
                </option>)}
            </select>
          </div>
        ) : null}
        {catalogue && chapterId ? (
          <div className="space-y-3">
            <p className={labelClass}>Como contar a duração deste capítulo?</p>
            <label className="flex items-center gap-3 text-sm text-ink-inverse">
              <input type="radio" name="audiobook-progress" checked={mode === "FULL_CHAPTER"}
                onChange={() => { setMode("FULL_CHAPTER"); resetPreview(); }} />
              Capítulo inteiro
            </label>
            <label className="flex items-center gap-3 text-sm text-ink-inverse">
              <input type="radio" name="audiobook-progress" checked={mode === "MANUAL_REMAINDER"}
                onChange={() => { setMode("MANUAL_REMAINDER"); resetPreview(); }} />
              Considerar somente o restante, informado manualmente
            </label>
            {mode === "MANUAL_REMAINDER" ? (
              <div>
                <label htmlFor="audiobook-consumed" className={labelClass}>Segundos já consumidos neste capítulo</label>
                <input id="audiobook-consumed" type="number" min="0" step="1" className={fieldClass}
                  value={consumedSeconds}
                  onChange={event => { setConsumedSeconds(event.target.value); resetPreview(); }} />
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="product-panel space-y-5 p-5 sm:p-7">
        <div>
          <span className="product-badge">3 · Revisão e confirmação</span>
          <h2 className="mt-3 text-lg font-black text-ink-inverse">Prévia do tempo virtual</h2>
          <p className="mt-1 text-sm text-muted-inverse">
            O Sonoriza usa apenas o capítulo informado no orçamento de tempo. Ele não corta o áudio, não troca capítulos e não controla quando o Spotify para.
          </p>
        </div>
        <button type="button" onClick={runPreview} className="secondary-button"
          disabled={!selected || !catalogue || !chapterId || pending}>
          {pending ? "Validando..." : "Validar capítulo e calcular duração"}
        </button>
        {preview ? (
          <div className="space-y-4 rounded-2xl border border-brand-400/30 bg-surface-subtle/70 p-5" aria-live="polite">
            <div>
              <p className="text-xs text-muted-inverse">Livro confirmado pelo catálogo</p>
              <p className="font-black text-ink-inverse">{preview.audiobookName}</p>
              <p className="text-sm text-muted-inverse">Capítulo: {preview.chapterName}</p>
            </div>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div><dt className="text-xs text-muted-inverse">Destino</dt>
                <dd className="text-lg font-black text-ink-inverse">{fmt(preview.targetDurationMs)}</dd></div>
              <div><dt className="text-xs text-muted-inverse">Capítulo virtual</dt>
                <dd className="text-lg font-black text-accent-400">{fmt(preview.effectivePlanningDurationMs)}</dd></div>
              <div><dt className="text-xs text-muted-inverse">Saldo para outros conteúdos</dt>
                <dd className="text-lg font-black text-ink-inverse">{fmt(preview.remainingPlanningDurationMs)}</dd></div>
            </dl>
            <div className="space-y-3 border-t border-line-dark pt-4">
              <label className="flex items-start gap-3 text-sm leading-6 text-ink-inverse">
                <input type="checkbox" className="mt-1" checked={confirmPresence}
                  onChange={event => setConfirmPresence(event.target.checked)} />
                Confirmo que eu já coloquei este livro inteiro na playlist Spotify indicada. O Sonoriza não consegue identificar automaticamente esse item opaco.
              </label>
              <label className="flex items-start gap-3 text-sm leading-6 text-ink-inverse">
                <input type="checkbox" className="mt-1" checked={confirmManual}
                  onChange={event => setConfirmManual(event.target.checked)} />
                Entendo que a reprodução e a mudança do capítulo serão feitas manualmente no Spotify.
              </label>
            </div>
            <button type="button" className="primary-button" onClick={bind}
              disabled={!bindingEnabled || !confirmPresence || !confirmManual || pending || linked}>
              {linked ? "Vínculo local registrado" : "Confirmar vínculo do capítulo"}
            </button>
            {!bindingEnabled ? (
              <p className="text-sm text-muted-inverse" role="status">
                Modo de prévia: a confirmação está desativada até a liberação técnica do Gate B.
                Nenhum vínculo será salvo agora.
              </p>
            ) : null}
          </div>
        ) : null}
        {error ? <p className="rounded-xl border border-danger/30 p-3 text-sm text-ink-inverse"
          role="alert">{error}</p> : null}
        {linked ? <p role="status" className="text-sm font-bold text-ink-inverse">
          Vínculo salvo somente no Sonoriza. Não houve alteração da playlist Spotify.
        </p> : null}
      </section>
    </div>
  );
}
