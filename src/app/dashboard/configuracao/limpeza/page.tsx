import {
  MusicSourceCleanupStatus,
  MusicSourceRetentionMode,
  SourceKind,
  SpotifySourceType,
} from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createMusicSourceCleanupPreview,
  executeMusicSourceCleanupPreview,
  MusicSourceCleanupHistoryRequiredError,
  MusicSourceCleanupStaleError,
} from "@/services/spotify/source-cleanup";

import { CleanupSubmitButton } from "./cleanup-submit-button";

const selectClass =
  "min-w-0 flex-1 rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2.5 text-sm font-bold text-ink-inverse outline-none transition focus:border-accent-400/70 focus:ring-2 focus:ring-accent/15";
const neutralButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-xl border border-line-dark/70 bg-surface-elevated/55 px-4 py-2.5 text-xs font-black text-ink-inverse transition hover:border-brand-400/55 hover:bg-surface-elevated disabled:cursor-not-allowed disabled:opacity-40";

function revalidateCleanupPages() {
  revalidatePath("/dashboard/configuracao");
  revalidatePath("/dashboard/configuracao/fontes");
  revalidatePath("/dashboard/configuracao/limpeza");
}

async function updateRetentionMode(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const id = String(formData.get("id") ?? "").trim();
  const rawMode = String(formData.get("mode") ?? "").trim();
  const mode =
    rawMode === MusicSourceRetentionMode.REMOVE_AFTER_PLAYED
      ? MusicSourceRetentionMode.REMOVE_AFTER_PLAYED
      : rawMode === MusicSourceRetentionMode.KEEP_ALL
        ? MusicSourceRetentionMode.KEEP_ALL
        : null;
  if (!id || !mode) redirect("/dashboard/configuracao/limpeza?error=invalid");

  const result = await prisma.sourcePlaylist.updateMany({
    where: {
      id,
      userId: session.user.id,
      kind: SourceKind.MUSIC,
      spotifyType: SpotifySourceType.PLAYLIST,
    },
    data: {
      musicRetentionMode: mode,
      ...(mode === MusicSourceRetentionMode.KEEP_ALL
        ? { musicCleanupAutomationEnabled: false }
        : {}),
    },
  });
  if (result.count !== 1) redirect("/dashboard/configuracao/limpeza?error=invalid");

  revalidateCleanupPages();
  redirect("/dashboard/configuracao/limpeza?saved=retention");
}

async function previewCleanup(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const id = String(formData.get("id") ?? "").trim();
  if (!id) redirect("/dashboard/configuracao/limpeza?error=invalid");

  try {
    const preview = await createMusicSourceCleanupPreview(session.user.id, id);
    revalidateCleanupPages();
    redirect(`/dashboard/configuracao/limpeza?preview=${preview.previewId}`);
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    if (error instanceof MusicSourceCleanupHistoryRequiredError) {
      redirect("/dashboard/configuracao/limpeza?error=history");
    }
    redirect("/dashboard/configuracao/limpeza?error=preview");
  }
}

async function executeCleanup(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const previewId = String(formData.get("previewId") ?? "").trim();
  if (!previewId) redirect("/dashboard/configuracao/limpeza?error=invalid");

  const executablePreview = await prisma.musicSourceCleanupRun.findFirst({
    where: {
      id: previewId,
      userId: session.user.id,
      status: MusicSourceCleanupStatus.PREVIEW,
    },
    select: {
      removableTrackCount: true,
      removalOccurrenceCount: true,
    },
  });

  if (!executablePreview) {
    redirect("/dashboard/configuracao/limpeza?error=invalid");
  }

  if (
    executablePreview.removableTrackCount < 1 ||
    executablePreview.removalOccurrenceCount < 1
  ) {
    revalidateCleanupPages();
    redirect(`/dashboard/configuracao/limpeza?error=empty&preview=${previewId}`);
  }

  try {
    const result = await executeMusicSourceCleanupPreview(
      session.user.id,
      previewId,
    );
    revalidateCleanupPages();
    redirect(
      `/dashboard/configuracao/limpeza?saved=${
        result.status === MusicSourceCleanupStatus.SUCCESS ? "cleaned" : "partial"
      }&run=${result.runId}`,
    );
  } catch (error) {
    if (error && typeof error === "object" && "digest" in error) throw error;
    if (error instanceof MusicSourceCleanupStaleError) {
      revalidateCleanupPages();
      redirect(`/dashboard/configuracao/limpeza?error=stale&preview=${previewId}`);
    }
    if (error instanceof MusicSourceCleanupHistoryRequiredError) {
      redirect("/dashboard/configuracao/limpeza?error=history");
    }
    revalidateCleanupPages();
    redirect(`/dashboard/configuracao/limpeza?error=execute&preview=${previewId}`);
  }
}

