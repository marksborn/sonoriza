"use client";

import { useEffect, useState } from "react";
import {
  AUDIOBOOK_1984_MANUAL_EXAMPLE,
} from "@/services/audiobooks/d11-manual-ux";
import { parseManualSecondsToMs, formatManualDuration } from
  "@/services/audiobooks/d6-self-reported-preview";
import {
  LIBRARY_ATTACH_CONFIRMATION, LIBRARY_COMPLETE_CONFIRMATION,
  LIBRARY_START_CONFIRMATION, LIBRARY_UPDATE_CONFIRMATION,
  projectLibraryChapterBudget,
} from "@/services/audiobooks/d12-library-contract";

type Target = Readonly<{
  id: string; name: string; spotifyPlaylistId: string;
  durationMode: "FIXED" | "CALENDAR";
  fixedDurationSeconds: number | null; updatePolicy: string;
}>;
type Reading = Readonly<{
  id: string; bookTitle: string; spotifyShowUrl: string;
  chapterLabel: string; chapterDurationMs: number; consumedMs: number;
  revision: number; evidenceSource: string;
  targets: readonly { targetPlaylistId: string; spotifyPlaylistId: string;
    targetName: string; createdAt: string }[];
  history: readonly { revision: number; chapterLabel: string;
    chapterDurationMs: number; consumedMs: number; recordedAt: string }[];
}>;
type State = Readonly<{
  current: Reading | null;
  completed: readonly { id: string; bookTitle: string;
    spotifyShowUrl: string; completedAt: string | null;
    finalRevision: number; targetNames: readonly string[] }[];
  legacyReviewRequired: boolean; spotifyWrites: false;
}>;

const inputClass = "mt-2 w-full rounded-xl border border-line-dark bg-surface-subtle px-4 py-3 text-sm text-ink-inverse";
const field = "block text-sm font-bold text-ink-inverse";
const panel = "rounded-2xl border border-line-dark p-5 text-ink-inverse";
const errorNames: Record<string,string> = {
  AUDIOBOOK_LIBRARY_LEGACY_REVIEW_REQUIRED: "Existe um caderno ou vínculo antigo. Conclua ou revise o registro antigo antes de começar outro livro.",
  AUDIOBOOK_LIBRARY_PREVIOUS_BOOK_PRESENCE_NOT_VERIFIED_REMOVED: "Este destino continua protegido por um livro anterior. Não é seguro reutilizá-lo sem confirmar a remoção remota.",
  AUDIOBOOK_LIBRARY_LEGACY_TARGET_PROTECTED: "Este destino tem um audiolivro protegido pelo modo anterior.",
  AUDIOBOOK_LIBRARY_REMOTE_WRITE_ACTIVE_OR_UNCERTAIN: "Existe uma escrita Spotify em andamento ou incerta nesta playlist.",
  AUDIOBOOK_LIBRARY_ALREADY_ASSOCIATED: "Este livro já está associado a essa playlist.",
  AUDIOBOOK_LIBRARY_ACTIVE_READING_OR_REVISION_CONFLICT: "O capítulo mudou em outra sessão. Atualize a página e tente novamente.",
};

