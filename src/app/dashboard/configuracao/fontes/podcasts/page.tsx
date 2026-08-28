import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hydratePodcastShowPolicyHistory } from "@/services/spotify/podcast-show-policy-history";
import {
  loadPodcastShowPolicies,
  resetPodcastShowPolicyProgress,
  savePodcastShowPolicy,
  type PodcastEpisodeEligibilityValue,
  type PodcastExpiryPolicyValue,
  type PodcastRandomPolicyValue,
  type PodcastShowOrderValue,
  type PodcastShowPolicySnapshot,
} from "@/services/spotify/podcast-show-policy-store";

const selectClass =
  "w-full rounded-xl border border-line-dark bg-surface-dark px-3 py-2.5 text-sm font-bold text-ink-inverse outline-none transition focus:border-accent/70";
const inputClass =
  "w-full rounded-xl border border-line-dark bg-surface-dark px-3 py-2.5 text-sm font-bold text-ink-inverse outline-none transition focus:border-accent/70";
const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2.5 text-sm font-black text-brand-900 transition hover:bg-accent-400";
const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-line-dark/70 bg-surface-elevated/70 px-4 py-2.5 text-sm font-black text-ink-inverse transition hover:border-brand-400/55";

async function updateShowPolicy(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const sourcePlaylistId = requiredText(formData, "sourcePlaylistId");
  const episodeEligibility = enumValue(
    formData,
    "episodeEligibility",
    ["UNPLAYED_ONLY", "PLAYED_ONLY", "ALL"] as const,
  ) as PodcastEpisodeEligibilityValue;
  const episodeOrder = enumValue(
    formData,
    "episodeOrder",
    ["OLDEST_FIRST", "NEWEST_FIRST", "RANDOM"] as const,
  ) as PodcastShowOrderValue;
  const randomPolicy = enumValue(
    formData,
    "randomPolicy",
    ["WITHOUT_REPLACEMENT", "WITH_REPLACEMENT"] as const,
  ) as PodcastRandomPolicyValue;
  const expiryPolicy = enumValue(
    formData,
    "expiryPolicy",
    ["STRICT_EXPIRY", "ALLOW_IN_PROGRESS_TO_FINISH"] as const,
  ) as PodcastExpiryPolicyValue;

  const saved = await savePodcastShowPolicy(session.user.id, sourcePlaylistId, {
    episodeEligibility,
    episodeOrder,
    randomPolicy,
    startEpisodeId: episodeOrder === "RANDOM"
      ? null
      : parseSpotifyEpisodeId(optionalText(formData, "startEpisode")),
    strictSequence:
      episodeOrder === "RANDOM" ? false : formData.get("strictSequence") === "on",
    maxReleaseAgeDays: optionalInt(formData, "maxReleaseAgeDays", 0, 36500),
    expiryPolicy,
    maxEpisodesPerCycle: optionalInt(formData, "maxEpisodesPerCycle", 1, 100),
  });

  if (!saved) redirect("/dashboard/configuracao/fontes/podcasts?erro=fonte");
  revalidatePath("/dashboard/configuracao/fontes");
  revalidatePath("/dashboard/configuracao/fontes/podcasts");
  revalidatePath("/dashboard/configuracao/revisao");
  redirect("/dashboard/configuracao/fontes/podcasts?salvo=1");
}

async function resetShowProgress(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const sourcePlaylistId = requiredText(formData, "sourcePlaylistId");
  await resetPodcastShowPolicyProgress(session.user.id, sourcePlaylistId);
  revalidatePath("/dashboard/configuracao/fontes/podcasts");
  redirect("/dashboard/configuracao/fontes/podcasts?reiniciado=1");
}

