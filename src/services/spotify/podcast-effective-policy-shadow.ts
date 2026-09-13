import { prisma } from "@/lib/prisma";

import {
  loadPodcastSavedEpisodesPolicy,
  type PodcastSavedEpisodesPolicySnapshot,
} from "./podcast-saved-episodes-policy-store";
import {
  loadPodcastShowPolicies,
  type PodcastShowEpisodeScopeValue,
  type PodcastShowPolicyStoredSnapshot,
} from "./podcast-show-policy-store";

export type PodcastSavedEpisodeShadowObservation = {
  spotifyEpisodeId: string | null;
  spotifyUri: string;
  spotifyShowId: string | null;
  showName: string | null;
};

export type PodcastShowOverrideShadow = {
  sourcePlaylistId: string;
  spotifyShowId: string;
  showName: string | null;
  showEpisodeScope: PodcastShowEpisodeScopeValue;
  policy: PodcastShowPolicyStoredSnapshot;
};

export type PodcastEffectivePolicyShadowGroup = {
  spotifyShowId: string;
  showName: string | null;
  savedEpisodeCount: number;
  savedEpisodes: PodcastSavedEpisodeShadowObservation[];
  effectivePolicy:
    | {
        authority: "SHOW_OVERRIDE";
        sourcePlaylistId: string;
        showEpisodeScope: PodcastShowEpisodeScopeValue;
        policy: PodcastShowPolicyStoredSnapshot;
      }
    | {
        authority: "SAVED_EPISODES_DEFAULT";
        sourcePlaylistId: string;
        policy: PodcastSavedEpisodesPolicySnapshot;
      }
    | {
        authority: "LEGACY_SAVED_EPISODES";
        sourcePlaylistId: string;
        policy: null;
      };
};

export type PodcastEffectivePolicyShadowDiagnostics = {
  savedEpisodeCount: number;
  groupedSavedEpisodeCount: number;
  missingShowIdentityCount: number;
  observedShowCount: number;
  showOverrideCount: number;
  savedOnlyOverrideShowCount: number;
  allEpisodesOverrideShowCount: number;
  defaultGovernedShowCount: number;
  legacySavedEpisodesShowCount: number;
  shadowSuppressedSavedEpisodeCount: number;
};

export type PodcastEffectivePolicyShadowResult = {
  savedEpisodesSourcePlaylistId: string;
  defaultPolicy: PodcastSavedEpisodesPolicySnapshot | null;
  groups: PodcastEffectivePolicyShadowGroup[];
  diagnostics: PodcastEffectivePolicyShadowDiagnostics;
};

