import {
  MusicIngestionCapabilityStatus,
  MusicIngestionInitialMode,
  MusicIngestionRuleType,
  MusicSourceRetentionMode,
  SourceKind,
  SpotifySourceType,
} from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { SpotifyClient, type SpotifyPlaylistSummary } from "@/services/spotify";
import {
  createMusicIngestionRule,
  deleteMusicIngestionRule,
  runManualMusicIngestion,
  setMusicIngestionRuleEnabled,
  syncMusicIngestionRule,
} from "@/services/spotify/music-ingestion";

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

  if (!targetSourcePlaylistId || !type) redirect("/dashboard/configuracao/alimentacao?error=Dados%20inválidos");

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
    const result = await syncMusicIngestionRule(session.user.id, id, {
      preview: true,
      allowInitialImport:
        !rule.enabled && rule.initialMode === MusicIngestionInitialMode.IMPORT_CURRENT,
    });
    revalidateConfiguration();
    redirect(
      `/dashboard/configuracao/alimentacao?preview=1&add=${result.addedCount}&dup=${result.duplicateCount}&cool=${result.cooldownCount}`,
    );
  } catch (error) {
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
    const result = await syncMusicIngestionRule(session.user.id, id);
    revalidateConfiguration();
    redirect(
      `/dashboard/configuracao/alimentacao?synced=1&add=${result.addedCount}&dup=${result.duplicateCount}&cool=${result.cooldownCount}`,
    );
  } catch (error) {
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
    const result = await syncMusicIngestionRule(session.user.id, id, {
      allowInitialImport: true,
    });
    revalidateConfiguration();
    redirect(`/dashboard/configuracao/alimentacao?imported=1&add=${result.addedCount}`);
  } catch (error) {
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
    const result = await runManualMusicIngestion(session.user.id, {
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
      include: { target: true },
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
    <main className="relative min-h-screen overflow-hidden bg-[#0b021f] px-5 py-8 text-white sm:px-8 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_5%,rgba(126,34,206,0.3),transparent_31rem),radial-gradient(circle_at_90%_10%,rgba(255,107,0,0.12),transparent_25rem),linear-gradient(180deg,#12032f_0%,#0b021f_55%,#090119_100%)]" />
      <div className="relative mx-auto max-w-5xl">
        <Link href="/dashboard/configuracao" className="inline-flex items-center gap-2 text-sm font-bold text-violet-300 transition hover:text-white">
          <span aria-hidden="true">←</span> Central de configuração
        </Link>

        <div className="mt-7 max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-orange-400">MUSIC-03</p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">Alimentação automática da inbox</h1>
          <p className="mt-3 text-sm leading-6 text-violet-200/75 sm:text-base">
            Centralize no Sonoriza como músicas chegam à Escutar: novidades de playlists legíveis, músicas curtidas, álbuns de músicas curtidas e inclusão manual.
          </p>
        </div>

        {params.error ? (
          <div className="mt-6 rounded-2xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-100">{params.error}</div>
        ) : null}
        {params.saved === "active" ? (
          <div className="mt-6 rounded-2xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-3 text-sm font-bold text-emerald-200">
            Regra ativada a partir de agora. O baseline foi registrado sem escrever no Spotify.
          </div>
        ) : null}
        {params.saved === "preview-required" ? (
          <div className="mt-6 rounded-2xl border border-orange-400/25 bg-orange-500/10 px-4 py-3 text-sm font-bold text-orange-100">
            Regra criada desativada. Gere o preview do conteúdo atual antes de confirmar a importação.
          </div>
        ) : null}
        {params.saved === "blocked" ? (
          <div className="mt-6 rounded-2xl border border-orange-400/25 bg-orange-500/10 px-4 py-3 text-sm font-bold text-orange-100">
            Regra registrada como não suportada pela API atual do Spotify. Nenhuma escrita foi feita.
          </div>
        ) : null}
        {params.preview === "1" || params.synced === "1" || params.manual ? (
          <div className="mt-6 rounded-2xl border border-violet-400/25 bg-violet-500/10 px-4 py-3 text-sm font-bold text-violet-100">
            Resultado: {params.add ?? "0"} para adicionar · {params.dup ?? "0"} duplicadas · {params.cool ?? "0"} em cooldown.
            {params.preview === "1" || params.manual === "preview" ? " Preview: nenhuma playlist foi alterada." : ""}
          </div>
        ) : null}
        {params.imported === "1" ? (
          <div className="mt-6 rounded-2xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-3 text-sm font-bold text-emerald-200">
            Importação inicial confirmada: {params.add ?? "0"} item(ns) adicionados e a regra foi ativada.
          </div>
        ) : null}

        <section className="mt-7 rounded-[1.75rem] border border-orange-400/20 bg-[linear-gradient(145deg,rgba(62,17,116,0.96),rgba(30,8,66,0.96))] p-6">
          <p className="text-xs font-black uppercase tracking-[0.15em] text-orange-400">Nova automação</p>
          <h2 className="mt-1 text-xl font-black">Escutar recebe músicas de…</h2>
          <p className="mt-2 text-sm leading-6 text-violet-200/70">
            “A partir de agora” nunca importa o acervo existente. “Importar conteúdo atual” cria a regra desativada e exige preview antes da primeira escrita.
          </p>

          {inboxes.length === 0 ? (
            <div className="mt-5 rounded-2xl border border-orange-400/25 bg-orange-500/10 p-4 text-sm text-orange-100">
              Primeiro adicione a playlist Escutar como fonte de música em CONFIG-02; ela será usada como playlist-inbox de destino.
            </div>
          ) : (
            <form action={createRule} className="mt-5 grid gap-4 md:grid-cols-2">
              <label className="text-sm font-bold text-violet-100">
                Inbox de destino
                <select name="targetSourcePlaylistId" defaultValue={defaultInbox?.id} className="mt-2 w-full rounded-xl border border-violet-300/20 bg-[#10042a] px-4 py-3 text-white">
                  {inboxes.map((inbox) => (
                    <option key={inbox.id} value={inbox.id}>
                      {inbox.name ?? inbox.spotifyId}{inbox.musicRetentionMode === MusicSourceRetentionMode.REMOVE_AFTER_PLAYED ? " · inbox MUSIC-02" : ""}
                    </option>
                  ))}
                </select>
              </label>

              <label className="text-sm font-bold text-violet-100">
                Regra
                <select name="type" defaultValue={MusicIngestionRuleType.SAVED_TRACK_ALBUM} className="mt-2 w-full rounded-xl border border-violet-300/20 bg-[#10042a] px-4 py-3 text-white">
                  <option value={MusicIngestionRuleType.SAVED_TRACK}>Música curtida → adicionar música</option>
                  <option value={MusicIngestionRuleType.SAVED_TRACK_ALBUM}>Música curtida → adicionar álbum inteiro</option>
                  <option value={MusicIngestionRuleType.PLAYLIST_COPY}>Playlist → copiar novidades</option>
                </select>
              </label>

              <label className="text-sm font-bold text-violet-100">
                Playlist de origem · apenas para “copiar novidades”
                <select name="sourceSpotifyId" defaultValue="" className="mt-2 w-full rounded-xl border border-violet-300/20 bg-[#10042a] px-4 py-3 text-white">
                  <option value="">— não se aplica —</option>
                  {spotifyPlaylists.map((playlist) => (
                    <option key={playlist.id} value={playlist.id}>{playlist.name}</option>
                  ))}
                </select>
              </label>

              <label className="text-sm font-bold text-violet-100">
                Primeira ativação
                <select name="initialMode" defaultValue={MusicIngestionInitialMode.FROM_NOW} className="mt-2 w-full rounded-xl border border-violet-300/20 bg-[#10042a] px-4 py-3 text-white">
                  <option value={MusicIngestionInitialMode.FROM_NOW}>A partir de agora · recomendado</option>
                  <option value={MusicIngestionInitialMode.IMPORT_CURRENT}>Importar conteúdo atual · exige preview</option>
                </select>
              </label>

              {spotifyError ? <p className="md:col-span-2 text-sm text-orange-200">Não foi possível listar playlists do Spotify agora. Músicas curtidas continuam configuráveis; tente novamente para PLAYLIST_COPY.</p> : null}

              <button type="submit" className="md:col-span-2 justify-self-start rounded-xl bg-orange-500 px-5 py-3 text-sm font-black text-white transition hover:bg-orange-400">Criar regra</button>
            </form>
          )}
        </section>

        <section className="mt-5 rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.94),rgba(22,6,53,0.96))] p-6">
          <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">Inclusão manual</p>
          <h2 className="mt-1 text-xl font-black">Adicionar à Escutar</h2>
          <p className="mt-2 text-sm leading-6 text-violet-200/70">Pesquise pelo texto informado ou cole uma URL/URI Spotify. Cooldown e duplicidade são validados antes de escrever.</p>
          {defaultInbox ? (
            <form action={manualAdd} className="mt-5 grid gap-4 md:grid-cols-[1fr_180px]">
              <input type="hidden" name="targetSourcePlaylistId" value={defaultInbox.id} />
              <label className="text-sm font-bold text-violet-100">Música, álbum, URL ou URI
                <input name="reference" required placeholder="Ex.: Daft Punk Random Access Memories" className="mt-2 w-full rounded-xl border border-violet-300/20 bg-[#10042a] px-4 py-3 text-white" />
              </label>
              <label className="text-sm font-bold text-violet-100">Buscar como
                <select name="preferredType" defaultValue="track" className="mt-2 w-full rounded-xl border border-violet-300/20 bg-[#10042a] px-4 py-3 text-white">
                  <option value="track">Música</option>
                  <option value="album">Álbum inteiro</option>
                </select>
              </label>
              <div className="md:col-span-2 flex flex-wrap gap-3">
                <button name="submitMode" value="preview" type="submit" className="rounded-xl border border-violet-300/25 bg-violet-500/10 px-4 py-2.5 text-sm font-black text-violet-100">Pré-visualizar</button>
                <button name="submitMode" value="add" type="submit" className="rounded-xl bg-orange-500 px-4 py-2.5 text-sm font-black text-white">Adicionar</button>
              </div>
            </form>
          ) : null}
        </section>

        <section className="mt-5 space-y-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">Regras</p>
            <h2 className="mt-1 text-xl font-black">Alimentação configurada</h2>
          </div>
          {rules.length === 0 ? <p className="rounded-2xl border border-violet-300/15 bg-black/15 p-4 text-sm text-violet-200/70">Nenhuma regra criada.</p> : null}
          {rules.map((rule) => {
            const blocked = rule.capabilityStatus === MusicIngestionCapabilityStatus.BLOCKED;
            const awaitingImport = !rule.enabled && rule.initialMode === MusicIngestionInitialMode.IMPORT_CURRENT && !rule.state;
            return (
              <article key={rule.id} className="rounded-[1.5rem] border border-violet-300/15 bg-[#13052f]/90 p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.13em] text-orange-400">{ruleLabel(rule.type)}</p>
                    <h3 className="mt-1 text-lg font-black">→ {rule.target.name ?? rule.target.spotifyId}</h3>
                    {rule.sourceName ? <p className="mt-1 text-sm text-violet-200/70">Origem: {rule.sourceName}</p> : null}
                  </div>
                  <span className={`rounded-full border px-3 py-1.5 text-xs font-black ${blocked ? "border-orange-400/30 bg-orange-500/10 text-orange-100" : rule.enabled ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-200" : "border-violet-300/20 bg-violet-500/10 text-violet-200"}`}>
                    {blocked ? "Não suportada" : rule.enabled ? "Ativa" : awaitingImport ? "Aguardando importação" : "Desativada"}
                  </span>
                </div>

                {blocked ? <p className="mt-4 rounded-xl border border-orange-400/25 bg-orange-500/10 p-3 text-sm leading-6 text-orange-100">{rule.capabilityMessage}</p> : null}
                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="text-violet-300/60">Última sincronização</dt><dd className="font-bold">{formatDate(rule.lastSyncAt)}</dd></div>
                  <div><dt className="text-violet-300/60">Estratégia inicial</dt><dd className="font-bold">{rule.initialMode === MusicIngestionInitialMode.FROM_NOW ? "A partir de agora" : "Importar conteúdo atual"}</dd></div>
                </dl>

                <div className="mt-5 flex flex-wrap gap-2">
                  {!blocked ? <form action={previewRule}><input type="hidden" name="id" value={rule.id} /><button className="rounded-xl border border-violet-300/20 px-3 py-2 text-xs font-black text-violet-100">Pré-visualizar</button></form> : null}
                  {rule.enabled && !blocked ? <form action={syncRule}><input type="hidden" name="id" value={rule.id} /><button className="rounded-xl border border-orange-300/25 bg-orange-500/10 px-3 py-2 text-xs font-black text-orange-100">Sincronizar agora</button></form> : null}
                  {awaitingImport && !blocked ? <form action={importCurrent}><input type="hidden" name="id" value={rule.id} /><button className="rounded-xl bg-orange-500 px-3 py-2 text-xs font-black text-white">Confirmar importação atual</button></form> : null}
                  {!awaitingImport && !blocked ? <form action={toggleRule}><input type="hidden" name="id" value={rule.id} /><input type="hidden" name="enabled" value={rule.enabled ? "false" : "true"} /><button className="rounded-xl border border-violet-300/20 px-3 py-2 text-xs font-black text-violet-100">{rule.enabled ? "Desativar" : "Ativar"}</button></form> : null}
                  <form action={removeRule}><input type="hidden" name="id" value={rule.id} /><button className="rounded-xl border border-red-300/20 px-3 py-2 text-xs font-black text-red-200">Excluir regra</button></form>
                </div>
              </article>
            );
          })}
        </section>

        <section className="mt-7 rounded-[1.75rem] border border-violet-400/20 bg-black/15 p-6">
          <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">Auditoria</p>
          <h2 className="mt-1 text-xl font-black">Últimas execuções</h2>
          <p className="mt-2 text-sm text-violet-200/70">As contagens registram por que uma entrada foi adicionada, ignorada por duplicidade ou bloqueada pelo MUSIC-01.</p>
          <div className="mt-4 space-y-3">
            {recentRuns.length === 0 ? <p className="text-sm text-violet-300/60">Nenhuma execução ainda.</p> : null}
            {recentRuns.map((run) => (
              <div key={run.id} className="grid gap-2 rounded-2xl border border-violet-300/10 bg-[#10042a]/70 p-4 text-sm sm:grid-cols-[1.4fr_1fr_2fr]">
                <div><span className="font-black">{run.rule ? ruleLabel(run.rule.type) : "Manual"}</span><div className="text-violet-300/60">{run.target.name ?? run.target.spotifyId}</div></div>
                <div><span className="font-black">{run.status}</span><div className="text-violet-300/60">{formatDate(run.startedAt)}</div></div>
                <div className="text-violet-200/75">{run.addedCount} adicionadas · {run.duplicateCount} duplicadas · {run.cooldownCount} cooldown · {run.unavailableCount} indisponíveis</div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
