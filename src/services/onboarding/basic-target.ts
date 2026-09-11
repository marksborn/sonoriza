import {
  CalendarDurationStrategy,
  CalendarEventFilterMode,
  CompositionMode,
  EmptyCalendarBehavior,
  MusicOrderMode,
  PodcastEpisodeMaxDurationMode,
  TargetCalendarMode,
  TargetSharingPolicy,
  TargetSourceScopeMode,
  TargetUpdatePolicy,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  isSpotifyApiError,
  SpotifyClient,
} from "@/services/spotify";
import {
  assertSpotifyBackoffInactive,
  SpotifyBackoffActiveError,
} from "@/services/spotify/backoff";
import {
  assertTargetDestinationAvailableForUser,
  TargetDestinationConflictError,
} from "@/services/target-destination";

export const ONBOARDING_CREATE_NEW_DESTINATION =
  "__NEW__" as const;

export type OnboardingCompositionPreset =
  | "MUSIC"
  | "MIXED"
  | "PODCAST";

export type OnboardingTargetErrorCode =
  | "invalid"
  | "no-source"
  | "spotify"
  | "rate-limit"
  | "unavailable"
  | "source-conflict"
  | "target-conflict";

export class OnboardingTargetError extends Error {
  constructor(readonly code: OnboardingTargetErrorCode) {
    super(code);
    this.name = "OnboardingTargetError";
  }
}

function compositionData(
  preset: OnboardingCompositionPreset,
) {
  switch (preset) {
    case "MUSIC":
      return { podcastPercent: 0 };
    case "MIXED":
      return { podcastPercent: 30 };
    case "PODCAST":
      return { podcastPercent: 100 };
  }
}

export async function createBasicOnboardingTarget(input: {
  userId: string;
  name: string;
  destination: string;
  destinationOffset: number;
  durationMinutes: number;
  composition: OnboardingCompositionPreset;
}) {
  const name = input.name.trim();

  if (!name || name.length > 100) {
    throw new OnboardingTargetError("invalid");
  }

  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < 15 ||
    input.durationMinutes > 240
  ) {
    throw new OnboardingTargetError("invalid");
  }

  if (
    input.composition !== "MUSIC" &&
    input.composition !== "MIXED" &&
    input.composition !== "PODCAST"
  ) {
    throw new OnboardingTargetError("invalid");
  }

  const sources = await prisma.sourcePlaylist.findMany({
    where: {
      userId: input.userId,
      enabled: true,
    },
    select: {
      id: true,
    },
  });

  if (sources.length === 0) {
    throw new OnboardingTargetError("no-source");
  }

  const spotifyAccount = await prisma.account.findFirst({
    where: {
      userId: input.userId,
      provider: "spotify",
    },
    select: { id: true },
  });

  if (!spotifyAccount) {
    throw new OnboardingTargetError("spotify");
  }

  try {
    await assertSpotifyBackoffInactive();
  } catch (error) {
    if (error instanceof SpotifyBackoffActiveError) {
      throw new OnboardingTargetError("rate-limit");
    }

    throw error;
  }

  let client: SpotifyClient;

  try {
    client = await SpotifyClient.forUser(input.userId);
  } catch {
    throw new OnboardingTargetError("spotify");
  }

  let spotifyPlaylistId: string;

  try {
    if (
      input.destination ===
      ONBOARDING_CREATE_NEW_DESTINATION
    ) {
      spotifyPlaylistId = await client.createPlaylist(
        name,
        "Gerada e gerenciada pelo Sonoriza",
      );
    } else {
      if (
        !input.destination ||
        input.destination.length > 128
      ) {
        throw new OnboardingTargetError("invalid");
      }

      const [spotifyUserId, page] = await Promise.all([
        client.getCurrentUserId(),
        client.listCurrentUserPlaylistsPage(
          input.destinationOffset,
          12,
        ),
      ]);

      const selected = page.items.find(
        (playlist) =>
          playlist.id === input.destination &&
          playlist.ownerId === spotifyUserId,
      );

      if (!selected) {
        throw new OnboardingTargetError("unavailable");
      }

      spotifyPlaylistId = selected.id;
    }
  } catch (error) {
    if (error instanceof OnboardingTargetError) {
      throw error;
    }

    if (
      isSpotifyApiError(error) &&
      (error.kind === "RATE_LIMITED" ||
        error.kind === "QUOTA_EXCEEDED")
    ) {
      throw new OnboardingTargetError("rate-limit");
    }

    throw new OnboardingTargetError("spotify");
  }

  try {
    await assertTargetDestinationAvailableForUser({
      userId: input.userId,
      spotifyPlaylistId,
    });
  } catch (error) {
    if (error instanceof TargetDestinationConflictError) {
      throw new OnboardingTargetError(error.code);
    }
    throw error;
  }

  const maxPriority =
    await prisma.targetPlaylist.aggregate({
      where: { userId: input.userId },
      _max: { priority: true },
    });

  const composition = compositionData(
    input.composition,
  );

  return prisma.$transaction(async (tx) => {
    const target = await tx.targetPlaylist.create({
      data: {
        userId: input.userId,
        name,
        spotifyPlaylistId,

        // Segurança do onboarding: só Gate 7 ativa.
        enabled: false,

        priority:
          (maxPriority._max.priority ?? -1) + 1,

        sourceScopeMode:
          TargetSourceScopeMode.SELECTED_ONLY,
        sharingPolicy:
          TargetSharingPolicy.INHERIT_GLOBAL,

        compositionMode:
          CompositionMode.PROPORTION,
        musicOrderMode:
          MusicOrderMode.STANDARD,

        durationMode: "FIXED",
        fixedDurationSeconds:
          input.durationMinutes * 60,

        calendarMode:
          TargetCalendarMode.LEGACY_GLOBAL,
        emptyCalendarBehavior:
          EmptyCalendarBehavior.KEEP,
        calendarEventFilterMode:
          CalendarEventFilterMode.ALL,
        calendarDurationStrategy:
          CalendarDurationStrategy.SUMMED,

        podcastPercent:
          composition.podcastPercent,
        podcastEpisodeMaxDurationMode:
          PodcastEpisodeMaxDurationMode.NONE,
        podcastEpisodeMaxDurationSeconds: null,
        sequencePattern: [
          "MUSIC",
          "PODCAST",
          "MUSIC",
          "MUSIC",
          "PODCAST",
        ],
        maxEpisodesPerProgram: 1,

        maxTracksPerArtist: null,
        maxTracksPerAlbum: null,

        updatePolicy:
          TargetUpdatePolicy.MANUAL,
        dailyScheduleMinutes: null,
        scheduleTimezone: null,
      },
      select: {
        id: true,
        spotifyPlaylistId: true,
      },
    });

    await tx.targetPlaylistSource.createMany({
      data: sources.map((source) => ({
        userId: input.userId,
        targetPlaylistId: target.id,
        sourcePlaylistId: source.id,
      })),
    });

    return target;
  });
}
