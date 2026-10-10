import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_PODCAST_DURATION_BAND_LIMITS,
  parsePodcastDurationBandLimits,
} from "@/services/playlist-planner/podcast-duration-bands";
import {
  loadPodcastSavedEpisodesPolicy,
  savePodcastSavedEpisodesPolicy,
  type PodcastSavedEpisodesFrequencyScopeValue,
  type PodcastSavedEpisodesOrderValue,
  type PodcastSavedEpisodesRandomPolicyValue,
} from "@/services/spotify/podcast-saved-episodes-policy-store";
import { hydratePodcastShowPolicyHistory } from "@/services/spotify/podcast-show-policy-history";
import {
  loadPodcastShowPolicies,
  resetPodcastShowPolicyProgress,
  savePodcastShowPolicy,
  type PodcastEpisodeEligibilityValue,
  type PodcastExpiryPolicyValue,
  type PodcastRandomPolicyValue,
  type PodcastShowEpisodeScopeValue,
  type PodcastShowOrderValue,
  type PodcastShowPolicyStoredSnapshot,
} from "@/services/spotify/podcast-show-policy-store";

import {
  PodcastPolicyClient,
  type PodcastPolicyClientSavedSource,
  type PodcastPolicyClientShow,
} from "./podcast-policy-client";

const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-line-dark/70 bg-surface-elevated/70 px-4 py-2.5 text-sm font-black text-ink-inverse transition hover:border-brand-400/55";

async function saveGlobalDurationBands(formData: FormData) {
  "use server";
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const shortText = formData.get("shortMaxMinutes");
  const mediumText = formData.get("mediumMaxMinutes");
  if (
    typeof shortText !== "string" || !/^[0-9]{1,4}$/.test(shortText) ||
    typeof mediumText !== "string" || !/^[0-9]{1,4}$/.test(mediumText)
  ) {
    redirect("/dashboard/configuracao/fontes/podcasts?erro=duracao");
  }
  const limits = parsePodcastDurationBandLimits({
    shortMaxMinutes: Number(shortText),
    mediumMaxMinutes: Number(mediumText),
  });
  if (!limits) redirect("/dashboard/configuracao/fontes/podcasts?erro=duracao");

  await prisma.podcastDurationBandSettings.upsert({
    where: { userId: session.user.id },
    create: { userId: session.user.id, ...limits },
    update: limits,
  });
  revalidatePodcastConfiguration();
  revalidatePath("/dashboard/configuracao/destinos");
  redirect("/dashboard/configuracao/fontes/podcasts?salvo=duracao");
}

