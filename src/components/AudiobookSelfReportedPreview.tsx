"use client";

import React, { useEffect, useState } from "react";
import { AudiobookManualAdvisory } from "@/components/AudiobookManualAdvisory";
import {
  formatManualDuration,
  formatUserDeclaredChapterNotes,
  parseManualSecondsToMs,
  previewUserDeclaredChapterDuration,
} from "@/services/audiobooks/d6-self-reported-preview";

type ManualTarget = Readonly<{
  id: string;
  name: string;
  spotifyPlaylistId: string;
  durationMs: number;
}>;

const errors: Readonly<Record<string, string>> = {
  INVALID_INPUT: "Informações incompletas ou inválidas.",
  INVALID_LABELS: "Informe título do livro e nome do capítulo, com até 120 caracteres cada.",
  INVALID_TARGET_DURATION: "A playlist deve ter duração fixa positiva.",
  INVALID_CHAPTER_DURATION: "Informe a duração positiva do capítulo (até 24 horas).",
  INVALID_SELECTION: "Escolha se o capítulo será contado inteiro ou pelo tempo restante.",
  INVALID_MANUAL_PROGRESS: "O tempo consumido deve estar entre zero e a duração do capítulo.",
  CHAPTER_ALREADY_FINISHED: "O capítulo informado já terminou. Escolha o próximo manualmente.",
  CHAPTER_EXCEEDS_TARGET: "O tempo restante do capítulo supera a duração prevista da playlist. Não será cortado automaticamente.",
};

const fieldClass = "w-full rounded-xl border border-line-dark bg-surface-subtle px-4 py-3 text-sm text-ink-inverse";

type StoredNotebook = Readonly<{
  revision: number;
  bookTitle: string;
  chapterLabel: string;
  chapterDurationMs: number;
  consumedMs: number;
  evidenceSource: "USER_DECLARED_UNVERIFIED";
}>;

type NotebookHistory = Readonly<{
  revision: number;
  bookTitle: string;
  chapterLabel: string;
  chapterDurationMs: number;
  consumedMs: number;
  createdAt: string;
}>;