export function resolvePodcastEffectivePolicyShadow(input: {
  savedEpisodesSourcePlaylistId: string;
  defaultPolicy: PodcastSavedEpisodesPolicySnapshot | null;
  showOverrides: readonly PodcastShowOverrideShadow[];
  savedEpisodes: readonly PodcastSavedEpisodeShadowObservation[];
}): PodcastEffectivePolicyShadowResult {
  const showOverrides = new Map(
    [...input.showOverrides]
      .sort((left, right) =>
        left.sourcePlaylistId.localeCompare(right.sourcePlaylistId),
      )
      .map((override) => [override.spotifyShowId, override] as const),
  );
  const grouped = new Map<string, PodcastSavedEpisodeShadowObservation[]>();
  let missingShowIdentityCount = 0;

  for (const episode of input.savedEpisodes) {
    const spotifyShowId = normalizedId(episode.spotifyShowId);
    if (!spotifyShowId) {
      missingShowIdentityCount += 1;
      continue;
    }

    const episodes = grouped.get(spotifyShowId) ?? [];
    episodes.push({ ...episode, spotifyShowId });
    grouped.set(spotifyShowId, episodes);
  }

  let showOverrideCount = 0;
  let savedOnlyOverrideShowCount = 0;
  let allEpisodesOverrideShowCount = 0;
  let defaultGovernedShowCount = 0;
  let legacySavedEpisodesShowCount = 0;
  let shadowSuppressedSavedEpisodeCount = 0;

  const groups = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([spotifyShowId, episodes]): PodcastEffectivePolicyShadowGroup => {
      const override = showOverrides.get(spotifyShowId);
      const showName = firstNonEmptyShowName(episodes) ?? override?.showName ?? null;

      if (override) {
        showOverrideCount += 1;
        shadowSuppressedSavedEpisodeCount += episodes.length;
        if (override.showEpisodeScope === "SAVED_ONLY") {
          savedOnlyOverrideShowCount += 1;
        } else {
          allEpisodesOverrideShowCount += 1;
        }

        return {
          spotifyShowId,
          showName,
          savedEpisodeCount: episodes.length,
          savedEpisodes: episodes.map((episode) => ({ ...episode })),
          effectivePolicy: {
            authority: "SHOW_OVERRIDE",
            sourcePlaylistId: override.sourcePlaylistId,
            showEpisodeScope: override.showEpisodeScope,
            policy: override.policy,
          },
        };
      }

      if (input.defaultPolicy?.enabled) {
        defaultGovernedShowCount += 1;
        return {
          spotifyShowId,
          showName,
          savedEpisodeCount: episodes.length,
          savedEpisodes: episodes.map((episode) => ({ ...episode })),
          effectivePolicy: {
            authority: "SAVED_EPISODES_DEFAULT",
            sourcePlaylistId: input.savedEpisodesSourcePlaylistId,
            policy: input.defaultPolicy,
          },
        };
      }

      legacySavedEpisodesShowCount += 1;
      return {
        spotifyShowId,
        showName,
        savedEpisodeCount: episodes.length,
        savedEpisodes: episodes.map((episode) => ({ ...episode })),
        effectivePolicy: {
          authority: "LEGACY_SAVED_EPISODES",
          sourcePlaylistId: input.savedEpisodesSourcePlaylistId,
          policy: null,
        },
      };
    });

  return {
    savedEpisodesSourcePlaylistId: input.savedEpisodesSourcePlaylistId,
    defaultPolicy: input.defaultPolicy,
    groups,
    diagnostics: {
      savedEpisodeCount: input.savedEpisodes.length,
      groupedSavedEpisodeCount:
        input.savedEpisodes.length - missingShowIdentityCount,
      missingShowIdentityCount,
      observedShowCount: groups.length,
      showOverrideCount,
      savedOnlyOverrideShowCount,
      allEpisodesOverrideShowCount,
      defaultGovernedShowCount,
      legacySavedEpisodesShowCount,
      shadowSuppressedSavedEpisodeCount,
    },
  };
}

/**
 * PODCAST-07 Gate 2 read-model. This resolves policy authority against already
 * collected SAVED_EPISODES observations only. It does not call Spotify, does
 * not change candidate selection, does not write policy rows and is not wired
 * into planner/runtime or configuration fingerprints.
 */
export async function loadPodcastEffectivePolicyShadow(input: {
  userId: string;
  savedEpisodesSourcePlaylistId: string;
  savedEpisodes: readonly PodcastSavedEpisodeShadowObservation[];
}): Promise<PodcastEffectivePolicyShadowResult | null> {
  const savedEpisodesSource = await prisma.sourcePlaylist.findFirst({
    where: {
      id: input.savedEpisodesSourcePlaylistId,
      userId: input.userId,
      kind: "PODCAST",
      spotifyType: "SAVED_EPISODES",
    },
    select: { id: true },
  });
  if (!savedEpisodesSource) return null;

  const [defaultPolicy, showSources, showPolicies] = await Promise.all([
    loadPodcastSavedEpisodesPolicy(
      input.userId,
      input.savedEpisodesSourcePlaylistId,
    ),
    prisma.sourcePlaylist.findMany({
      where: {
        userId: input.userId,
        kind: "PODCAST",
        spotifyType: "SHOW",
      },
      select: {
        id: true,
        spotifyId: true,
        name: true,
      },
    }),
    loadPodcastShowPolicies(input.userId),
  ]);

  const showOverrides: PodcastShowOverrideShadow[] = showSources.flatMap(
    (source) => {
      const policy = showPolicies.get(source.id);
      if (!policy) return [];
      return [
        {
          sourcePlaylistId: source.id,
          spotifyShowId: source.spotifyId,
          showName: normalizedId(source.name),
          showEpisodeScope: policy.showEpisodeScope ?? "ALL_EPISODES",
          policy,
        },
      ];
    },
  );

  return resolvePodcastEffectivePolicyShadow({
    savedEpisodesSourcePlaylistId: savedEpisodesSource.id,
    defaultPolicy,
    showOverrides,
    savedEpisodes: input.savedEpisodes,
  });
}

function normalizedId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function firstNonEmptyShowName(
  episodes: readonly PodcastSavedEpisodeShadowObservation[],
): string | null {
  for (const episode of episodes) {
    const showName = normalizedId(episode.showName);
    if (showName) return showName;
  }
  return null;
}