async function updateAutomation(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const id = String(formData.get("id") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "") === "true";
  if (!id) redirect("/dashboard/configuracao/limpeza?error=invalid");

  const source = await prisma.sourcePlaylist.findFirst({
    where: {
      id,
      userId: session.user.id,
      kind: SourceKind.MUSIC,
      spotifyType: SpotifySourceType.PLAYLIST,
    },
    select: {
      musicRetentionMode: true,
      musicCleanupFirstCompletedAt: true,
    },
  });
  if (!source) redirect("/dashboard/configuracao/limpeza?error=invalid");

  if (
    enabled &&
    (source.musicRetentionMode !== MusicSourceRetentionMode.REMOVE_AFTER_PLAYED ||
      !source.musicCleanupFirstCompletedAt)
  ) {
    redirect("/dashboard/configuracao/limpeza?error=automation");
  }

  await prisma.sourcePlaylist.update({
    where: { id },
    data: { musicCleanupAutomationEnabled: enabled },
  });

  revalidateCleanupPages();
  redirect("/dashboard/configuracao/limpeza?saved=automation");
}

type CleanupPageProps = {
  searchParams: Promise<{
    preview?: string;
    run?: string;
    saved?: string;
    error?: string;
  }>;
};

export default async function MusicSourceCleanupPage({ searchParams }: CleanupPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const params = await searchParams;
  const [sources, musicPolicy, preview, completedRun] = await Promise.all([
    prisma.sourcePlaylist.findMany({
      where: {
        userId: session.user.id,
        kind: SourceKind.MUSIC,
        spotifyType: SpotifySourceType.PLAYLIST,
      },
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
    }),
    prisma.musicPlaybackPolicy.findUnique({
      where: { userId: session.user.id },
      select: {
        enabled: true,
        historyKnownSince: true,
        lastSyncAt: true,
      },
    }),
    params.preview
      ? prisma.musicSourceCleanupRun.findFirst({
          where: { id: params.preview, userId: session.user.id },
          include: { source: { select: { name: true } } },
        })
      : null,
    params.run
      ? prisma.musicSourceCleanupRun.findFirst({
          where: { id: params.run, userId: session.user.id },
          include: { source: { select: { name: true } } },
        })
      : null,
  ]);

  const savedIsWarning = params.saved === "partial";
  const errorIsDanger = params.error === "execute";

  return (
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />

      <div className="relative mx-auto max-w-5xl">
        <Link
          href="/dashboard/configuracao"
          className="inline-flex items-center gap-2 text-sm font-bold text-muted-inverse transition hover:text-ink-inverse"
        >
          <UiIcon name="arrow-left" size={18} />
          Central de configuração
        </Link>

        <header className="mt-6 max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-accent-400">MUSIC-02</p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
            Limpeza de playlists-inbox
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-inverse sm:text-base">
            Fontes normais permanecem intactas. Para uma fila de entrada, o Sonoriza pode remover somente músicas cuja reprodução já foi confirmada no histórico nativo.
          </p>
        </header>

        <section className="product-card mt-7 p-5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-black text-ink-inverse">Histórico usado como evidência</p>
              <p className="mt-1 text-muted-inverse">
                {musicPolicy?.enabled
                  ? `Ativo · conhecido desde ${formatDateTime(musicPolicy.historyKnownSince)}`
                  : "Inativo — a limpeza fica bloqueada até o histórico nativo estar ativo."}
              </p>
            </div>
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-black ${musicPolicy?.enabled ? "status-success" : "status-warning"}`}>
              <UiIcon name={musicPolicy?.enabled ? "check" : "warning"} size={14} />
              Último sync: {formatDateTime(musicPolicy?.lastSyncAt ?? null)}
            </span>
          </div>
        </section>

        {params.saved && (
          <div className={`${savedIsWarning ? "status-warning" : "status-success"} mt-5 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-bold`}>
            <UiIcon name={savedIsWarning ? "warning" : "check"} size={17} className="mt-0.5 shrink-0" />
            <span>
              {params.saved === "retention" && "Política da fonte salva. Nenhum item foi removido do Spotify."}
              {params.saved === "automation" && "Preferência de limpeza periódica atualizada."}
              {params.saved === "cleaned" && "Limpeza confirmada e concluída. O resultado foi registrado para auditoria."}
              {params.saved === "partial" && "A limpeza terminou parcialmente. Revise o resultado antes de tentar novamente."}
            </span>
          </div>
        )}

        {params.error && (
          <div className={`${errorIsDanger ? "status-danger" : "status-warning"} mt-5 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-bold`}>
            <UiIcon name="warning" size={17} className="mt-0.5 shrink-0" />
            <span>
              {params.error === "history"
                ? "Ative e sincronize o histórico MUSIC-01 antes de limpar uma fonte."
                : params.error === "stale"
                  ? "A playlist ou o histórico mudou depois do preview. Nenhum plano antigo foi executado; gere um novo preview."
                  : params.error === "automation"
                    ? "A rotina periódica só pode ser ligada depois de uma primeira limpeza manual concluída com sucesso."
                    : params.error === "empty"
                      ? "Este preview não possui nenhuma faixa removível. Nada foi executado e a rotina periódica permanece bloqueada."
                      : params.error === "execute"
                        ? "A limpeza não pôde ser concluída. O resultado parcial, se houver, ficou registrado para auditoria."
                        : "Não foi possível preparar o preview desta fonte agora."}
            </span>
          </div>
        )}

        {completedRun && (
          <section className="product-panel mt-5 p-5">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Último resultado confirmado</p>
            <h2 className="mt-2 text-xl font-black text-ink-inverse">
              {completedRun.source.name ?? "Playlist Spotify"} · {completedRun.status}
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Metric label="Examinados" value={completedRun.examinedCount} />
              <Metric label="Faixas planejadas" value={completedRun.removableTrackCount} />
              <Metric label="Ocorrências planejadas" value={completedRun.removalOccurrenceCount} />
            </div>
          </section>
        )}

        {preview && (
          <section className="product-panel mt-5 p-5 sm:p-6">
            <p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.15em] text-accent-400">
              <UiIcon name="play" size={15} />
              Preview · nenhuma alteração no Spotify
            </p>
            <h2 className="mt-2 text-2xl font-black text-ink-inverse">{preview.source.name ?? "Playlist Spotify"}</h2>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Itens atuais" value={preview.examinedCount} />
              <Metric label="Faixas removíveis" value={preview.removableTrackCount} />
              <Metric label="Ocorrências removíveis" value={preview.removalOccurrenceCount} />
              <Metric label="Permaneceriam" value={preview.keptCount} />
            </div>
            <p className="mt-4 break-all text-xs leading-5 text-muted-inverse/60">
              Snapshot protegido: {preview.snapshotBefore} · plano {preview.planHash.slice(0, 16)}…
            </p>

            {preview.status === MusicSourceCleanupStatus.PREVIEW ? (
              preview.removableTrackCount > 0 && preview.removalOccurrenceCount > 0 ? (
                <div className="status-danger mt-5 rounded-2xl border p-4">
                  <p className="flex items-center gap-2 font-black">
                    <UiIcon name="trash" size={17} />
                    Confirmação destrutiva separada
                  </p>
                  <p className="mt-1 text-sm leading-6 opacity-75">
                    Ao confirmar, o Sonoriza sincroniza o histórico e lê a playlist novamente. Se snapshot ou plano mudarem, a exclusão é bloqueada e um novo preview será exigido.
                  </p>
                  <form action={executeCleanup} className="mt-4">
                    <input type="hidden" name="previewId" value={preview.id} />
                    <CleanupSubmitButton removableTrackCount={preview.removableTrackCount} />
                  </form>
                </div>
              ) : (
                <div className="status-success mt-5 rounded-2xl border p-4">
                  <p className="flex items-center gap-2 font-black">
                    <UiIcon name="check" size={17} />
                    Nada para remover neste preview
                  </p>
                  <p className="mt-1 text-sm leading-6 opacity-75">
                    Nenhuma faixa possui evidência de reprodução compatível com esta inbox. Não há confirmação destrutiva e a rotina periódica continua bloqueada.
                  </p>
                </div>
              )
            ) : (
              <p className="status-info mt-5 rounded-xl border p-3 text-sm">
                Este preview está em estado {preview.status} e não pode mais ser executado.
              </p>
            )}
          </section>
        )}

        <section className="mt-7 space-y-4">
          {sources.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line-dark bg-surface-subtle/55 p-6 text-center text-muted-inverse">
              Nenhuma playlist-fonte de música está configurada.
            </div>
          ) : (
            sources.map((source) => {
              const inbox = source.musicRetentionMode === MusicSourceRetentionMode.REMOVE_AFTER_PLAYED;
              const firstCleanupDone = Boolean(source.musicCleanupFirstCompletedAt);

              return (
                <article key={source.id} className="product-panel p-5 sm:p-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap gap-2">
                        <span className="product-badge px-2.5 py-1 text-[0.68rem] uppercase tracking-wide">Playlist de música</span>
                        <span className={`product-badge px-2.5 py-1 text-[0.68rem] uppercase tracking-wide ${inbox ? "border-accent/30 bg-accent/10 text-accent-400" : ""}`}>
                          {inbox ? "Inbox" : "Permanente"}
                        </span>
                      </div>
                      <h2 className="mt-3 text-xl font-black text-ink-inverse">{source.name ?? "Playlist Spotify"}</h2>
                      <p className="mt-1 text-sm text-muted-inverse">
                        {inbox
                          ? "Itens tocados podem sair somente após preview e confirmação."
                          : "Nenhum item desta fonte é removido pelo Sonoriza."}
                      </p>
                    </div>
                    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-bold ${source.enabled ? "status-success" : "product-badge"}`}>
                      <UiIcon name={source.enabled ? "check" : "warning"} size={14} />
                      {source.enabled ? "Fonte ativa" : "Fonte desativada"}
                    </span>
                  </div>

                  <form action={updateRetentionMode} className="mt-5 flex flex-col gap-3 sm:flex-row">
                    <input type="hidden" name="id" value={source.id} />
                    <select name="mode" defaultValue={source.musicRetentionMode} className={selectClass}>
                      <option value={MusicSourceRetentionMode.KEEP_ALL}>Manter todos os itens</option>
                      <option value={MusicSourceRetentionMode.REMOVE_AFTER_PLAYED}>Remover depois de tocar · inbox</option>
                    </select>
                    <button type="submit" className={neutralButtonClass}>
                      <UiIcon name="check" size={15} />
                      Salvar política
                    </button>
                  </form>

                  {inbox && (
                    <div className="mt-5 grid gap-4 md:grid-cols-2">
                      <div className="product-card p-4">
                        <p className="flex items-center gap-2 font-black text-ink-inverse">
                          <UiIcon name="play" size={17} />
                          Preview controlado
                        </p>
                        <p className="mt-1 text-xs leading-5 text-muted-inverse">
                          Sincroniza o histórico e calcula exatamente o que sairia. Não altera a playlist.
                        </p>
                        <form action={previewCleanup} className="mt-3">
                          <input type="hidden" name="id" value={source.id} />
                          <button
                            type="submit"
                            className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-xs font-black text-brand-900 transition hover:bg-accent-400"
                          >
                            <UiIcon name="play" size={15} />
                            Gerar preview
                          </button>
                        </form>
                      </div>

                      <div className="product-card p-4">
                        <p className="flex items-center gap-2 font-black text-ink-inverse">
                          <UiIcon name="repeat" size={17} />
                          Limpeza periódica
                        </p>
                        <p className="mt-1 text-xs leading-5 text-muted-inverse">
                          {firstCleanupDone
                            ? `Primeira limpeza concluída em ${formatDateTime(source.musicCleanupFirstCompletedAt)}.`
                            : "Bloqueada até uma primeira limpeza manual ser confirmada e concluída."}
                        </p>
                        <form action={updateAutomation} className="mt-3">
                          <input type="hidden" name="id" value={source.id} />
                          <input type="hidden" name="enabled" value={source.musicCleanupAutomationEnabled ? "false" : "true"} />
                          <button
                            type="submit"
                            disabled={!firstCleanupDone && !source.musicCleanupAutomationEnabled}
                            className={neutralButtonClass}
                          >
                            <UiIcon name="repeat" size={15} />
                            {source.musicCleanupAutomationEnabled ? "Desligar rotina periódica" : "Ligar rotina periódica"}
                          </button>
                        </form>
                        <p className="mt-2 text-[0.7rem] text-muted-inverse/55">
                          Última limpeza: {formatDateTime(source.musicCleanupLastRunAt)}
                        </p>
                      </div>
                    </div>
                  )}
                </article>
              );
            })
          )}
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="product-card p-3">
      <p className="text-[0.68rem] font-black uppercase tracking-wide text-brand-400">{label}</p>
      <p className="mt-1 text-2xl font-black text-ink-inverse">{value}</p>
    </div>
  );
}

function formatDateTime(value: Date | null): string {
  if (!value) return "ainda não disponível";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(value);
}
