import {
  MusicIngestionCapabilityStatus,
  MusicIngestionInitialMode,
  MusicIngestionRuleType,
  MusicIngestionRunStatus,
  MusicIngestionTrigger,
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
import { SpotifyClient, type SpotifyPlaylistSummary } from "@/services/spotify";
import {
  createMusicIngestionRule,
  deleteMusicIngestionRule,
  setMusicIngestionRuleEnabled,
} from "@/services/spotify/music-ingestion";
import {
  runManualMusicIngestionSerialized,
  syncMusicIngestionRuleSerialized,
} from "@/services/spotify/music-ingestion-serialized";

const fieldClass =
  "mt-2 w-full rounded-xl border border-line-dark/70 bg-surface-dark px-4 py-3 text-ink-inverse outline-none transition focus:border-accent-400/70 focus:ring-2 focus:ring-accent/15";
const neutralButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-xl border border-line-dark/70 bg-surface-elevated/55 px-3 py-2 text-xs font-black text-ink-inverse transition hover:border-brand-400/55 hover:bg-surface-elevated";

function revalidateConfiguration() {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/configuracao");
  revalidatePath("/dashboard/configuracao/alimentacao");
  revalidatePath("/dashboard/configuracao/revisao");
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 220);
}

function rethrowNextRedirect(error: unknown) {
  if (error && typeof error === "object" && "digest" in error) throw error;
}

async function createRule(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const targetSourcePlaylistId = String(formData.get("targetSourcePlaylistId") ?? "").trim();
  const sourceSpotifyId = String(formData.get("sourceSpotifyId") ?? "").trim() || null;
  const typeRaw = String(formData.get("type") ?? "");
  const initialModeRaw = String(formData.get("initialMode") ?? "");
  const type =
    typeRaw === MusicIngestionRuleType.PLAYLIST_COPY
      ? MusicIngestionRuleType.PLAYLIST_COPY
      : typeRaw === MusicIngestionRuleType.SAVED_TRACK
        ? MusicIngestionRuleType.SAVED_TRACK
        : typeRaw === MusicIngestionRuleType.SAVED_TRACK_ALBUM
          ? MusicIngestionRuleType.SAVED_TRACK_ALBUM
          : null;
  const initialMode =
    initialModeRaw === MusicIngestionInitialMode.IMPORT_CURRENT
      ? MusicIngestionInitialMode.IMPORT_CURRENT
      : MusicIngestionInitialMode.FROM_NOW;

  if (!targetSourcePlaylistId || !type) {
    redirect("/dashboard/configuracao/alimentacao?error=Dados%20inválidos");
  }

  try {
    const rule = await createMusicIngestionRule(session.user.id, {
      targetSourcePlaylistId,
      type,
      sourceSpotifyId,
      initialMode,
    });
    revalidateConfiguration();
    const status =
      rule.capabilityStatus === MusicIngestionCapabilityStatus.BLOCKED
        ? "blocked"
        : initialMode === MusicIngestionInitialMode.IMPORT_CURRENT
          ? "preview-required"
          : "active";
    redirect(`/dashboard/configuracao/alimentacao?saved=${status}`);
  } catch (error) {
    rethrowNextRedirect(error);
    redirect(`/dashboard/configuracao/alimentacao?error=${encodeURIComponent(safeError(error))}`);
  }
}

async function previewRule(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const id = String(formData.get("id") ?? "").trim();
  if (!id) redirect("/dashboard/configuracao/alimentacao?error=Regra%20inválida");

  try {
    const rule = await prisma.musicIngestionRule.findFirst({
      where: { id, userId: session.user.id },
      select: { initialMode: true, enabled: true },
    });
    if (!rule) throw new Error("Regra de alimentação não encontrada.");
    const result = await syncMusicIngestionRuleSerialized(session.user.id, id, {
      preview: true,
      allowInitialImport:
        !rule.enabled && rule.initialMode === MusicIngestionInitialMode.IMPORT_CURRENT,
    });
    revalidateConfiguration();
    redirect(
      `/dashboard/configuracao/alimentacao?preview=1&add=${result.addedCount}&dup=${result.duplicateCount}&cool=${result.cooldownCount}`,
    );
  } catch (error) {
    rethrowNextRedirect(error);
    redirect(`/dashboard/configuracao/alimentacao?error=${encodeURIComponent(safeError(error))}`);
  }
}