async function updateSavedEpisodesPolicy(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const sourcePlaylistId = requiredText(formData, "sourcePlaylistId");
  const episodeOrder = enumValue(
    formData,
    "episodeOrder",
    ["OLDEST_FIRST", "NEWEST_FIRST", "RANDOM"] as const,
  ) as PodcastSavedEpisodesOrderValue;
  const randomPolicy: PodcastSavedEpisodesRandomPolicyValue =
    episodeOrder === "RANDOM"
      ? (enumValue(
          formData,
          "randomPolicy",
          ["WITHOUT_REPLACEMENT", "WITH_REPLACEMENT"] as const,
        ) as PodcastSavedEpisodesRandomPolicyValue)
      : "WITHOUT_REPLACEMENT";
  const cadenceMode = enumValue(
    formData,
    "cadenceMode",
    ["UNLIMITED", "LIMITED"] as const,
  );
  const cadenceMaxEpisodes =
    cadenceMode === "LIMITED"
      ? requiredPositiveInt(formData, "cadenceMaxEpisodes")
      : null;
  const cadenceUnit = cadenceMode === "LIMITED" ? ("WEEK" as const) : null;
  const frequencyScope = enumValue(
    formData,
    "frequencyScope",
    ["PER_SHOW", "GLOBAL_POOL"] as const,
  ) as PodcastSavedEpisodesFrequencyScopeValue;

  const saved = await savePodcastSavedEpisodesPolicy(
    session.user.id,
    sourcePlaylistId,
    {
      enabled: formData.get("enabled") === "on",
      episodeOrder,
      randomPolicy,
      cadenceMaxEpisodes,
      cadenceUnit,
      frequencyScope,
    },
  );

  if (!saved) redirect("/dashboard/configuracao/fontes/podcasts?erro=fonte");
  revalidatePodcastConfiguration();
  redirect(
    `/dashboard/configuracao/fontes/podcasts?salvo=1&saved=${encodeURIComponent(sourcePlaylistId)}`,
  );
}

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
  const showEpisodeScope = enumValue(
    formData,
    "showEpisodeScope",
    ["ALL_EPISODES", "SAVED_ONLY"] as const,
  ) as PodcastShowEpisodeScopeValue;
  const maxReleaseAgeDays = optionalInt(formData, "maxReleaseAgeDays", 0, 36500);

  const randomPolicy: PodcastRandomPolicyValue =
    episodeOrder === "RANDOM"
      ? (enumValue(
          formData,
          "randomPolicy",
          ["WITHOUT_REPLACEMENT", "WITH_REPLACEMENT"] as const,
        ) as PodcastRandomPolicyValue)
      : "WITHOUT_REPLACEMENT";

  const expiryPolicy: PodcastExpiryPolicyValue =
    maxReleaseAgeDays !== null
      ? (enumValue(
          formData,
          "expiryPolicy",
          ["STRICT_EXPIRY", "ALLOW_IN_PROGRESS_TO_FINISH"] as const,
        ) as PodcastExpiryPolicyValue)
      : "STRICT_EXPIRY";

  const cadenceMode = enumValue(
    formData,
    "cadenceMode",
    ["UNLIMITED", "LIMITED"] as const,
  );
  const cadenceMaxEpisodes =
    cadenceMode === "LIMITED"
      ? requiredPositiveInt(formData, "cadenceMaxEpisodes")
      : null;
  const cadenceUnit =
    cadenceMode === "LIMITED"
      ? enumValue(formData, "cadenceUnit", ["DAY", "WEEK", "MONTH"] as const)
      : null;
  const priority = enumValue(
    formData,
    "priority",
    ["NORMAL", "PRIORITY"] as const,
  );

  const saved = await savePodcastShowPolicy(session.user.id, sourcePlaylistId, {
    episodeEligibility,
    episodeOrder,
    randomPolicy,
    showEpisodeScope,
    startEpisodeId:
      episodeOrder === "RANDOM"
        ? null
        : parseSpotifyEpisodeId(optionalText(formData, "startEpisode")),
    strictSequence:
      episodeOrder === "RANDOM" ? false : formData.get("strictSequence") === "on",
    maxReleaseAgeDays,
    expiryPolicy,
    maxEpisodesPerCycle: optionalInt(formData, "maxEpisodesPerCycle", 1, 100),
    cadenceMaxEpisodes,
    cadenceUnit,
    priority,
  });

  if (!saved) redirect("/dashboard/configuracao/fontes/podcasts?erro=fonte");
  revalidatePodcastConfiguration();
  redirect(
    `/dashboard/configuracao/fontes/podcasts?salvo=1&show=${encodeURIComponent(sourcePlaylistId)}`,
  );
}

async function resetShowProgress(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const sourcePlaylistId = requiredText(formData, "sourcePlaylistId");
  await resetPodcastShowPolicyProgress(session.user.id, sourcePlaylistId);
  revalidatePath("/dashboard/configuracao/fontes/podcasts");
  redirect(
    `/dashboard/configuracao/fontes/podcasts?reiniciado=1&show=${encodeURIComponent(sourcePlaylistId)}`,
  );
}

