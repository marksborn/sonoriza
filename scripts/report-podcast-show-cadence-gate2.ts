import { prisma } from "../src/lib/prisma";
import type { PodcastCadenceUnitValue } from "../src/services/spotify/podcast-show-cadence-contract";
import {
  evaluatePodcastShowCadenceShadow,
  type PodcastCadenceEvidence,
} from "../src/services/spotify/podcast-show-cadence-shadow";

const TOKEN_EXPIRY_SKEW_SECONDS = 60;
const MAX_SAVED_EPISODE_PAGES = 100;

type EpisodeIdentity = {
  episodeId: string;
  episodeName: string | null;
  showId: string | null;
  showName: string | null;
};

type SavedEpisodesPage = {
  items?: Array<{
    episode?: {
      id?: string;
      name?: string;
      show?: {
        id?: string;
        name?: string;
      };
    } | null;
  }>;
  next?: string | null;
};

async function main(): Promise<void> {
  const email = requiredArg("email");
  const showId = requiredArg("show-id");
  const showName = optionalArg("show-name");
  const timeZone = optionalArg("time-zone") ?? "America/Sao_Paulo";
  const maxEpisodes = positiveIntegerArg("max");
  const unit = cadenceUnitArg("unit");
  const asOf = dateArg("as-of") ?? new Date();

  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true, email: true },
  });

  const states = await prisma.episodeListeningState.findMany({
    where: { userId: user.id },
    select: {
      spotifyEpisodeId: true,
      spotifyUri: true,
      status: true,
      firstProgressObservedAt: true,
      lastObservedAt: true,
    },
    orderBy: { lastObservedAt: "desc" },
  });

  const accessToken = await readOnlySpotifyAccessToken(user.id);
  const identities = await resolveSavedEpisodeIdentities(
    accessToken,
    new Set(states.map((state) => state.spotifyEpisodeId)),
  );

  const evidence: PodcastCadenceEvidence[] = states.map((state) => ({
    spotifyEpisodeId: state.spotifyEpisodeId,
    spotifyShowId: identities.get(state.spotifyEpisodeId)?.showId ?? null,
    status: state.status,
    firstProgressObservedAt: state.firstProgressObservedAt,
  }));

  const evaluation = evaluatePodcastShowCadenceShadow({
    evidence,
    showId,
    maxEpisodes,
    unit,
    timeZone,
    asOf,
  });

  const targetStates = states
    .map((state) => ({
      ...state,
      identity: identities.get(state.spotifyEpisodeId) ?? null,
    }))
    .filter((state) => state.identity?.showId === showId);

  const unresolvedStates = states.filter(
    (state) => !identities.has(state.spotifyEpisodeId),
  );
  const unresolvedFactual = unresolvedStates.filter(
    (state) => state.firstProgressObservedAt !== null,
  );

  console.log("========== PODCAST-06 GATE 2 — CADENCE SHADOW ==========");
  console.log(`User:                         ${user.email}`);
  console.log(`Show:                         ${showName ?? targetStates[0]?.identity?.showName ?? showId}`);
  console.log(`Show ID:                      ${showId}`);
  console.log(`Hypothetical cadence:         ${maxEpisodes}/${unit}`);
  console.log(`Time zone:                    ${timeZone}`);
  console.log(`As of:                        ${asOf.toISOString()}`);
  console.log("Planner influence:            NONE");
  console.log("Database writes:              NONE");
  console.log("Spotify writes:               NONE");
  console.log("Spotify token refresh:        NONE");
  console.log("Consumption truth:            EpisodeListeningState.firstProgressObservedAt");
  console.log();

  console.log("---------- CIVIL WINDOW ----------");
  console.log(`unit                           ${evaluation.window.unit}`);
  console.log(`localStartDate                 ${evaluation.window.localStartDate}`);
  console.log(`localEndDateExclusive          ${evaluation.window.localEndDateExclusive}`);
  console.log(`startUtc                       ${evaluation.window.start.toISOString()}`);
  console.log(`endExclusiveUtc                ${evaluation.window.endExclusive.toISOString()}`);
  console.log();

  console.log("---------- CADENCE RESULT ----------");
  console.log(`consumedCount                  ${evaluation.consumedCount}`);
  console.log(`maxEpisodes                    ${evaluation.maxEpisodes}`);
  console.log(`limitReached                   ${evaluation.limitReached}`);
  console.log(
    `newEpisodeAllowedByCadence     ${evaluation.newEpisodeAllowedByCadence}`,
  );
  console.log(
    `inProgressContinuationCount    ${evaluation.inProgressContinuationEpisodeIds.length}`,
  );
  console.log(
    `legacyMissingTimestampCount    ${evaluation.legacyConsumptionWithoutTimestampEpisodeIds.length}`,
  );
  console.log();

  console.log("---------- CONSUMED EPISODES ----------");
  if (evaluation.consumedEpisodeIds.length === 0) {
    console.log("(none)");
  } else {
    for (const episodeId of evaluation.consumedEpisodeIds) {
      const state = targetStates.find(
        (entry) => entry.spotifyEpisodeId === episodeId,
      );
      console.log(
        `${episodeId} | ${state?.identity?.episodeName ?? "<unknown episode>"} | ${state?.status ?? "UNKNOWN"} | ${state?.firstProgressObservedAt?.toISOString() ?? "<missing first progress>"}`,
      );
    }
  }
  console.log();

  console.log("---------- IN_PROGRESS CONTINUATION ----------");
  if (evaluation.inProgressContinuationEpisodeIds.length === 0) {
    console.log("(none)");
  } else {
    for (const episodeId of evaluation.inProgressContinuationEpisodeIds) {
      const state = targetStates.find(
        (entry) => entry.spotifyEpisodeId === episodeId,
      );
      console.log(
        `${episodeId} | ${state?.identity?.episodeName ?? "<unknown episode>"} | CONTINUE_ALLOWED_DESPITE_CADENCE=${evaluation.limitReached}`,
      );
    }
  }
  console.log();

  console.log("---------- TARGET SHOW STATES ----------");
  if (targetStates.length === 0) {
    console.log("(none resolved from current SAVED_EPISODES)");
  } else {
    for (const state of targetStates) {
      console.log(
        `${state.spotifyEpisodeId} | ${state.identity?.episodeName ?? "<unknown episode>"} | ${state.status} | firstProgress=${state.firstProgressObservedAt?.toISOString() ?? "null"}`,
      );
    }
  }
  console.log();

  console.log("---------- PROVENANCE COVERAGE ----------");
  console.log(`canonicalStateCount            ${states.length}`);
  console.log(`resolvedFromSavedEpisodes      ${identities.size}`);
  console.log(`unresolvedStateCount           ${unresolvedStates.length}`);
  console.log(`unresolvedFactualCount         ${unresolvedFactual.length}`);
  console.log();

  if (evaluation.limitReached && targetStates.every((state) => state.status !== "NOT_STARTED")) {
    console.log(
      "NOTE: the cadence limit is factually reached for this show, but there is no current NOT_STARTED episode from the same show in the canonical SAVED_EPISODES state. Candidate blocking is therefore a shadow projection, not an observed planner removal.",
    );
  }

  if (unresolvedFactual.length > 0) {
    console.log(
      "WARNING: at least one factual consumption could not be mapped to a show from current SAVED_EPISODES. It is excluded from per-show cadence rather than inferred.",
    );
  }

  console.log("=========================================================");
}