export default async function PodcastPoliciesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const params = (await searchParams) ?? {};
  const [shows, basePolicies] = await Promise.all([
    prisma.sourcePlaylist.findMany({
      where: {
        userId: session.user.id,
        kind: "PODCAST",
        spotifyType: "SHOW",
      },
      orderBy: [{ enabled: "desc" }, { name: "asc" }],
      select: {
        id: true,
        spotifyId: true,
        name: true,
        enabled: true,
        includePlayed: true,
        episodeOrder: true,
      },
    }),
    loadPodcastShowPolicies(session.user.id),
  ]);
  const policies = await hydratePodcastShowPolicyHistory(
    session.user.id,
    basePolicies,
  );

  return (
    <main className="min-h-screen bg-canvas-dark px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
              PODCAST-05
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse">
              Políticas de podcasts
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-inverse">
              Defina como cada programa percorre o próprio catálogo. O episódio não precisa estar em “Seus episódios”; um SHOW configurado usa diretamente o catálogo do programa.
            </p>
          </div>
          <Link href="/dashboard/configuracao/fontes" className={secondaryButtonClass}>
            Voltar para Fontes
          </Link>
        </div>

        {params.salvo === "1" && (
          <div className="status-success mt-5 rounded-2xl border p-4 text-sm font-bold">
            Política salva. A alteração só será usada no próximo planejamento; nenhuma playlist foi gerada agora.
          </div>
        )}
        {params.reiniciado === "1" && (
          <div className="status-info mt-5 rounded-2xl border p-4 text-sm font-bold">
            Progresso da sequência/rodada reiniciado. O histórico real de escuta do Spotify não foi alterado.
          </div>
        )}
        {params.erro === "fonte" && (
          <div className="status-warning mt-5 rounded-2xl border p-4 text-sm font-bold">
            O programa não pertence mais à sua configuração de fontes.
          </div>
        )}

        {shows.length === 0 ? (
          <section className="product-panel mt-6 p-6 text-center">
            <p className="font-black text-ink-inverse">Nenhum programa individual configurado</p>
            <p className="mt-2 text-sm text-muted-inverse">
              Adicione um programa em Fontes para criar uma política própria de sequência, replay ou validade.
            </p>
          </section>
        ) : (
          <div className="mt-6 space-y-5">
            {shows.map((show) => {
              const policy =
                policies.get(show.id) ?? defaultPolicy(show.id, show.includePlayed, show.episodeOrder);
              const random = policy.episodeOrder === "RANDOM";
              const replayTraversal = policy.episodeEligibility !== "UNPLAYED_ONLY";

              return (
                <section key={show.id} className="product-panel p-5 sm:p-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="product-badge">Programa</span>
                        <span className={show.enabled ? "status-success rounded-full border px-2.5 py-1 text-xs font-black" : "product-badge"}>
                          {show.enabled ? "Ativo" : "Desativado"}
                        </span>
                      </div>
                      <h2 className="mt-2 truncate text-xl font-black text-ink-inverse">
                        {show.name ?? "Programa do Spotify"}
                      </h2>
                      <p className="mt-1 text-xs text-muted-inverse/65">
                        {random
                          ? `${policy.publishedEpisodeIds.length} seleção(ões) reais consideradas na memória do aleatório.`
                          : replayTraversal
                            ? `${policy.publishedEpisodeIds.length} seleção(ões) reais consideradas no cursor de replay.`
                            : "O progresso normal é guiado pelo estado de escuta observado no Spotify."}
                      </p>
                    </div>
                    <span className="product-badge">
                      Máx. {policy.maxEpisodesPerCycle ?? "destino"} / ciclo
                    </span>
                  </div>

                  <form action={updateShowPolicy} className="mt-5 grid gap-4 lg:grid-cols-2">
                    <input type="hidden" name="sourcePlaylistId" value={show.id} />

                    <Field label="Episódios" help="Define o universo elegível antes da ordem e da validade.">
                      <select name="episodeEligibility" defaultValue={policy.episodeEligibility} className={selectClass}>
                        <option value="UNPLAYED_ONLY">Somente não concluídos</option>
                        <option value="PLAYED_ONLY">Somente já escutados</option>
                        <option value="ALL">Escutados e não escutados</option>
                      </select>
                    </Field>

                    <Field label="Ordem" help="A ordem vale para o catálogo completo do programa.">
                      <select name="episodeOrder" defaultValue={policy.episodeOrder} className={selectClass}>
                        <option value="OLDEST_FIRST">Mais antigos primeiro</option>
                        <option value="NEWEST_FIRST">Mais recentes primeiro</option>
                        <option value="RANDOM">Aleatório</option>
                      </select>
                    </Field>

                    <Field label="Aleatório" help="Só é aplicada quando Ordem = Aleatório.">
                      <select name="randomPolicy" defaultValue={policy.randomPolicy} className={selectClass}>
                        <option value="WITHOUT_REPLACEMENT">Evitar repetição até percorrer todos</option>
                        <option value="WITH_REPLACEMENT">Permitir repetição</option>
                      </select>
                    </Field>

                    <Field label="Começar a partir de" help="Opcional. Cole o ID, URI spotify:episode:… ou link do episódio. Ignorado no aleatório.">
                      <input
                        name="startEpisode"
                        defaultValue={policy.startEpisodeId ?? ""}
                        placeholder="Automático"
                        className={inputClass}
                      />
                    </Field>

                    <Field label="Validade após lançamento" help="Deixe vazio para nunca expirar. Útil para notícias e conteúdo temporal.">
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          name="maxReleaseAgeDays"
                          min={0}
                          max={36500}
                          defaultValue={policy.maxReleaseAgeDays ?? ""}
                          placeholder="Sem limite"
                          className={inputClass}
                        />
                        <span className="shrink-0 text-xs font-bold text-muted-inverse">dias</span>
                      </div>
                    </Field>

                    <Field label="Quando vencer em andamento" help="Permitir concluir só vale quando o primeiro progresso foi observado dentro da janela.">
                      <select name="expiryPolicy" defaultValue={policy.expiryPolicy} className={selectClass}>
                        <option value="STRICT_EXPIRY">Expirar mesmo em andamento</option>
                        <option value="ALLOW_IN_PROGRESS_TO_FINISH">Deixar terminar se começou dentro da janela</option>
                      </select>
                    </Field>

                    <Field label="Máximo global por ciclo" help="Compartilhado entre todos os destinos gerados no mesmo ciclo. Vazio usa o limite do destino como teto.">
                      <input
                        type="number"
                        name="maxEpisodesPerCycle"
                        min={1}
                        max={100}
                        defaultValue={policy.maxEpisodesPerCycle ?? ""}
                        placeholder="Usar limite do destino"
                        className={inputClass}
                      />
                    </Field>

                    <div className="rounded-xl border border-line-dark/55 bg-surface-dark/45 p-4">
                      <label className="flex min-h-11 cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          name="strictSequence"
                          defaultChecked={policy.strictSequence}
                          className="mt-1 h-4 w-4"
                        />
                        <span>
                          <span className="block text-sm font-black text-ink-inverse">Sequência estrita</span>
                          <span className="mt-1 block text-xs leading-5 text-muted-inverse">
                            Em ordem crescente/decrescente, não oferece um episódio posterior para contornar o próximo episódio que não cabe no destino.
                          </span>
                        </span>
                      </label>
                    </div>

                    <div className="lg:col-span-2 flex flex-col gap-3 border-t border-line-dark/50 pt-4 sm:flex-row sm:items-center sm:justify-between">
                      <p className="max-w-2xl text-xs leading-5 text-muted-inverse">
                        Salvar uma mudança reinicia a memória de sequência/aleatório desse programa, mas não altera `COMPLETED`, progresso ou biblioteca no Spotify.
                      </p>
                      <button type="submit" className={buttonClass}>
                        <UiIcon name="check" size={16} />
                        Salvar política
                      </button>
                    </div>
                  </form>

                  <form action={resetShowProgress} className="mt-3 flex justify-end">
                    <input type="hidden" name="sourcePlaylistId" value={show.id} />
                    <button type="submit" className={secondaryButtonClass}>
                      <UiIcon name="repeat" size={16} />
                      Reiniciar sequência / rodada
                    </button>
                  </form>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block rounded-xl border border-line-dark/55 bg-surface-dark/45 p-4">
      <span className="block text-sm font-black text-ink-inverse">{label}</span>
      <span className="mb-3 mt-1 block text-xs leading-5 text-muted-inverse">{help}</span>
      {children}
    </label>
  );
}

function defaultPolicy(
  sourcePlaylistId: string,
  includePlayed: boolean,
  episodeOrder: string,
): PodcastShowPolicySnapshot & { publishedEpisodeIds: string[] } {
  return {
    sourcePlaylistId,
    episodeEligibility: includePlayed ? "ALL" : "UNPLAYED_ONLY",
    episodeOrder: episodeOrder === "NEWEST_FIRST" ? "NEWEST_FIRST" : "OLDEST_FIRST",
    randomPolicy: "WITHOUT_REPLACEMENT",
    startEpisodeId: null,
    strictSequence: true,
    maxReleaseAgeDays: null,
    expiryPolicy: "STRICT_EXPIRY",
    maxEpisodesPerCycle: null,
    sequenceCursorEpisodeId: null,
    sequenceCompleted: false,
    randomRound: 0,
    randomConsumedEpisodeIds: [],
    publishedEpisodeIds: [],
  };
}

function requiredText(formData: FormData, key: string): string {
  const value = String(formData.get(key) ?? "").trim();
  if (!value) throw new Error(`Campo obrigatório ausente: ${key}`);
  return value;
}

function optionalText(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value || null;
}

function enumValue<T extends readonly string[]>(
  formData: FormData,
  key: string,
  allowed: T,
): T[number] {
  const value = requiredText(formData, key);
  if (!allowed.includes(value as T[number])) {
    throw new Error(`Valor inválido para ${key}`);
  }
  return value as T[number];
}

function optionalInt(
  formData: FormData,
  key: string,
  min: number,
  max: number,
): number | null {
  const raw = optionalText(formData, key);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Valor inválido para ${key}`);
  }
  return value;
}

function parseSpotifyEpisodeId(value: string | null): string | null {
  if (!value) return null;
  const uri = /^spotify:episode:([^:]+)$/.exec(value);
  if (uri?.[1]) return uri[1];
  try {
    const url = new URL(value);
    if (url.hostname.endsWith("spotify.com")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const episodeIndex = parts.indexOf("episode");
      if (episodeIndex >= 0 && parts[episodeIndex + 1]) return parts[episodeIndex + 1]!;
    }
  } catch {
    // A plain Spotify episode id is valid input as well.
  }
  return value.trim() || null;
}