export function AudiobookSelfReportedPreview({
  targets, notebookEnabled = false, advisoryEnabled = false,
}: Readonly<{
  targets: readonly ManualTarget[];
  notebookEnabled?: boolean;
  advisoryEnabled?: boolean;
}>) {
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const [bookTitle, setBookTitle] = useState("");
  const [chapterLabel, setChapterLabel] = useState("");
  const [chapterSeconds, setChapterSeconds] = useState("");
  const [mode, setMode] = useState<"FULL_CHAPTER" | "MANUAL_REMAINDER">("FULL_CHAPTER");
  const [consumedSeconds, setConsumedSeconds] = useState("0");
  const [submitted, setSubmitted] = useState(false);
  const [notebook, setNotebook] = useState<StoredNotebook | null>(null);
  const [history, setHistory] = useState<readonly NotebookHistory[]>([]);
  const [notebookError, setNotebookError] = useState("");
  const [notebookSuccess, setNotebookSuccess] = useState("");
  const [notebookPending, setNotebookPending] = useState(false);
  const [confirmedSave, setConfirmedSave] = useState(false);
  const [confirmedDelete, setConfirmedDelete] = useState(false);

  useEffect(() => {
    setNotebook(null);
    setHistory([]);
    setNotebookError("");
    setNotebookSuccess("");
    setConfirmedSave(false);
    setConfirmedDelete(false);
    if (!notebookEnabled || !targetId) return;
    const controller = new AbortController();
    fetch("/api/audiobooks/manual-notebook?targetPlaylistId=" +
      encodeURIComponent(targetId), {
      cache: "no-store",
      signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error("Não foi possível consultar o caderno manual.");
      return response.json() as Promise<{
        notebook: StoredNotebook | null;
        history: NotebookHistory[];
      }>;
    }).then(data => {
      if (!controller.signal.aborted) {
        setNotebook(data.notebook);
        setHistory(data.history);
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setNotebookError("Não foi possível carregar o histórico. Não salve antes de recarregar.");
      }
    });
    return () => controller.abort();
  }, [notebookEnabled, targetId]);

  const selected = targets.find(target => target.id === targetId);
  const chapterMs = parseManualSecondsToMs(chapterSeconds);
  const consumedMs = parseManualSecondsToMs(consumedSeconds);
  const result = submitted && selected && chapterMs !== null &&
      (mode === "FULL_CHAPTER" || consumedMs !== null)
    ? previewUserDeclaredChapterDuration({
        targetDurationMs: selected.durationMs,
        bookTitle,
        chapterLabel,
        chapterDurationMs: chapterMs,
        selection: mode === "FULL_CHAPTER"
          ? { mode: "FULL_CHAPTER" }
          : { mode: "MANUAL_REMAINDER", consumedMs: consumedMs! },
      })
    : null;
  const invalidNumeric = submitted && (
    chapterMs === null ||
    (mode === "MANUAL_REMAINDER" && consumedMs === null)
  );

  function change(callback: () => void) {
    setSubmitted(false);
    setConfirmedSave(false);
    setNotebookSuccess("");
    callback();
  }

  async function refreshNotebook(): Promise<void> {
    if (!targetId) return;
    const response = await fetch("/api/audiobooks/manual-notebook?targetPlaylistId=" +
      encodeURIComponent(targetId), { cache: "no-store" });
    if (!response.ok) throw new Error("Não foi possível atualizar o caderno.");
    const data = await response.json() as {
      notebook: StoredNotebook | null;
      history: NotebookHistory[];
    };
    setNotebook(data.notebook);
    setHistory(data.history);
  }

  async function saveNotebook() {
    if (!notebookEnabled || notebookPending || !confirmedSave ||
        result?.status !== "READY_MANUAL_PREVIEW" || !selected ||
        notebookError) return;
    setNotebookPending(true);
    setNotebookSuccess("");
    setNotebookError("");
    try {
      const response = await fetch("/api/audiobooks/manual-notebook", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetPlaylistId: selected.id,
          expectedRevision: notebook?.revision ?? 0,
          bookTitle: result.bookTitle,
          chapterLabel: result.chapterLabel,
          chapterDurationMs: result.declaredChapterDurationMs,
          selection: mode === "FULL_CHAPTER"
            ? { mode: "FULL_CHAPTER" }
            : { mode: "MANUAL_REMAINDER", consumedMs: result.declaredConsumedMs },
          confirmation: "SALVAR_ANOTACAO_NAO_VERIFICADA",
        }),
      });
      if (!response.ok) throw new Error(
        response.status === 409
          ? "O caderno ou destino mudou. Recarregue o histórico antes de salvar."
          : "Não foi possível salvar a anotação.");
      await refreshNotebook();
      setNotebookSuccess("Anotação autodeclarada salva; não foi enviada ao Spotify.");
      setConfirmedSave(false);
    } catch (error) {
      setNotebookError(error instanceof Error ? error.message : "Erro ao salvar.");
    } finally {
      setNotebookPending(false);
    }
  }

  async function deleteNotebook() {
    if (!notebookEnabled || !notebook || !selected ||
        !confirmedDelete || notebookPending) return;
    setNotebookPending(true);
    setNotebookSuccess("");
    setNotebookError("");
    try {
      const response = await fetch("/api/audiobooks/manual-notebook", {
        method: "DELETE",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetPlaylistId: selected.id,
          expectedRevision: notebook.revision,
          confirmation: "EXCLUIR_CADERNO_MANUAL_E_HISTORICO",
        }),
      });
      if (!response.ok) throw new Error(
        "Não foi possível excluir. Recarregue para conferir a revisão atual.");
      setNotebook(null);
      setHistory([]);
      setConfirmedDelete(false);
      setNotebookSuccess("Caderno e histórico excluídos. Nenhuma playlist foi alterada.");
    } catch (error) {
      setNotebookError(error instanceof Error ? error.message : "Erro ao excluir.");
    } finally {
      setNotebookPending(false);
    }
  }

  return (
    <section className="product-panel space-y-5 p-5 sm:p-7">
      <div>
        <span className="product-badge">Gate D.6 · Alternativa manual</span>
        <h2 className="mt-3 text-xl font-black text-ink-inverse">
          Planejar um capítulo sem a API de audiolivros
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-inverse">
          Para quando o Spotify não disponibiliza o catálogo ou os capítulos
          para a sua conta. Informe você mesmo a duração que aparece no aplicativo.
          <strong> O Sonoriza não verificará o livro, o capítulo nem a duração informada.</strong>
          {" "}A prévia não cria vínculo e não alimenta a geração de playlists.
          {notebookEnabled
            ? " Você pode salvar uma anotação separada e não verificada com confirmação explícita."
            : " Ela é temporária no navegador e não salva nada no banco."}
        </p>
      </div>
      <div className="space-y-2">
        <label htmlFor="audiobook-d6-target" className="block text-sm font-bold text-ink-inverse">
          Playlist de duração fixa (somente referência)
        </label>
        <select id="audiobook-d6-target" className={fieldClass} value={targetId}
          disabled={targets.length === 0}
          onChange={event => change(() => setTargetId(event.target.value))}>
          {targets.map(target => <option key={target.id} value={target.id}>
            {target.name} — {formatManualDuration(target.durationMs)}
          </option>)}
        </select>
        {selected ? (
          <a href={"https://open.spotify.com/playlist/" + selected.spotifyPlaylistId}
            target="_blank" rel="noopener noreferrer" className="inline-block text-sm text-accent-400 underline">
            Conferir playlist no Spotify
          </a>
        ) : (
          <p className="text-sm text-muted-inverse">Nenhum destino elegível. Configure primeiro uma playlist FIXED sem vínculo de audiolivro.</p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-bold text-ink-inverse">
          Livro (informado por você)
          <input className={"mt-2 " + fieldClass} value={bookTitle} maxLength={120}
            placeholder="Ex.: 1984" onChange={event => change(() => setBookTitle(event.target.value))} />
        </label>
        <label className="text-sm font-bold text-ink-inverse">
          Capítulo (informado por você)
          <input className={"mt-2 " + fieldClass} value={chapterLabel} maxLength={120}
            placeholder="Ex.: Apresentação" onChange={event => change(() => setChapterLabel(event.target.value))} />
        </label>
        <label className="text-sm font-bold text-ink-inverse">
          Duração do capítulo em segundos
          <input type="text" inputMode="decimal" className={"mt-2 " + fieldClass}
            placeholder="Ex.: 20,039 para 20 segundos e 39 ms"
            value={chapterSeconds} onChange={event => change(() => setChapterSeconds(event.target.value))} />
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm font-bold text-ink-inverse">Quanto falta ouvir?</legend>
          <label className="flex items-center gap-2 text-sm text-ink-inverse">
            <input type="radio" name="audiobook-d6-progress" checked={mode === "FULL_CHAPTER"}
              onChange={() => change(() => setMode("FULL_CHAPTER"))} />
            Capítulo inteiro
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-inverse">
            <input type="radio" name="audiobook-d6-progress" checked={mode === "MANUAL_REMAINDER"}
              onChange={() => change(() => setMode("MANUAL_REMAINDER"))} />
            Descontar tempo já ouvido
          </label>
          {mode === "MANUAL_REMAINDER" ? (
            <label className="block text-sm text-ink-inverse">
              Segundos já ouvidos (0 até a duração total)
              <input type="text" inputMode="decimal" value={consumedSeconds}
                className={"mt-2 " + fieldClass}
                onChange={event => change(() => setConsumedSeconds(event.target.value))} />
            </label>
          ) : null}
        </fieldset>
      </div>
      <button type="button" className="secondary-button" disabled={!selected}
        onClick={() => setSubmitted(true)}>
        Calcular prévia manual (sem salvar)
      </button>
      {invalidNumeric ? (
        <p role="alert" className="text-sm text-ink-inverse">
          Informe a duração em segundos, usando vírgula ou ponto e até 3 casas
          decimais (por exemplo, 20,039). Não use valores negativos.
        </p>
      ) : null}
      {result?.status === "BLOCKED" ? (
        <p role="alert" className="text-sm text-ink-inverse">
          {errors[result.reason] ?? "Não foi possível calcular a prévia."}
        </p>
      ) : null}
      {result?.status === "READY_MANUAL_PREVIEW" && selected ? (
        <div className="space-y-4 rounded-2xl border border-line-dark p-4" role="status">
          <p className="font-bold text-ink-inverse">Estimativa baseada exclusivamente em sua informação</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div><p className="text-xs text-muted-inverse">Capítulo virtual</p>
              <p className="font-black text-ink-inverse">{formatManualDuration(result.effectivePlanningDurationMs)}</p></div>
            <div><p className="text-xs text-muted-inverse">Duração da playlist</p>
              <p className="font-black text-ink-inverse">{formatManualDuration(result.targetDurationMs)}</p></div>
            <div><p className="text-xs text-muted-inverse">Tempo restante</p>
              <p className="font-black text-ink-inverse">{formatManualDuration(result.remainingPlanningDurationMs)}</p></div>
          </div>
          <p className="text-sm leading-6 text-muted-inverse">
            <strong>Origem: USER_DECLARED_UNVERIFIED.</strong> Não verificado pelo Spotify.
            Sem vínculo local, sem simulação SHADOW, sem autorização de escrita e
            sem controle automático de reprodução ou troca de capítulo.
          </p>
          <label className="block text-sm font-bold text-ink-inverse">
            Anotação para copiar e guardar por conta própria
            <textarea className={"mt-2 min-h-44 " + fieldClass} readOnly
              value={formatUserDeclaredChapterNotes(result, selected.name)} rows={11} />
          </label>
          <p className="text-xs text-muted-inverse">
            {notebookEnabled
              ? "A prévia desaparece ao recarregar a página. Apenas anotações salvas com confirmação permanecem no caderno."
              : "A anotação desaparece ao sair ou recarregar a página."}
            {" "}Para atualizar o capítulo, informe o próximo manualmente.
          </p>
        </div>
      ) : null}
      {notebookEnabled ? (
        <div className="space-y-4 rounded-2xl border border-line-dark p-4">
          <h3 className="font-bold text-ink-inverse">Gate D.7 · Caderno manual e histórico</h3>
          <p className="text-sm leading-6 text-muted-inverse">
            O histórico fica armazenado somente no Sonoriza, identificado como
            USER_DECLARED_UNVERIFIED. Ele NÃO comprova a presença do livro no Spotify,
            NÃO alimenta o planejador SHADOW e NÃO autoriza a geração ou a escrita de playlists.
          </p>
          {notebook ? (
            <p className="text-sm text-ink-inverse">
              Última anotação — revisão {notebook.revision}: {notebook.bookTitle} /
              {notebook.chapterLabel}, duração informada: {formatManualDuration(notebook.chapterDurationMs)},
              já ouvido: {formatManualDuration(notebook.consumedMs)}.
            </p>
          ) : <p className="text-sm text-muted-inverse">Nenhuma anotação salva para este destino.</p>}
          {advisoryEnabled && notebook && selected ? (
            <AudiobookManualAdvisory
              key={selected.id + ":" + notebook.revision}
              targetPlaylistId={selected.id}
              expectedRevision={notebook.revision}
            />
          ) : null}
          {result?.status === "READY_MANUAL_PREVIEW" && selected ? (
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm text-ink-inverse">
                <input type="checkbox" checked={confirmedSave}
                  onChange={event => setConfirmedSave(event.target.checked)} />
                Confirmo que os dados são meus, não foram verificados pelo Spotify e
                desejo armazená-los no caderno manual do Sonoriza.
              </label>
              <button type="button" className="secondary-button"
                disabled={!confirmedSave || notebookPending || Boolean(notebookError)}
                onClick={saveNotebook}>
                {notebookPending ? "Salvando..." : "Salvar anotação manual (não verificada)"}
              </button>
            </div>
          ) : null}
          {history.length ? (
            <div className="space-y-2">
              <p className="font-semibold text-sm text-ink-inverse">Últimas revisões (máximo 50)</p>
              <ol className="space-y-1 text-sm text-muted-inverse">
                {history.map(row => (
                  <li key={row.revision}>
                    Revisão {row.revision} — {row.bookTitle} / {row.chapterLabel}:
                    {" "}{formatManualDuration(row.chapterDurationMs - row.consumedMs)} restantes
                    (informados manualmente)
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {notebook ? (
            <div className="space-y-2 border-t border-line-dark pt-3">
              <label className="flex items-start gap-2 text-sm text-ink-inverse">
                <input type="checkbox" checked={confirmedDelete}
                  onChange={event => setConfirmedDelete(event.target.checked)} />
                Quero apagar este caderno e todo o histórico de capítulos informados.
              </label>
              <button type="button" className="secondary-button"
                disabled={!confirmedDelete || notebookPending}
                onClick={deleteNotebook}>
                Apagar caderno e histórico
              </button>
            </div>
          ) : null}
          {notebookError ? <p role="alert" className="text-sm text-ink-inverse">
            {notebookError}
          </p> : null}
          {notebookSuccess ? <p role="status" className="text-sm text-ink-inverse">
            {notebookSuccess}
          </p> : null}
        </div>
      ) : null}
    </section>
  );
}