async function readOnlySpotifyAccessToken(userId: string): Promise<string> {
  const account = await prisma.account.findFirst({
    where: { userId, provider: "spotify" },
    select: {
      access_token: true,
      expires_at: true,
    },
  });

  if (!account?.access_token || !account.expires_at) {
    throw new Error(
      "READ_ONLY_TOKEN_UNAVAILABLE: no persisted Spotify access token/expiry is available; Gate 2 will not refresh credentials.",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  if (account.expires_at - TOKEN_EXPIRY_SKEW_SECONDS <= now) {
    throw new Error(
      "READ_ONLY_TOKEN_EXPIRED: persisted Spotify access token is expired/about to expire; Gate 2 deliberately refuses token refresh because refresh writes Account.",
    );
  }

  return account.access_token;
}

async function resolveSavedEpisodeIdentities(
  accessToken: string,
  wantedEpisodeIds: ReadonlySet<string>,
): Promise<Map<string, EpisodeIdentity>> {
  const identities = new Map<string, EpisodeIdentity>();
  let nextUrl: string | null = "https://api.spotify.com/v1/me/episodes?limit=50";
  let pages = 0;

  while (nextUrl && identities.size < wantedEpisodeIds.size) {
    pages += 1;
    if (pages > MAX_SAVED_EPISODE_PAGES) {
      throw new Error(
        `SAVED_EPISODES_PAGE_LIMIT: exceeded ${MAX_SAVED_EPISODE_PAGES} read-only pages`,
      );
    }

    const response = await fetch(nextUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(
        `Spotify GET /me/episodes failed (${response.status} ${response.statusText}); no retry/write fallback is allowed in Gate 2`,
      );
    }

    const page = (await response.json()) as SavedEpisodesPage;
    for (const item of page.items ?? []) {
      const episode = item.episode;
      const episodeId = episode?.id?.trim();
      if (!episodeId || !wantedEpisodeIds.has(episodeId)) continue;
      identities.set(episodeId, {
        episodeId,
        episodeName: episode?.name?.trim() || null,
        showId: episode?.show?.id?.trim() || null,
        showName: episode?.show?.name?.trim() || null,
      });
    }

    nextUrl = page.next ?? null;
  }

  return identities;
}

function requiredArg(name: string): string {
  const value = optionalArg(name);
  if (!value) throw new Error(`Missing required --${name}=...`);
  return value;
}

function optionalArg(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function positiveIntegerArg(name: string): number {
  const value = Number(requiredArg(name));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function cadenceUnitArg(name: string): PodcastCadenceUnitValue {
  const value = requiredArg(name).toUpperCase();
  if (value === "DAY" || value === "WEEK" || value === "MONTH") return value;
  throw new Error(`--${name} must be DAY, WEEK or MONTH`);
}

function dateArg(name: string): Date | null {
  const value = optionalArg(name);
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`--${name} must be an ISO-8601 date/time`);
  }
  return date;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