async function syncRule(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const id = String(formData.get("id") ?? "").trim();
  if (!id) redirect("/dashboard/configuracao/alimentacao?error=Regra%20inválida");

  try {
    const result = await syncMusicIngestionRuleSerialized(session.user.id, id);
    revalidateConfiguration();
    redirect(
      `/dashboard/configuracao/alimentacao?synced=1&add=${result.addedCount}&dup=${result.duplicateCount}&cool=${result.cooldownCount}`,
    );
  } catch (error) {
    rethrowNextRedirect(error);
    redirect(`/dashboard/configuracao/alimentacao?error=${encodeURIComponent(safeError(error))}`);
  }
}

async function importCurrent(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const id = String(formData.get("id") ?? "").trim();
  if (!id) redirect("/dashboard/configuracao/alimentacao?error=Regra%20inválida");

  try {
    const result = await syncMusicIngestionRuleSerialized(session.user.id, id, {
      allowInitialImport: true,
    });
    revalidateConfiguration();
    redirect(`/dashboard/configuracao/alimentacao?imported=1&add=${result.addedCount}`);
  } catch (error) {
    rethrowNextRedirect(error);
    redirect(`/dashboard/configuracao/alimentacao?error=${encodeURIComponent(safeError(error))}`);
  }
}

async function toggleRule(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const id = String(formData.get("id") ?? "").trim();
  const enabled = String(formData.get("enabled") ?? "") === "true";
  try {
    await setMusicIngestionRuleEnabled(session.user.id, id, enabled);
    revalidateConfiguration();
    redirect("/dashboard/configuracao/alimentacao?saved=updated");
  } catch (error) {
    rethrowNextRedirect(error);
    redirect(`/dashboard/configuracao/alimentacao?error=${encodeURIComponent(safeError(error))}`);
  }
}

async function removeRule(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const id = String(formData.get("id") ?? "").trim();
  try {
    await deleteMusicIngestionRule(session.user.id, id);
    revalidateConfiguration();
    redirect("/dashboard/configuracao/alimentacao?saved=removed");
  } catch (error) {
    rethrowNextRedirect(error);
    redirect(`/dashboard/configuracao/alimentacao?error=${encodeURIComponent(safeError(error))}`);
  }
}

