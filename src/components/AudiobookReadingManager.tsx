"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { SingleReadingPreview } from "@/services/audiobooks/d9-single-reading-preview";
import { COMPLETE_READING_CONFIRMATION } from "@/services/audiobooks/d9-completed-reading-contract";

type Active = Extract<SingleReadingPreview, { status: "SINGLE_NOTEBOOK" }> & {
  revision: number;
};

type Archived = Readonly<{
  id: string;
  bookTitle: string;
  completedAt: string;
  chaptersRecorded: number;
  finalRevision: number;
}>;

export function AudiobookReadingManager({
  active,
}: Readonly<{ active: Active | null }>) {
  const router = useRouter();
  const [ack, setAck] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [archive, setArchive] = useState<readonly Archived[]>([]);
  const [openedArchiveId, setOpenedArchiveId] = useState<string | null>(null);
  const [chapters, setChapters] = useState<readonly {
    revision: number; chapterLabel: string;
    chapterDurationMs: number; consumedMs: number;
  }[]>([]);
  const [archivePending, setArchivePending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/audiobooks/manual-reading", {
      cache: "no-store", signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error("Histórico indisponível");
      return response.json() as Promise<{ completed: Archived[] }>;
    }).then(data => {
      if (!controller.signal.aborted) setArchive(data.completed);
    }).catch(() => {
      if (!controller.signal.aborted) setError("Não foi possível carregar o histórico.");
    });
    return () => controller.abort();
  }, [success]);

  async function openArchive(id: string) {
    if (archivePending) return;
    if (openedArchiveId === id) {
      setOpenedArchiveId(null);
      setChapters([]);
      return;
    }
    setArchivePending(true);
    setError("");
    try {
      const response = await fetch(
        "/api/audiobooks/manual-reading?archiveId=" + encodeURIComponent(id),
        { cache: "no-store" },
      );
      if (!response.ok) throw Error("Histórico detalhado indisponível.");
      const data = await response.json() as {
        archived: { chapters: typeof chapters };
      };
      setChapters(data.archived.chapters);
      setOpenedArchiveId(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao carregar capítulos.");
    } finally {
      setArchivePending(false);
    }
  }

  async function complete() {
    if (!active || !ack || pending) return;
    setPending(true);
    setError("");
    setSuccess("");
    try {
      const response = await fetch("/api/audiobooks/manual-reading", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetPlaylistId: active.targetPlaylistId,
          expectedRevision: active.revision,
          confirmation: COMPLETE_READING_CONFIRMATION,
        }),
      });
      if (!response.ok) {
        throw new Error(response.status === 409
          ? "O registro mudou ou requer revisão. Recarregue a página antes de concluir."
          : "Não foi possível concluir o livro. Nenhuma alteração foi enviada ao Spotify.");
      }
      setAck(false);
      setSuccess("Leitura concluída e histórico preservado. A playlist continua protegida.");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao concluir.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mb-6 space-y-4 rounded-2xl border border-line-dark p-5 text-ink-inverse">
      <h2 className="text-lg font-black">Meu audiolivro em andamento</h2>
      {active ? (
        <>
          <div className="space-y-1 text-sm">
            <p className="font-bold">{active.bookTitle}</p>
            <p>Capítulo atual: {active.chapterLabel}</p>
            <p className="text-muted-inverse">Destino: {active.targetName}</p>
            <p className="text-muted-inverse">
              Tempo do capítulo ainda informado:
              {" "}{Math.floor(active.chapterRemainingMs / 60000)}min
              {" "}{((active.chapterRemainingMs % 60000) / 1000).toFixed(3)}s
            </p>
          </div>
          <p className="text-sm text-muted-inverse">
            O capítulo é atualizado manualmente no caderno abaixo. Concluir
            apenas arquiva o livro no Sonoriza: não remove o conteúdo no
            Spotify nem libera escritas automáticas na playlist.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={ack}
              onChange={event => setAck(event.target.checked)} />
            Concluir este livro, preservando todos os capítulos anotados.
            Confirmo que cuidarei manualmente do conteúdo no Spotify.
          </label>
          <button type="button" className="secondary-button"
            disabled={!ack || pending} onClick={complete}>
            {pending ? "Concluindo..." : "Concluir livro e preservar histórico"}
          </button>
        </>
      ) : <p className="text-sm text-muted-inverse">
        Nenhuma leitura atual identificada. Inicie o próximo livro pelo
        caderno manual abaixo, escolhendo uma playlist de duração fixa.
      </p>}
      {success ? <p role="status" className="text-sm">{success}</p> : null}
      {error ? <p role="alert" className="text-sm">{error}</p> : null}
      <div className="space-y-2 border-t border-line-dark pt-4">
        <h3 className="font-semibold">Livros concluídos</h3>
        {archive.length ? (
          <ol className="space-y-2 text-sm text-muted-inverse">
            {archive.map(item => (
              <li key={item.id} className="space-y-1">
                <button type="button" className="text-left underline"
                  onClick={() => openArchive(item.id)} disabled={archivePending}>
                  {item.bookTitle} — {item.chaptersRecorded} anotações,
                  concluído em {new Date(item.completedAt).toLocaleDateString("pt-BR")}
                </button>
                {openedArchiveId === item.id ? (
                  <ol className="ml-4 list-decimal space-y-1">
                    {chapters.map(chapter => (
                      <li key={chapter.revision}>
                        {chapter.chapterLabel} — {Math.floor(
                          (chapter.chapterDurationMs - chapter.consumedMs) / 60000,
                        )}min {((chapter.chapterDurationMs -
                          chapter.consumedMs) % 60000 / 1000).toFixed(3)}s
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ol>
        ) : <p className="text-sm text-muted-inverse">
          Ainda não há livros concluídos neste histórico.
        </p>}
        <p className="text-xs text-muted-inverse">
          Histórico registrado no Sonoriza com dados informados por você;
          não verificados pelo catálogo Spotify.
        </p>
      </div>
    </section>
  );
}
