import {
  MusicSourceCleanupStatus,
  MusicSourceRetentionMode,
  SourceKind,
  SpotifySourceType,
} from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createMusicSourceCleanupPreview,
  executeMusicSourceCleanupPreview,
  MusicSourceCleanupHistoryRequiredError,
  MusicSourceCleanupStaleError,
} from "@/services/spotify/source-cleanup";

import { CleanupSubmitButton } from "./cleanup-submit-button";

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

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0b021f] px-5 py-8 text-white sm:px-8 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_5%,rgba(126,34,206,0.3),transparent_31rem),radial-gradient(circle_at_90%_10%,rgba(255,107,0,0.12),transparent_25rem),linear-gradient(180deg,#12032f_0%,#0b021f_55%,#090119_100%)]" />

      <div className="relative mx-auto max-w-5xl">
        <Link
          href="/dashboard/configuracao"
          className="inline-flex items-center gap-2 text-sm font-bold text-violet-300 transition hover:text-white"
        >
          <span aria-hidden="true">←</span>
          Central de configuração
        </Link>

        <header className="mt-6 max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-orange-400">
            MUSIC-02
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">
            Limpeza de playlists-inbox
          </h1>
          <p className="mt-3 text-sm leading-6 text-violet-200/75 sm:text-base">
            Fontes normais permanecem intactas. Para uma fila de entrada, o Sonoriza pode remover somente músicas cuja reprodução já foi confirmada no histórico nativo.
          </p>
        </header>

        <section className="mt-7 rounded-2xl border border-violet-400/20 bg-violet-950/40 p-5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-black">Histórico usado como evidência</p>
              <p className="mt-1 text-violet-200/65">
                {musicPolicy?.enabled
                  ? `Ativo · conhecido desde ${formatDateTime(musicPolicy.historyKnownSince)}`
                  : "Inativo — a limpeza fica bloqueada até o histórico nativo estar ativo."}
              </p>
            </div>
            <span className="rounded-full border border-violet-300/20 bg-violet-500/10 px-3 py-1.5 text-xs font-black text-violet-100">
              Último sync: {formatDateTime(musicPolicy?.lastSyncAt ?? null)}
            </span>
          </div>
        </section>

        {params.saved && (
          <div className="mt-5 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-3 text-sm font-bold text-emerald-200">
            {params.saved === "retention" &&
              "Política da fonte salva. Nenhum item foi removido do Spotify."}
            {params.saved === "automation" &&
              "Preferência de limpeza periódica atualizada."}
            {params.saved === "cleaned" &&
              "Limpeza confirmada e concluída. O resultado foi registrado para auditoria."}
            {params.saved === "partial" &&
              "A limpeza terminou parcialmente. Revise o resultado antes de tentar novamente."}
          </div>
        )}

        {params.error && (
          <div className="mt-5 rounded-2xl border border-orange-400/25 bg-orange-400/10 px-4 py-3 text-sm font-bold text-orange-100">
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
          </div>
        )}

        {completedRun && (
          <section className="mt-5 rounded-[1.5rem] border border-violet-400/20 bg-violet-950/35 p-5">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">
              Último resultado confirmado
            </p>
            <h2 className="mt-2 text-xl font-black">
              {completedRun.source.name ?? "Playlist Spotify"} · {completedRun.status}
            </h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Metric label="Examinados" value={completedRun.examinedCount} />
              <Metric label="Faixas planejadas" value={completedRun.removableTrackCount} />
              <Metric
                label="Ocorrências planejadas"
                value={completedRun.removalOccurrenceCount}
              />
            </div>
          </section>
        )}

        {preview && (
          <section className="mt-5 rounded-[1.75rem] border border-orange-400/30 bg-[linear-gradient(145deg,rgba(75,24,112,0.95),rgba(35,8,64,0.96))] p-5 sm:p-6">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-orange-400">
              Preview · nenhuma alteração no Spotify
            </p>
            <h2 className="mt-2 text-2xl font-black">
              {preview.source.name ?? "Playlist Spotify"}
            </h2>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Itens atuais" value={preview.examinedCount} />
              <Metric label="Faixas removíveis" value={preview.removableTrackCount} />
              <Metric label="Ocorrências removíveis" value={preview.removalOccurrenceCount} />
              <Metric label="Permaneceriam" value={preview.keptCount} />
            </div>
            <p className="mt-4 break-all text-xs leading-5 text-violet-200/55">
              Snapshot protegido: {preview.snapshotBefore} · plano {preview.planHash.slice(0, 16)}…
            </p>

            {preview.status === MusicSourceCleanupStatus.PREVIEW ? (
              preview.removableTrackCount > 0 && preview.removalOccurrenceCount > 0 ? (
                <div className="mt-5 rounded-2xl border border-red-300/20 bg-red-400/10 p-4">
                  <p className="font-black text-red-100">Confirmação destrutiva separada</p>
                  <p className="mt-1 text-sm leading-6 text-red-100/70">
                    Ao confirmar, o Sonoriza sincroniza o histórico e lê a playlist novamente. Se snapshot ou plano mudarem, a exclusão é bloqueada e um novo preview será exigido.
                  </p>
                  <form action={executeCleanup} className="mt-4">
                    <input type="hidden" name="previewId" value={preview.id} />
                    <CleanupSubmitButton
                      removableTrackCount={preview.removableTrackCount}
                    />
                  </form>
                </div>
              ) : (
                <div className="mt-5 rounded-2xl border border-emerald-300/20 bg-emerald-400/10 p-4">
                  <p className="font-black text-emerald-100">Nada para remover neste preview</p>
                  <p className="mt-1 text-sm leading-6 text-emerald-100/70">
                    Nenhuma faixa possui evidência de reprodução compatível com esta inbox. Não há confirmação destrutiva e a rotina periódica continua bloqueada.
                  </p>
                </div>
              )
            ) : (
              <p className="mt-5 rounded-xl border border-violet-300/15 bg-black/15 p-3 text-sm text-violet-200/65">
                Este preview está em estado {preview.status} e não pode mais ser executado.
              </p>
            )}
          </section>
        )}

        <section className="mt-7 space-y-4">
          {sources.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-violet-400/25 bg-violet-950/30 p-6 text-center text-violet-200/65">
              Nenhuma playlist-fonte de música está configurada.
            </div>
          ) : (
            sources.map((source) => {
              const inbox =
                source.musicRetentionMode ===
                MusicSourceRetentionMode.REMOVE_AFTER_PLAYED;
              const firstCleanupDone = Boolean(source.musicCleanupFirstCompletedAt);

              return (
                <article
                  key={source.id}
                  className="rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.92),rgba(22,6,53,0.94))] p-5 sm:p-6"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap gap-2">
                        <span className="rounded-full border border-violet-300/20 bg-violet-500/10 px-2.5 py-1 text-[0.68rem] font-black uppercase tracking-wide text-violet-200">
                          Playlist de música
                        </span>
                        <span className={`rounded-full border px-2.5 py-1 text-[0.68rem] font-black uppercase tracking-wide ${inbox ? "border-orange-300/25 bg-orange-400/10 text-orange-200" : "border-emerald-300/20 bg-emerald-400/10 text-emerald-200"}`}>
                          {inbox ? "Inbox" : "Permanente"}
                        </span>
                      </div>
                      <h2 className="mt-3 text-xl font-black">{source.name ?? "Playlist Spotify"}</h2>
                      <p className="mt-1 text-sm text-violet-200/60">
                        {inbox
                          ? "Itens tocados podem sair somente após preview e confirmação."
                          : "Nenhum item desta fonte é removido pelo Sonoriza."}
                      </p>
                    </div>
                    <span className="rounded-full border border-violet-300/20 bg-black/15 px-3 py-1.5 text-xs font-bold text-violet-200/70">
                      {source.enabled ? "Fonte ativa" : "Fonte desativada"}
                    </span>
                  </div>

                  <form action={updateRetentionMode} className="mt-5 flex flex-col gap-3 sm:flex-row">
                    <input type="hidden" name="id" value={source.id} />
                    <select
                      name="mode"
                      defaultValue={source.musicRetentionMode}
                      className="min-w-0 flex-1 rounded-xl border border-violet-300/20 bg-[#160638] px-3 py-2.5 text-sm font-bold text-violet-50"
                    >
                      <option value={MusicSourceRetentionMode.KEEP_ALL}>
                        Manter todos os itens
                      </option>
                      <option value={MusicSourceRetentionMode.REMOVE_AFTER_PLAYED}>
                        Remover depois de tocar · inbox
                      </option>
                    </select>
                    <button
                      type="submit"
                      className="rounded-xl border border-violet-300/25 bg-violet-500/10 px-4 py-2.5 text-sm font-black text-violet-100 transition hover:bg-violet-500/20"
                    >
                      Salvar política
                    </button>
                  </form>

                  {inbox && (
                    <div className="mt-5 grid gap-4 md:grid-cols-2">
                      <div className="rounded-2xl border border-orange-300/15 bg-orange-400/5 p-4">
                        <p className="font-black text-orange-100">Preview controlado</p>
                        <p className="mt-1 text-xs leading-5 text-orange-100/65">
                          Sincroniza o histórico e calcula exatamente o que sairia. Não altera a playlist.
                        </p>
                        <form action={previewCleanup} className="mt-3">
                          <input type="hidden" name="id" value={source.id} />
                          <button
                            type="submit"
                            className="rounded-xl bg-gradient-to-r from-[#ff6b00] to-[#ff8a00] px-4 py-2.5 text-xs font-black text-white transition hover:brightness-110"
                          >
                            Gerar preview
                          </button>
                        </form>
                      </div>

                      <div className="rounded-2xl border border-violet-300/15 bg-black/15 p-4">
                        <p className="font-black text-violet-100">Limpeza periódica</p>
                        <p className="mt-1 text-xs leading-5 text-violet-200/60">
                          {firstCleanupDone
                            ? `Primeira limpeza concluída em ${formatDateTime(source.musicCleanupFirstCompletedAt)}.`
                            : "Bloqueada até uma primeira limpeza manual ser confirmada e concluída."}
                        </p>
                        <form action={updateAutomation} className="mt-3">
                          <input type="hidden" name="id" value={source.id} />
                          <input
                            type="hidden"
                            name="enabled"
                            value={source.musicCleanupAutomationEnabled ? "false" : "true"}
                          />
                          <button
                            type="submit"
                            disabled={!firstCleanupDone && !source.musicCleanupAutomationEnabled}
                            className="rounded-xl border border-violet-300/25 bg-violet-500/10 px-4 py-2.5 text-xs font-black text-violet-100 transition hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {source.musicCleanupAutomationEnabled
                              ? "Desligar rotina periódica"
                              : "Ligar rotina periódica"}
                          </button>
                        </form>
                        <p className="mt-2 text-[0.7rem] text-violet-200/45">
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
    <div className="rounded-xl border border-violet-300/15 bg-black/15 p-3">
      <p className="text-[0.68rem] font-black uppercase tracking-wide text-violet-300/70">
        {label}
      </p>
      <p className="mt-1 text-2xl font-black">{value}</p>
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
