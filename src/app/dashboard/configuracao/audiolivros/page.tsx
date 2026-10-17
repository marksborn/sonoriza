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
        <AudiobookManualBindWizard
          targets={targets}
          bindingEnabled={audiobookBindEnabled(process.env)}
        />
        {process.env.AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE === "PREVIEW" ? (
          <section className="mt-10">
            <AudiobookSelfReportedPreview targets={targets} notebookEnabled={manualNotebookEnabled(process.env)} />
          </section>
        ) : null}
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