export function AudiobookMultiPlaylistLibrary({ targets }: { targets: readonly Target[] }) {
  const [state, setState] = useState<State | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [bookTitle, setBookTitle] = useState("");
  const [showUrl, setShowUrl] = useState("");
  const [chapterLabel, setChapterLabel] = useState("");
  const [seconds, setSeconds] = useState("");
  const [consumed, setConsumed] = useState("0");
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const [confirmPresence, setConfirmPresence] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);

  async function load() {
    const response = await fetch("/api/audiobooks/library", { cache: "no-store" });
    if (!response.ok) throw new Error("Não foi possível carregar a biblioteca.");
    const data = await response.json() as State;
    setState(data);
    return data;
  }
  useEffect(() => {
    let mounted = true;
    fetch("/api/audiobooks/library", { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Biblioteca indisponível.");
        return response.json() as Promise<State>;
      }).then(data => {
        if (mounted) {
          setState(data);
          if (data.current) {
            setChapterLabel(data.current.chapterLabel);
            setSeconds((data.current.chapterDurationMs / 1000).toFixed(3));
            setConsumed((data.current.consumedMs / 1000).toFixed(3));
          }
        }
      })
      .catch(() => { if (mounted) setError("Não foi possível carregar a biblioteca."); });
    return () => { mounted = false; };
  }, []);

  async function mutate(body: Record<string, unknown>, success: string) {
    if (pending) return;
    setPending(true); setStatus(""); setError("");
    try {
      const response = await fetch("/api/audiobooks/library", {
        method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const err = await response.json() as { code?: string };
        throw new Error(errorNames[err.code ?? ""] ??
          "Operação recusada (" + (err.code ?? response.status) + ").");
      }
      const next = await load();
      setStatus(success);
      setConfirmPresence(false);
      setConfirmFinish(false);
      if (next.current) {
        setChapterLabel(next.current.chapterLabel);
        setSeconds((next.current.chapterDurationMs / 1000).toFixed(3));
        setConsumed((next.current.consumedMs / 1000).toFixed(3));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setPending(false);
    }
  }

  function chapterInput() {
    const chapterDurationMs = parseManualSecondsToMs(seconds);
    const consumedMs = parseManualSecondsToMs(consumed);
    if (chapterDurationMs === null || consumedMs === null ||
        chapterDurationMs <= 0 || consumedMs >= chapterDurationMs) {
      setError("Informe segundos válidos: tempo ouvido menor que a duração do capítulo.");
      return null;
    }
    return { chapterLabel, chapterDurationMs, consumedMs };
  }

  const active = state?.current ?? null;
  const already = new Set(active?.targets.map(t => t.spotifyPlaylistId) ?? []);
  const available = targets.filter(t => !already.has(t.spotifyPlaylistId));
  const selectedAvailable = available.find(t => t.id === targetId) ?? available[0];

  return <div className="space-y-6">
    <header className="space-y-2">
      <span className="product-badge">AUDIOBOOK-02 D.12 · Biblioteca manual</span>
      <h1 className="text-3xl font-black text-ink-inverse">Um livro, várias playlists.</h1>
      <p className="text-sm leading-6 text-muted-inverse">
        Um único livro em andamento e o mesmo capítulo para todas as playlists.
        O livro inteiro precisa ser adicionado por você em cada playlist Spotify.
        O Sonoriza não altera a reprodução, o capítulo ou a playlist remota.
      </p>
    </header>
    {error && <p role="alert" className={panel}>{error}</p>}
    {status && <p role="status" className={panel}>{status}</p>}
    {!state && !error && <p className="text-ink-inverse">Carregando biblioteca…</p>}
    {state?.legacyReviewRequired && <p role="alert" className={panel}>
      Existe um caderno manual antigo vinculado a um destino. Conclua/revise
      esse registro no modo anterior antes de criar o livro global.
    </p>}
    {state && !active && <section className={panel + " space-y-4"}>
      <h2 className="text-xl font-black">Iniciar audiolivro</h2>
      <p className="text-sm text-muted-inverse">
        O livro é cadastrado uma vez, sem escolher playlist. Depois você pode
        associá-lo a quantos destinos desejar.
      </p>
      <button className="secondary-button" type="button" onClick={() => {
        setBookTitle(AUDIOBOOK_1984_MANUAL_EXAMPLE.bookTitle);
        setShowUrl(AUDIOBOOK_1984_MANUAL_EXAMPLE.spotifyShowUrl);
        setChapterLabel(AUDIOBOOK_1984_MANUAL_EXAMPLE.chapterLabel);
        setSeconds(AUDIOBOOK_1984_MANUAL_EXAMPLE.chapterSeconds);
        setConsumed("0");
      }}>Preencher exemplo 1984 (sem salvar)</button>
      <label className={field}>Título do livro
        <input className={inputClass} value={bookTitle} maxLength={120}
          onChange={e => setBookTitle(e.target.value)}/></label>
      <label className={field}>Link Spotify do livro (/show/)
        <input className={inputClass} value={showUrl} type="url"
          onChange={e => setShowUrl(e.target.value)}/></label>
      <label className={field}>Capítulo atual
        <input className={inputClass} value={chapterLabel} maxLength={120}
          onChange={e => setChapterLabel(e.target.value)}/></label>
      <label className={field}>Duração do capítulo, em segundos
        <input className={inputClass} value={seconds} inputMode="decimal"
          placeholder="20,039" onChange={e => setSeconds(e.target.value)}/></label>
      <label className={field}>Segundos já ouvidos
        <input className={inputClass} value={consumed} inputMode="decimal"
          onChange={e => setConsumed(e.target.value)}/></label>
      <p className="text-xs text-muted-inverse">Dados declarados por você, não verificados pelo Spotify.</p>
      <button type="button" className="primary-button"
        disabled={pending || state.legacyReviewRequired}
        onClick={() => {
          const ch = chapterInput();
          if (ch) void mutate({ action: "START", bookTitle, spotifyShowUrl: showUrl,
            ...ch, confirmation: LIBRARY_START_CONFIRMATION },
            "Livro registrado na biblioteca local.");
        }}>Iniciar livro (somente no Sonoriza)</button>
    </section>}
    {active && <section className={panel + " space-y-4"}>
      <h2 className="text-xl font-black">Livro em andamento</h2>
      <p><strong>{active.bookTitle}</strong> · capítulo {active.chapterLabel}</p>
      <a href={active.spotifyShowUrl} target="_blank" rel="noopener noreferrer"
        className="underline text-sm">Abrir livro no Spotify ↗</a>
      <p className="text-sm text-muted-inverse">
        Duração restante: {formatManualDuration(active.chapterDurationMs - active.consumedMs)}.
        Uma alteração aqui atualiza o capítulo de referência em TODOS os destinos.
      </p>
      <label className={field}>Capítulo atual (atualização global)
        <input className={inputClass} value={chapterLabel} maxLength={120}
          onChange={e => setChapterLabel(e.target.value)}/></label>
      <label className={field}>Duração do capítulo, segundos
        <input className={inputClass} value={seconds} inputMode="decimal"
          onChange={e => setSeconds(e.target.value)}/></label>
      <label className={field}>Segundos já ouvidos
        <input className={inputClass} value={consumed} inputMode="decimal"
          onChange={e => setConsumed(e.target.value)}/></label>
      <button type="button" className="secondary-button" disabled={pending}
        onClick={() => {
          const ch = chapterInput();
          if (ch) void mutate({ action: "UPDATE", expectedRevision: active.revision,
            ...ch, confirmation: LIBRARY_UPDATE_CONFIRMATION },
            "Capítulo atualizado para todas as playlists.");
        }}>Salvar capítulo e progresso</button>
      <h3 className="font-semibold">Playlists associadas</h3>
      {active.targets.length === 0 && <p className="text-sm text-muted-inverse">
        Nenhuma associação ainda. Escolha uma playlist abaixo.
      </p>}
      {active.targets.map(t => {
        const target = targets.find(candidate =>
          candidate.spotifyPlaylistId === t.spotifyPlaylistId);
        const preview = target ? projectLibraryChapterBudget({
          chapterDurationMs: active.chapterDurationMs,
          consumedMs: active.consumedMs,
          durationMode: target.durationMode,
          fixedDurationSeconds: target.fixedDurationSeconds,
        }) : null;
        return <div key={t.spotifyPlaylistId} className="rounded-xl border border-line-dark p-3">
          <strong className="text-sm">{t.targetName}</strong>
          <p className="text-xs text-muted-inverse">
            {preview?.status === "READY_LOCAL_PREVIEW"
              ? "Capítulo virtual: " + formatManualDuration(preview.virtualChapterDurationMs) +
                " · saldo: " + formatManualDuration(preview.remainingBudgetMs)
              : preview?.status === "NEEDS_CALENDAR_DURATION"
                ? "Calendário: orçamento depende da duração dos eventos reais."
                : "Orçamento indisponível ou requer revisão neste destino."}
          </p>
          <p className="text-xs text-muted-inverse">
            Destino protegido: nenhuma alteração automática no Spotify.
          </p>
        </div>;
      })}
      {available.length > 0 && <div className="space-y-3 rounded-xl border border-line-dark p-4">
        <h3 className="font-semibold">Usar este livro em outra playlist</h3>
        <label className={field}>Escolha qualquer destino do Sonoriza
          <select className={inputClass}
            value={selectedAvailable?.id ?? ""}
            onChange={e => { setTargetId(e.target.value); setConfirmPresence(false); }}>
            {available.map(t => <option key={t.id} value={t.id}>
              {t.name} · {t.durationMode === "FIXED" ? "duração fixa" : "calendário"}
            </option>)}
          </select>
        </label>
        <p className="text-sm text-muted-inverse">
          Primeiro, proteja esta playlist no Sonoriza. Depois da confirmação,
          adicione o livro inteiro manualmente no Spotify. A associação NÃO
          adiciona áudio remotamente; a geração e a manutenção automáticas
          ficarão bloqueadas antes que você faça a inclusão.
        </p>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={confirmPresence}
            onChange={e => setConfirmPresence(e.target.checked)} />
          Confirmo que esta playlist deve ficar protegida contra escritas
          automáticas ANTES de eu adicionar o livro inteiro no Spotify
          (ou imediatamente, caso ele já esteja lá).
        </label>
        <button className="secondary-button" type="button"
          disabled={!confirmPresence || !selectedAvailable || pending}
          onClick={() => selectedAvailable && void mutate({
            action: "ATTACH", targetPlaylistId: selectedAvailable.id,
            expectedRevision: active.revision,
            confirmation: LIBRARY_ATTACH_CONFIRMATION,
          }, "Playlist protegida. Agora adicione o livro inteiro pelo Spotify, caso ainda não esteja nela.")}>
          Associar playlist (sem alterar Spotify)
        </button>
      </div>}
      <details className="text-sm text-muted-inverse">
        <summary className="cursor-pointer font-semibold">
          Histórico de capítulos ({active.history.length} revisões exibidas)
        </summary>
        <ol className="mt-3 space-y-1">
          {active.history.map(h => <li key={h.revision}>
            Revisão {h.revision}: {h.chapterLabel} ·
            {" "}{formatManualDuration(h.chapterDurationMs-h.consumedMs)} restantes
          </li>)}
        </ol>
      </details>
      <div className="space-y-3 border-t border-line-dark pt-4">
        <h3 className="font-semibold">Concluir o livro</h3>
        <p className="text-sm text-muted-inverse">
          Preserva todo o histórico e as associações. O Spotify não remove o
          livro automaticamente e as playlists continuam protegidas.
        </p>
        <label className="flex gap-2 text-sm">
          <input type="checkbox" checked={confirmFinish}
            onChange={e => setConfirmFinish(e.target.checked)}/>
          Concluir a leitura preservando histórico e proteção dos destinos.
        </label>
        <button type="button" className="secondary-button"
          disabled={!confirmFinish || pending}
          onClick={() => void mutate({ action: "COMPLETE",
            expectedRevision: active.revision,
            confirmation: LIBRARY_COMPLETE_CONFIRMATION },
          "Livro concluído; histórico e proteções preservados.")}>
          Concluir e arquivar livro
        </button>
      </div>
    </section>}
    {state && <section className={panel + " space-y-3"}>
      <h2 className="font-bold">Livros concluídos</h2>
      {!state.completed.length && <p className="text-sm text-muted-inverse">Nenhum ainda.</p>}
      {state.completed.map(b => <div key={b.id} className="text-sm">
        <strong>{b.bookTitle}</strong> · {b.finalRevision} revisões
        <p className="text-xs text-muted-inverse">
          Playlists protegidas: {b.targetNames.join(", ") || "nenhuma"}
        </p>
      </div>)}
    </section>}
  </div>;
}