export default async function PodcastPoliciesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const params = (await searchParams) ?? {};
  const [sources, basePolicies] = await Promise.all([
    prisma.sourcePlaylist.findMany({
      where: {
        userId: session.user.id,
        kind: "PODCAST",
        spotifyType: { in: ["SHOW", "SAVED_EPISODES"] },
      },
      orderBy: [{ spotifyType: "desc" }, { enabled: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        spotifyId: true,
        spotifyType: true,
        enabled: true,
        includePlayed: true,
        episodeOrder: true,
        podcastShowPolicy: {
          select: { sourcePlaylistId: true },
        },
      },
    }),
    loadPodcastShowPolicies(session.user.id),
  ]);
  const durationBandSettings = await prisma.podcastDurationBandSettings.findUnique({
    where: { userId: session.user.id },
    select: { shortMaxMinutes: true, mediumMaxMinutes: true },
  });
  const globalDurationBands = durationBandSettings ?? DEFAULT_PODCAST_DURATION_BAND_LIMITS;
  const policies = await hydratePodcastShowPolicyHistory(
    session.user.id,
    basePolicies,
  );

  const savedSourcesRaw = sources.filter(
    (source) => source.spotifyType === "SAVED_EPISODES",
  );
  const savedPolicyRows = await Promise.all(
    savedSourcesRaw.map(async (source) => ({
      source,
      policy: await loadPodcastSavedEpisodesPolicy(session.user.id, source.id),
    })),
  );
  const savedSources: PodcastPolicyClientSavedSource[] = savedPolicyRows.map(
    ({ source, policy }) => ({
      id: source.id,
      name: source.name ?? "Seus episódios",
      enabled: source.enabled,
      configured: policy !== null,
      policy: policy ?? {
        sourcePlaylistId: source.id,
        enabled: false,
        episodeOrder: "RANDOM",
        randomPolicy: "WITH_REPLACEMENT",
        cadenceMaxEpisodes: null,
        cadenceUnit: null,
        frequencyScope: "PER_SHOW",
      },
    }),
  );

  const shows = sources.filter((source) => source.spotifyType === "SHOW");
  const clientShows: PodcastPolicyClientShow[] = shows.map((show) => {
    const storedPolicy = basePolicies.get(show.id);
    const policy =
      policies.get(show.id) ??
      defaultPolicy(show.id, show.includePlayed, show.episodeOrder);
    return {
      id: show.id,
      name: show.name ?? "Programa do Spotify",
      enabled: show.enabled,
      hasExplicitPolicy: show.podcastShowPolicy !== null,
      policy: {
        sourcePlaylistId: show.id,
        episodeEligibility: policy.episodeEligibility,
        episodeOrder: policy.episodeOrder,
        randomPolicy: policy.randomPolicy,
        showEpisodeScope: storedPolicy?.showEpisodeScope ?? "ALL_EPISODES",
        startEpisodeId: policy.startEpisodeId,
        strictSequence: policy.strictSequence,
        maxReleaseAgeDays: policy.maxReleaseAgeDays,
        expiryPolicy: policy.expiryPolicy,
        maxEpisodesPerCycle: policy.maxEpisodesPerCycle,
        publishedCount: policy.publishedEpisodeIds.length,
        cadenceMaxEpisodes: storedPolicy?.cadenceMaxEpisodes ?? null,
        cadenceUnit: storedPolicy?.cadenceUnit ?? null,
        priority: storedPolicy?.priority ?? "NORMAL",
      },
    };
  });

  const requestedShow = singleParam(params.show);
  const initialOpenId = clientShows.some((show) => show.id === requestedShow)
    ? requestedShow
    : null;
  const requestedSaved = singleParam(params.saved);
  const initialOpenSavedId = savedSources.some((source) => source.id === requestedSaved)
    ? requestedSaved
    : null;

  return (
    <main className="min-h-screen bg-canvas-dark px-5 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-6xl">
        {!initialOpenId && (
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-accent-400">
                PODCAST-05 · PODCAST-06 · PODCAST-07
              </p>
              <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse">
                Políticas de podcasts
              </h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-inverse">
                Seus episódios define o comportamento padrão. Configure um programa individual somente quando ele precisar de um override próprio.
              </p>
            </div>
            <Link href="/dashboard/configuracao/fontes" className={secondaryButtonClass}>
              Voltar para Fontes
            </Link>
          </div>
        )}

        {params.salvo === "duracao" && (
          <div className="status-success mt-5 rounded-2xl border p-4 text-sm font-bold">
            Limites globais de duração salvos. Caso algum destino use uma faixa específica,
            faça uma nova simulação antes de gerar playlists reais.
          </div>
        )}
        {params.erro === "duracao" && (
          <div className="status-warning mt-5 rounded-2xl border p-4 text-sm font-bold">
            Informe dois limites inteiros válidos: o curto deve ser maior que zero,
            o médio maior que o curto e no máximo 1440 minutos.
          </div>
        )}
        {params.salvo === "1" && (
          <div className="status-success mt-5 rounded-2xl border p-4 text-sm font-bold">
            Política salva. A configuração mudou; faça uma nova simulação antes da próxima geração real.
          </div>
        )}
        {params.reiniciado === "1" && (
          <div className="status-info mt-5 rounded-2xl border p-4 text-sm font-bold">
            Progresso da sequência/rodada reiniciado. O histórico real de escuta do Spotify não foi alterado.
          </div>
        )}
        {params.erro === "fonte" && (
          <div className="status-warning mt-5 rounded-2xl border p-4 text-sm font-bold">
            A fonte não pertence mais à sua configuração de podcasts.
          </div>
        )}

        <section className="product-panel mt-6 p-5 sm:p-6">
          <h2 className="text-lg font-black text-ink-inverse">PODCAST-08 · Faixas de duração</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-inverse">
            Defina os limites globais para classificar episódios pelo tempo restante.
            As opções Curto, Médio e Longo ficam disponíveis nos passos de podcast
            em Destinos. Esta configuração ainda não ativa a seleção por faixa na geração real.
          </p>
          <form action={saveGlobalDurationBands} className="mt-5 flex flex-wrap items-end gap-4">
            <label className="text-sm font-bold text-ink-inverse">
              Curto: até (minutos)
              <input type="number" name="shortMaxMinutes" min={1} max={1439}
                step={1} required defaultValue={globalDurationBands.shortMaxMinutes}
                className="mt-2 block w-36 rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2.5 text-sm text-ink-inverse" />
            </label>
            <label className="text-sm font-bold text-ink-inverse">
              Médio: até (minutos)
              <input type="number" name="mediumMaxMinutes" min={2} max={1440}
                step={1} required defaultValue={globalDurationBands.mediumMaxMinutes}
                className="mt-2 block w-36 rounded-xl border border-line-dark/70 bg-surface-dark px-3 py-2.5 text-sm text-ink-inverse" />
            </label>
            <button type="submit" className="rounded-xl bg-accent px-5 py-2.5 text-sm font-black text-brand-900">
              Salvar limites globais
            </button>
          </form>
          <p className="mt-3 text-xs leading-5 text-muted-inverse/65">
            Acima do limite médio é Longo. Qualquer duração mantém a seleção atual.
            <Link href="/dashboard/configuracao/destinos" className="ml-1 font-bold text-accent-400 underline">
              Configurar sequência dos destinos
            </Link>
          </p>
        </section>

        {savedSources.length === 0 && clientShows.length === 0 ? (
          <section className="product-panel mt-6 p-6 text-center">
            <p className="font-black text-ink-inverse">Nenhuma fonte de podcast configurada</p>
            <p className="mt-2 text-sm text-muted-inverse">
              Adicione Seus episódios ou um programa em Fontes para configurar as políticas.
            </p>
          </section>
        ) : (
          <PodcastPolicyClient
            savedSources={savedSources}
            shows={clientShows}
            initialOpenId={initialOpenId}
            initialOpenSavedId={initialOpenSavedId}
            updateSavedEpisodesPolicyAction={updateSavedEpisodesPolicy}
            updateShowPolicyAction={updateShowPolicy}
            resetShowProgressAction={resetShowProgress}
          />
        )}
      </div>
    </main>
  );
}