async function manualAdd(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const targetSourcePlaylistId = String(formData.get("targetSourcePlaylistId") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim();
  const preferredType = String(formData.get("preferredType") ?? "") === "album" ? "album" : "track";
  const preview = String(formData.get("submitMode") ?? "") === "preview";

  try {
    const result = await runManualMusicIngestionSerialized(session.user.id, {
      targetSourcePlaylistId,
      reference,
      preferredType,
      preview,
    });
    revalidateConfiguration();
    redirect(
      `/dashboard/configuracao/alimentacao?manual=${preview ? "preview" : "added"}&add=${result.addedCount}&dup=${result.duplicateCount}&cool=${result.cooldownCount}`,
    );
  } catch (error) {
    rethrowNextRedirect(error);
    redirect(`/dashboard/configuracao/alimentacao?error=${encodeURIComponent(safeError(error))}`);
  }
}

function formatDate(value: Date | null): string {
  if (!value) return "Nunca";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(value);
}

function ruleLabel(type: MusicIngestionRuleType): string {
  if (type === MusicIngestionRuleType.PLAYLIST_COPY) return "Playlist → copiar novidades";
  if (type === MusicIngestionRuleType.SAVED_TRACK_ALBUM) return "Curtida → álbum inteiro";
  return "Curtida → música";
}

export default async function MusicIngestionConfigurationPage({
  searchParams,
}: {
  searchParams: Promise<{
    saved?: string;
    error?: string;
    preview?: string;
    synced?: string;
    imported?: string;
    manual?: string;
    add?: string;
    dup?: string;
    cool?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const params = await searchParams;

  const [inboxes, rules, recentRuns] = await Promise.all([
    prisma.sourcePlaylist.findMany({
      where: {
        userId: session.user.id,
        kind: SourceKind.MUSIC,
        spotifyType: SpotifySourceType.PLAYLIST,
      },
      orderBy: [{ name: "asc" }, { spotifyId: "asc" }],
    }),
    prisma.musicIngestionRule.findMany({
      where: { userId: session.user.id },
      include: {
        target: true,
        runs: {
          where: {
            preview: true,
            status: MusicIngestionRunStatus.PREVIEW,
            trigger: MusicIngestionTrigger.INITIAL_IMPORT,
          },
          select: { id: true },
          orderBy: { startedAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.musicIngestionRun.findMany({
      where: { userId: session.user.id },
      include: { target: true, rule: true },
      orderBy: { startedAt: "desc" },
      take: 12,
    }),
  ]);

  let spotifyPlaylists: SpotifyPlaylistSummary[] = [];
  let spotifyError = false;
  try {
    spotifyPlaylists = await (await SpotifyClient.forUser(session.user.id)).listCurrentUserPlaylists();
  } catch {
    spotifyError = true;
  }

  const defaultInbox =
    inboxes.find((item) => item.musicRetentionMode === MusicSourceRetentionMode.REMOVE_AFTER_PLAYED) ??
    inboxes[0] ??
    null;

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

        <div className="mt-7 max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-accent-400">MUSIC-03</p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
            Alimentação automática da inbox
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-inverse sm:text-base">
            Centralize no Sonoriza como músicas chegam à Escutar: novidades de playlists legíveis, músicas curtidas, álbuns de músicas curtidas e inclusão manual.
          </p>
        </div>

        {params.error ? (
          <div className="status-danger mt-6 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="warning" size={17} className="mt-0.5 shrink-0" />
            <span>{params.error}</span>
          </div>
        ) : null}
        {params.saved === "active" ? (
          <div className="status-success mt-6 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="check" size={17} className="mt-0.5 shrink-0" />
            Regra ativada a partir de agora. O baseline foi registrado sem escrever no Spotify.
          </div>
        ) : null}
        {params.saved === "preview-required" ? (
          <div className="status-warning mt-6 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="warning" size={17} className="mt-0.5 shrink-0" />
            Regra criada desativada. Gere o preview do conteúdo atual antes de confirmar a importação.
          </div>
        ) : null}
        {params.saved === "blocked" ? (
          <div className="status-warning mt-6 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="warning" size={17} className="mt-0.5 shrink-0" />
            Regra registrada como não suportada pela API atual do Spotify. Nenhuma escrita foi feita.
          </div>
        ) : null}
        {params.preview === "1" || params.synced === "1" || params.manual ? (
          <div className="status-info mt-6 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="history" size={17} className="mt-0.5 shrink-0" />
            <span>
              Resultado: {params.add ?? "0"} para adicionar · {params.dup ?? "0"} duplicadas · {params.cool ?? "0"} em cooldown.
              {params.preview === "1" || params.manual === "preview" ? " Preview: nenhuma playlist foi alterada." : ""}
            </span>
          </div>
        ) : null}
        {params.imported === "1" ? (
          <div className="status-success mt-6 flex items-start gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="check" size={17} className="mt-0.5 shrink-0" />
            Importação inicial confirmada: {params.add ?? "0"} item(ns) adicionados e a regra foi ativada.
          </div>
        ) : null}

        <section className="product-panel mt-7 p-6">
          <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">Nova automação</p>
          <h2 className="mt-1 text-xl font-black text-ink-inverse">Escutar recebe músicas de…</h2>
          <p className="mt-2 text-sm leading-6 text-muted-inverse">
            “A partir de agora” nunca importa o acervo existente. “Importar conteúdo atual” cria a regra desativada e exige preview antes da primeira escrita.
          </p>

          {inboxes.length === 0 ? (
            <div className="status-warning mt-5 flex items-start gap-2 rounded-2xl border p-4 text-sm">
              <UiIcon name="warning" size={17} className="mt-0.5 shrink-0" />
              <span>
                Primeiro adicione a playlist Escutar como fonte de música em CONFIG-02; ela será usada como playlist-inbox de destino.
              </span>
            </div>
          ) : (
            <form action={createRule} className="mt-5 grid gap-4 md:grid-cols-2">
              <label className="text-sm font-bold text-ink-inverse">
                Inbox de destino
                <select name="targetSourcePlaylistId" defaultValue={defaultInbox?.id} className={fieldClass}>
                  {inboxes.map((inbox) => (
                    <option key={inbox.id} value={inbox.id}>
                      {inbox.name ?? inbox.spotifyId}{inbox.musicRetentionMode === MusicSourceRetentionMode.REMOVE_AFTER_PLAYED ? " · inbox MUSIC-02" : ""}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-sm font-bold text-ink-inverse">
                Regra
                <select name="type" defaultValue={MusicIngestionRuleType.SAVED_TRACK_ALBUM} className={fieldClass}>
                  <option value={MusicIngestionRuleType.SAVED_TRACK}>Música curtida → adicionar música</option>
                  <option value={MusicIngestionRuleType.SAVED_TRACK_ALBUM}>Música curtida → adicionar álbum inteiro</option>
                  <option value={MusicIngestionRuleType.PLAYLIST_COPY}>Playlist → copiar novidades</option>
                </select>
              </label>

              <label className="text-sm font-bold text-ink-inverse">
                Playlist de origem · apenas para “copiar novidades”
                <select name="sourceSpotifyId" defaultValue="" className={fieldClass}>
                  <option value="">— não se aplica —</option>
                  {spotifyPlaylists.map((playlist) => (
                    <option key={playlist.id} value={playlist.id}>{playlist.name}</option>
                  ))}
                </select>
              </label>

              <label className="text-sm font-bold text-ink-inverse">
                Primeira ativação
                <select name="initialMode" defaultValue={MusicIngestionInitialMode.FROM_NOW} className={fieldClass}>
                  <option value={MusicIngestionInitialMode.FROM_NOW}>A partir de agora · recomendado</option>
                  <option value={MusicIngestionInitialMode.IMPORT_CURRENT}>Importar conteúdo atual · exige preview</option>
                </select>
              </label>

              {spotifyError ? (
                <p className="status-warning md:col-span-2 flex items-start gap-2 rounded-xl border p-3 text-sm">
                  <UiIcon name="warning" size={16} className="mt-0.5 shrink-0" />
                  <span>Não foi possível listar playlists do Spotify agora. Músicas curtidas continuam configuráveis; tente novamente para PLAYLIST_COPY.</span>
                </p>
              ) : null}

              <button
                type="submit"
                className="md:col-span-2 inline-flex justify-self-start items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 shadow-action transition hover:bg-accent-400"
              >
                <UiIcon name="plus" size={17} />
                Criar regra
              </button>
            </form>
          )}
        </section>

        <section className="product-panel mt-5 p-6">
          <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Inclusão manual</p>
          <h2 className="mt-1 text-xl font-black text-ink-inverse">Adicionar à Escutar</h2>
          <p className="mt-2 text-sm leading-6 text-muted-inverse">
            Pesquise pelo texto informado ou cole uma URL/URI Spotify. Cooldown e duplicidade são validados antes de escrever.
          </p>
          {defaultInbox ? (
            <form action={manualAdd} className="mt-5 grid gap-4 md:grid-cols-[1fr_180px]">
              <input type="hidden" name="targetSourcePlaylistId" value={defaultInbox.id} />
              <label className="text-sm font-bold text-ink-inverse">
                Música, álbum, URL ou URI
                <input name="reference" required placeholder="Ex.: Daft Punk Random Access Memories" className={fieldClass} />
              </label>
              <label className="text-sm font-bold text-ink-inverse">
                Buscar como
                <select name="preferredType" defaultValue="track" className={fieldClass}>
                  <option value="track">Música</option>
                  <option value="album">Álbum inteiro</option>
                </select>
              </label>
              <div className="md:col-span-2 flex flex-wrap gap-3">
                <button name="submitMode" value="preview" type="submit" className={neutralButtonClass}>
                  <UiIcon name="play" size={15} />
                  Pré-visualizar
                </button>
                <button
                  name="submitMode"
                  value="add"
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2.5 text-sm font-black text-brand-900 transition hover:bg-accent-400"
                >
                  <UiIcon name="plus" size={16} />
                  Adicionar
                </button>
              </div>
            </form>
          ) : null}
        </section>

        <section className="mt-5 space-y-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Regras</p>
            <h2 className="mt-1 text-xl font-black text-ink-inverse">Alimentação configurada</h2>
          </div>
          {rules.length === 0 ? (
            <p className="product-card p-4 text-sm text-muted-inverse">Nenhuma regra criada.</p>
          ) : null}
          {rules.map((rule) => {
            const blocked = rule.capabilityStatus === MusicIngestionCapabilityStatus.BLOCKED;
            const awaitingImport = !rule.enabled && rule.initialMode === MusicIngestionInitialMode.IMPORT_CURRENT && !rule.state;
            const hasInitialImportPreview = rule.runs.length > 0;
            return (
              <article key={rule.id} className="product-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.13em] text-accent-400">{ruleLabel(rule.type)}</p>
                    <h3 className="mt-1 flex items-center gap-2 text-lg font-black text-ink-inverse">
                      <UiIcon name="arrow-right" size={17} />
                      {rule.target.name ?? rule.target.spotifyId}
                    </h3>
                    {rule.sourceName ? <p className="mt-1 text-sm text-muted-inverse">Origem: {rule.sourceName}</p> : null}
                  </div>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-black ${
                      blocked
                        ? "status-warning"
                        : rule.enabled
                          ? "status-success"
                          : awaitingImport
                            ? "status-warning"
                            : "product-badge"
                    }`}
                  >
                    <UiIcon name={rule.enabled && !blocked ? "check" : "warning"} size={14} />
                    {blocked ? "Não suportada" : rule.enabled ? "Ativa" : awaitingImport ? "Aguardando importação" : "Desativada"}
                  </span>
                </div>

                {blocked ? (
                  <p className="status-warning mt-4 flex items-start gap-2 rounded-xl border p-3 text-sm leading-6">
                    <UiIcon name="warning" size={16} className="mt-1 shrink-0" />
                    <span>{rule.capabilityMessage}</span>
                  </p>
                ) : null}
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-inverse/65">Última sincronização</dt>
                    <dd className="font-bold text-ink-inverse">{formatDate(rule.lastSyncAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-inverse/65">Estratégia inicial</dt>
                    <dd className="font-bold text-ink-inverse">
                      {rule.initialMode === MusicIngestionInitialMode.FROM_NOW ? "A partir de agora" : "Importar conteúdo atual"}
                    </dd>
                  </div>
                </dl>

                {awaitingImport && !blocked && !hasInitialImportPreview ? (
                  <p className="status-warning mt-4 flex items-start gap-2 rounded-xl border p-3 text-xs font-bold leading-5">
                    <UiIcon name="warning" size={15} className="mt-0.5 shrink-0" />
                    <span>Faça o preview primeiro. A confirmação da importação só é liberada depois que um preview inicial for registrado.</span>
                  </p>
                ) : null}

                <div className="mt-5 flex flex-wrap gap-2">
                  {!blocked ? (
                    <form action={previewRule}>
                      <input type="hidden" name="id" value={rule.id} />
                      <button className={neutralButtonClass}>
                        <UiIcon name="play" size={15} />
                        Pré-visualizar
                      </button>
                    </form>
                  ) : null}
                  {rule.enabled && !blocked ? (
                    <form action={syncRule}>
                      <input type="hidden" name="id" value={rule.id} />
                      <button className={neutralButtonClass}>
                        <UiIcon name="repeat" size={15} />
                        Sincronizar agora
                      </button>
                    </form>
                  ) : null}
                  {awaitingImport && !blocked && hasInitialImportPreview ? (
                    <form action={importCurrent}>
                      <input type="hidden" name="id" value={rule.id} />
                      <button className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-xs font-black text-brand-900 transition hover:bg-accent-400">
                        <UiIcon name="check" size={15} />
                        Confirmar importação atual
                      </button>
                    </form>
                  ) : null}
                  {!awaitingImport && !blocked ? (
                    <form action={toggleRule}>
                      <input type="hidden" name="id" value={rule.id} />
                      <input type="hidden" name="enabled" value={rule.enabled ? "false" : "true"} />
                      <button className={neutralButtonClass}>
                        <UiIcon name={rule.enabled ? "warning" : "check"} size={15} />
                        {rule.enabled ? "Desativar" : "Ativar"}
                      </button>
                    </form>
                  ) : null}
                  <form action={removeRule}>
                    <input type="hidden" name="id" value={rule.id} />
                    <button className="inline-flex items-center gap-1.5 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-black text-danger transition hover:bg-danger/15">
                      <UiIcon name="trash" size={15} />
                      Excluir regra
                    </button>
                  </form>
                </div>
              </article>
            );
          })}
        </section>

        <section className="product-panel mt-7 p-6">
          <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Auditoria</p>
          <h2 className="mt-1 text-xl font-black text-ink-inverse">Últimas execuções</h2>
          <p className="mt-2 text-sm text-muted-inverse">
            As contagens registram por que uma entrada foi adicionada, ignorada por duplicidade ou bloqueada pelo MUSIC-01.
          </p>
          <div className="mt-4 space-y-3">
            {recentRuns.length === 0 ? <p className="text-sm text-muted-inverse/65">Nenhuma execução ainda.</p> : null}
            {recentRuns.map((run) => (
              <div key={run.id} className="product-card grid gap-2 p-4 text-sm sm:grid-cols-[1.4fr_1fr_2fr]">
                <div>
                  <span className="font-black text-ink-inverse">{run.rule ? ruleLabel(run.rule.type) : "Manual"}</span>
                  <div className="text-muted-inverse/65">{run.target.name ?? run.target.spotifyId}</div>
                </div>
                <div>
                  <span className="font-black text-ink-inverse">{run.status}</span>
                  <div className="text-muted-inverse/65">{formatDate(run.startedAt)}</div>
                </div>
                <div className="text-muted-inverse">
                  {run.addedCount} adicionadas · {run.duplicateCount} duplicadas · {run.cooldownCount} cooldown · {run.unavailableCount} indisponíveis
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
