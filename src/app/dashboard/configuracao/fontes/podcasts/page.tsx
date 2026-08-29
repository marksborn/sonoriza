import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

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

import {
  PodcastPolicyClient,
  type PodcastPolicyClientShow,
} from "./podcast-policy-client";

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

  const saved = await savePodcastShowPolicy(session.user.id, sourcePlaylistId, {
    episodeEligibility,
    episodeOrder,
    randomPolicy,
    startEpisodeId:
      episodeOrder === "RANDOM"
        ? null
        : parseSpotifyEpisodeId(optionalText(formData, "startEpisode")),
    strictSequence:
      episodeOrder === "RANDOM" ? false : formData.get("strictSequence") === "on",
    maxReleaseAgeDays,
    expiryPolicy,
    maxEpisodesPerCycle: optionalInt(formData, "maxEpisodesPerCycle", 1, 100),
  });

  if (!saved) redirect("/dashboard/configuracao/fontes/podcasts?erro=fonte");
  revalidatePath("/dashboard/configuracao/fontes");
  revalidatePath("/dashboard/configuracao/fontes/podcasts");
  revalidatePath("/dashboard/configuracao/revisao");
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

  const clientShows: PodcastPolicyClientShow[] = shows.map((show) => {
    const policy =
      policies.get(show.id) ??
      defaultPolicy(show.id, show.includePlayed, show.episodeOrder);
    return {
      id: show.id,
      name: show.name ?? "Programa do Spotify",
      enabled: show.enabled,
      policy: {
        sourcePlaylistId: show.id,
        episodeEligibility: policy.episodeEligibility,
        episodeOrder: policy.episodeOrder,
        randomPolicy: policy.randomPolicy,
        startEpisodeId: policy.startEpisodeId,
        strictSequence: policy.strictSequence,
        maxReleaseAgeDays: policy.maxReleaseAgeDays,
        expiryPolicy: policy.expiryPolicy,
        maxEpisodesPerCycle: policy.maxEpisodesPerCycle,
        publishedCount: policy.publishedEpisodeIds.length,
      },
    };
  });

  const requestedShow = singleParam(params.show);
  const initialOpenId = clientShows.some((show) => show.id === requestedShow)
    ? requestedShow
    : null;

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
              Um único lugar para configurar cada programa. A lista fica compacta e somente o show que você estiver editando abre o formulário completo.
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

        {clientShows.length === 0 ? (
          <section className="product-panel mt-6 p-6 text-center">
            <p className="font-black text-ink-inverse">Nenhum programa individual configurado</p>
            <p className="mt-2 text-sm text-muted-inverse">
              Adicione um programa em Fontes para criar uma política própria de sequência, replay ou validade.
            </p>
          </section>
        ) : (
          <PodcastPolicyClient
            shows={clientShows}
            initialOpenId={initialOpenId}
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
  const policy: PodcastShowPolicySnapshot & { publishedEpisodeIds: string[] } = {
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
  return policy;
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