function defaultPolicy(
  sourcePlaylistId: string,
  includePlayed: boolean,
  episodeOrder: string,
) {
  const policy: PodcastShowPolicyStoredSnapshot & { publishedEpisodeIds: string[] } = {
    sourcePlaylistId,
    episodeEligibility: includePlayed ? "ALL" : "UNPLAYED_ONLY",
    episodeOrder: episodeOrder === "NEWEST_FIRST" ? "NEWEST_FIRST" : "OLDEST_FIRST",
    randomPolicy: "WITHOUT_REPLACEMENT",
    showEpisodeScope: "ALL_EPISODES",
    startEpisodeId: null,
    strictSequence: true,
    maxReleaseAgeDays: null,
    expiryPolicy: "STRICT_EXPIRY",
    maxEpisodesPerCycle: null,
    randomRound: 0,
    sequenceCursorEpisodeId: null,
    sequenceCompleted: false,
    randomConsumedEpisodeIds: [],
    cadenceMaxEpisodes: null,
    cadenceUnit: null,
    priority: "NORMAL",
    publishedEpisodeIds: [],
  };
  return policy;
}

function revalidatePodcastConfiguration() {
  revalidatePath("/dashboard/configuracao/fontes");
  revalidatePath("/dashboard/configuracao/fontes/podcasts");
  revalidatePath("/dashboard/configuracao/revisao");
}

function singleParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
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

function requiredPositiveInt(formData: FormData, key: string): number {
  const value = Number(requiredText(formData, key));
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
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
      if (episodeIndex >= 0 && parts[episodeIndex + 1]) {
        return parts[episodeIndex + 1]!;
      }
    }
  } catch {
    // A plain Spotify episode id is valid input as well.
  }
  return value.trim() || null;
}
