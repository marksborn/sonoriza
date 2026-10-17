import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { AudiobookManualBindWizard } from "@/components/AudiobookManualBindWizard";
import { AudiobookChapterChangeEditor } from "@/components/AudiobookChapterChangeEditor";
import { AudiobookSelfReportedPreview } from "@/components/AudiobookSelfReportedPreview";
import { audiobookChapterUpdateEnabled } from "@/services/audiobooks/manual-chapter-change-contract";
import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { audiobookBindEnabled } from "@/services/audiobooks/manual-bind-contract";
import { manualNotebookEnabled } from "@/services/audiobooks/d7-manual-notebook-contract";
import { projectSingleReadingPreview } from "@/services/audiobooks/d9-single-reading-preview";
import { singleReadingEnabled } from "@/services/audiobooks/d9-completed-reading-contract";
import { AudiobookReadingManager } from "@/components/AudiobookReadingManager";

export const dynamic = "force-dynamic";

/** Gate B.4: OFF by default. Read-only preview in explicit developer mode. */
export default async function AudiobookConfigurationPage() {
  if (process.env.AUDIOBOOK02_BIND_UI_MODE !== "PREVIEW") notFound();

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const rows = await prisma.targetPlaylist.findMany({
    where: {
      userId: session.user.id,
      durationMode: "FIXED",
      spotifyPlaylistId: { not: null },
      audiobookOverlay: { is: null },
    },
    select: {
      id: true,
      name: true,
      spotifyPlaylistId: true,
      fixedDurationSeconds: true,
    },
    orderBy: [{ priority: "asc" }, { name: "asc" }],
  });
  const targets = rows.filter(t =>
    t.spotifyPlaylistId &&
    /^[A-Za-z0-9]{22}$/.test(t.spotifyPlaylistId) &&
    typeof t.fixedDurationSeconds === "number" &&
    t.fixedDurationSeconds > 0 &&
    Number.isSafeInteger(t.fixedDurationSeconds * 1000),
  ).map(t => ({
    id: t.id,
    name: t.name,
    spotifyPlaylistId: t.spotifyPlaylistId!,
    durationMs: t.fixedDurationSeconds! * 1000,
  }));

  // D.9.1 is strictly read-only and requires an already-enabled D.7 notebook.
  // The legacy schema permits more than one notebook per owner: never infer
  // that the first one is the current book.
  const manualNotes = manualNotebookEnabled(process.env)
    ? await prisma.targetAudiobookManualNotebook.findMany({
        where: { userId: session.user.id },
        take: 2,
        select: {
          userId: true, targetPlaylistId: true, revision: true,
          bookTitle: true, spotifyShowId: true, chapterLabel: true,
          chapterDurationMs: true, consumedMs: true, evidenceSource: true,
          target: { select: { name: true } },
        },
      })
    : [];
  const currentReading = projectSingleReadingPreview(session.user.id,
    manualNotes.map(note => ({
      ...note,
      targetName: note.target.name,
    })));

  const existing = await prisma.targetAudiobookOverlay.findMany({
    where: { userId: session.user.id },
    select: {
      targetPlaylistId: true,
      spotifyPlaylistId: true,
      spotifyAudiobookId: true,
      selectedChapterId: true,
      chapterDurationMs: true,
      manualConsumedMs: true,
      selectionMode: true,
      revision: true,
      target: { select: {
        name: true,
        spotifyPlaylistId: true,
        durationMode: true,
        fixedDurationSeconds: true,
      } },
    },
    orderBy: { createdAt: "asc" },
  });
  const updateCandidates = existing.filter(row =>
    row.target.spotifyPlaylistId === row.spotifyPlaylistId &&
    row.target.durationMode === "FIXED" &&
    typeof row.target.fixedDurationSeconds === "number" &&
    row.target.fixedDurationSeconds > 0,
  ).map(row => ({
    targetPlaylistId: row.targetPlaylistId,
    targetName: row.target.name,
    spotifyPlaylistId: row.spotifyPlaylistId,
    spotifyAudiobookId: row.spotifyAudiobookId,
    selectedChapterId: row.selectedChapterId,
    chapterDurationMs: row.chapterDurationMs,
    manualConsumedMs: row.manualConsumedMs,
    selectionMode: row.selectionMode,
    revision: row.revision,
    targetDurationMs: row.target.fixedDurationSeconds! * 1000,
  }));

  return (
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />
      <div className="relative mx-auto max-w-4xl">
        <Link href="/dashboard/configuracao" className="inline-flex items-center gap-2 text-sm font-bold text-muted-inverse hover:text-ink-inverse">
          <UiIcon name="arrow-left" size={18} />
          Voltar à configuração
        </Link>
        <header className="mb-8 mt-8">
          <span className="product-badge">AUDIOBOOK-02 · Prévia experimental</span>
          <h1 className="mt-3 text-3xl font-black tracking-tight text-ink-inverse sm:text-4xl">
            Audiolivro inteiro, tempo de um capítulo.
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-inverse">
            Um audiolivro colocado manualmente no Spotify pode entrar no orçamento de uma playlist com a duração virtual do capítulo escolhido. A seleção, a reprodução e a troca de capítulos continuam manuais.
          </p>
        </header>
        {singleReadingEnabled(process.env) && currentReading.status !== "REVIEW_REQUIRED" ? (
          <AudiobookReadingManager
            active={currentReading.status === "SINGLE_NOTEBOOK" && manualNotes.length === 1
              ? { ...currentReading, revision: manualNotes[0]?.revision ?? 0,
                  spotifyShowUrl: manualNotes[0]?.spotifyShowId
                    ? "https://open.spotify.com/show/" + manualNotes[0].spotifyShowId : null,
                } : null}
          />
        ) : (
        <section className="mb-6 rounded-2xl border border-line-dark p-5 text-ink-inverse">
          <h2 className="text-lg font-black">Um livro por vez</h2>
          <p className="mt-2 text-sm leading-6 text-muted-inverse">
            Escolha um audiolivro em andamento e atualize o capítulo manualmente.
            Ao concluir ou trocar de livro, o histórico deve ser preservado.
            Nenhuma dessas ações controla a reprodução no Spotify.
          </p>
          {currentReading.status === "SINGLE_NOTEBOOK" ? (
            <div className="mt-4 space-y-1 text-sm">
              <p className="font-bold">Anotação atual: {currentReading.bookTitle}</p>
              <p>Capítulo: {currentReading.chapterLabel}</p>
              <p className="text-muted-inverse">
                Destino: {currentReading.targetName} ·
                {Math.floor(currentReading.chapterRemainingMs / 60000)}min
                {" "}{((currentReading.chapterRemainingMs % 60000) / 1000).toFixed(3)}s restantes (informados manualmente)
              </p>
              <p className="text-xs text-muted-inverse">
                Concluir e iniciar o próximo livro exige a ativação controlada
                do modo de leitura única, com proteção permanente da playlist.
              </p>
            </div>
          ) : null}
          {currentReading.status === "REVIEW_REQUIRED" ? (
            <p role="alert" className="mt-4 text-sm font-bold">
              Existem anotações que não permitem identificar com segurança um único
              livro em andamento. Revise seus cadernos antes de continuar.
            </p>
          ) : null}
        </section>
        )}
        <p className="mb-3 text-sm text-muted-inverse">
          Se o seu livro é publicado como <code>/show/</code> no Spotify, não
          utilize a busca de audiolivros por catálogo abaixo. Use a alternativa
          manual para registrar a referência, o capítulo e sua duração.
          O país BR não possui a mesma disponibilidade de API de audiolivros
          dos mercados documentados.
        </p>
        {process.env.AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE === "PREVIEW" ? (
          <section id="audiobook-manual" className="mt-10 scroll-mt-6">
            <AudiobookSelfReportedPreview
              // Completion changes the current-book identity; remount the
              // D.7 editor so stale notebook revision cannot block next book.
              key={singleReadingEnabled(process.env)
                ? (manualNotes[0]?.targetPlaylistId ?? "none") + ":" +
                  (manualNotes[0]?.revision ?? 0)
                : "legacy"}
              targets={targets}
              notebookEnabled={manualNotebookEnabled(process.env)}
              singleReadingEnabled={singleReadingEnabled(process.env)}
              advisoryEnabled={manualNotebookEnabled(process.env) &&
                process.env.AUDIOBOOK02_MANUAL_SHADOW_MODE === "PREVIEW"}
            />
          </section>
        ) : null}
        <section className="mt-10 space-y-3">
          <h2 className="text-xl font-black text-ink-inverse">
            Consulta avançada de audiolivros via catálogo
          </h2>
          <p className="text-sm text-muted-inverse">
            Somente para links Spotify /audiobook/ e contas cujo catálogo
            disponibiliza capítulos. Livros publicados como /show/
            utilizam o formulário manual acima.
          </p>
          <AudiobookManualBindWizard
            targets={targets}
            bindingEnabled={audiobookBindEnabled(process.env)}
          />
        </section>
        {updateCandidates.length ? (
          <section className="mt-10 space-y-5">
            <div>
              <h2 className="text-2xl font-black text-ink-inverse">Livros já vinculados</h2>
              <p className="mt-2 text-sm text-muted-inverse">
                Troque o capítulo contado pelo Sonoriza sem mudar o livro ou a playlist no Spotify.
              </p>
            </div>
            {updateCandidates.map(row => (
              <AudiobookChapterChangeEditor
                key={row.targetPlaylistId}
                overlay={row}
                changeEnabled={audiobookChapterUpdateEnabled(process.env)}
                handoffPreviewEnabled={process.env.AUDIOBOOK02_PLANNER_MODE === "SHADOW"}
              />
            ))}
          </section>
        ) : null}
      </div>
    </main>
  );
}
