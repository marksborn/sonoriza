import {
  PodcastEpisodeOrder,
  SourceKind,
  SpotifySourceType,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  isSpotifyApiError,
  SpotifyClient,
} from "@/services/spotify";

const LIBRARY_SCOPE = "user-library-read";
const PLAYBACK_SCOPE = "user-read-playback-position";
const SAVED_EPISODES_ID = "me";

export type SpotifySourceConfigurationErrorCode =
  | "invalid"
  | "spotify"
  | "scope"
  | "rate-limit";

export class SpotifySourceConfigurationError extends Error {
  constructor(
    readonly code: SpotifySourceConfigurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SpotifySourceConfigurationError";
  }
}

function scopeIncludes(
  scope: string | null | undefined,
  expected: string,
) {
  return new Set((scope ?? "").split(/\s+/).filter(Boolean)).has(expected);
}

function normalizeSpotifyType(raw: string) {
  if (raw === SpotifySourceType.PLAYLIST) {
    return SpotifySourceType.PLAYLIST;
  }

  if (raw === SpotifySourceType.SHOW) {
    return SpotifySourceType.SHOW;
  }

  if (raw === SpotifySourceType.SAVED_EPISODES) {
    return SpotifySourceType.SAVED_EPISODES;
  }

  return null;
}

function normalizeSourceKind(raw: string) {
  if (raw === SourceKind.MUSIC) return SourceKind.MUSIC;
  if (raw === SourceKind.PODCAST) return SourceKind.PODCAST;
  return null;
}

export async function saveSpotifySourceForUser(input: {
  userId: string;
  spotifyId: string;
  spotifyType: string;
  kind: string;
}) {
  const spotifyId = input.spotifyId.trim();
  const spotifyType = normalizeSpotifyType(input.spotifyType.trim());
  const requestedKind = normalizeSourceKind(input.kind.trim());

  if (!spotifyId || !spotifyType || !requestedKind) {
    throw new SpotifySourceConfigurationError(
      "invalid",
      "Fonte inválida.",
    );
  }

  const spotifyAccount = await prisma.account.findFirst({
    where: {
      userId: input.userId,
      provider: "spotify",
    },
    select: {
      id: true,
      scope: true,
    },
  });

  if (!spotifyAccount) {
    throw new SpotifySourceConfigurationError(
      "spotify",
      "Spotify não conectado.",
    );
  }

  const hasLibraryScope = scopeIncludes(
    spotifyAccount.scope,
    LIBRARY_SCOPE,
  );

  const hasPlaybackScope = scopeIncludes(
    spotifyAccount.scope,
    PLAYBACK_SCOPE,
  );

  let sourceName: string | undefined;
  let kind = requestedKind;

  try {
    const client = await SpotifyClient.forUser(input.userId);

    if (spotifyType === SpotifySourceType.PLAYLIST) {
      if (
        requestedKind === SourceKind.PODCAST &&
        !hasPlaybackScope
      ) {
        throw new SpotifySourceConfigurationError(
          "scope",
          "Permissão de posição de reprodução ausente.",
        );
      }

      // A gravação continua validando contra as playlists realmente
      // visíveis para a conta do usuário, preservando o contrato existente.
      const playlists = await client.listCurrentUserPlaylists();

      sourceName = playlists.find(
        (playlist) => playlist.id === spotifyId,
      )?.name;
    } else if (spotifyType === SpotifySourceType.SHOW) {
      if (!hasLibraryScope || !hasPlaybackScope) {
        throw new SpotifySourceConfigurationError(
          "scope",
          "Permissões de podcast ausentes.",
        );
      }

      const shows = await client.listSavedShows();

      sourceName = shows.find(
        (show) => show.id === spotifyId,
      )?.name;

      kind = SourceKind.PODCAST;
    } else {
      if (
        spotifyId !== SAVED_EPISODES_ID ||
        !hasLibraryScope ||
        !hasPlaybackScope
      ) {
        throw new SpotifySourceConfigurationError(
          "scope",
          "Permissões de episódios salvos ausentes.",
        );
      }

      sourceName = "Seus episódios";
      kind = SourceKind.PODCAST;
    }
  } catch (error) {
    if (error instanceof SpotifySourceConfigurationError) {
      throw error;
    }

    if (
      isSpotifyApiError(error) &&
      (error.kind === "RATE_LIMITED" ||
        error.kind === "QUOTA_EXCEEDED")
    ) {
      throw new SpotifySourceConfigurationError(
        "rate-limit",
        "Spotify temporariamente indisponível por limite de API.",
      );
    }

    throw new SpotifySourceConfigurationError(
      "spotify",
      "Não foi possível consultar o Spotify.",
    );
  }

  if (!sourceName) {
    throw new SpotifySourceConfigurationError(
      "invalid",
      "A fonte não está disponível na conta Spotify conectada.",
    );
  }

  const source = await prisma.sourcePlaylist.upsert({
    where: {
      userId_spotifyType_spotifyId: {
        userId: input.userId,
        spotifyType,
        spotifyId,
      },
    },
    create: {
      userId: input.userId,
      spotifyType,
      spotifyId,
      name: sourceName,
      kind,
      enabled: true,
      includePlayed: false,
      episodeOrder:
        spotifyType === SpotifySourceType.SHOW
          ? PodcastEpisodeOrder.OLDEST_FIRST
          : PodcastEpisodeOrder.SOURCE_DEFAULT,
    },
    update: {
      name: sourceName,
      kind,
      enabled: true,
    },
  });

  return {
    source,
    spotifyType,
  };
}
