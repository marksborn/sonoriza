/**
 * #473 — First-party, deterministic onboarding seeds.
 * No Spotify user data, LLM, database or network call is used by this contract.
 */
export const COLD_START_GENRES = [
  { id: "rock", label: "Rock", lastFmTags: ["rock"] },
  { id: "pop", label: "Pop", lastFmTags: ["pop"] },
  { id: "mpb", label: "MPB", lastFmTags: ["mpb"] },
  { id: "samba", label: "Samba", lastFmTags: ["samba"] },
  { id: "pagode", label: "Pagode", lastFmTags: ["pagode"] },
  { id: "sertanejo", label: "Sertanejo", lastFmTags: ["sertanejo"] },
  { id: "metal", label: "Metal", lastFmTags: ["metal"] },
  { id: "eletronica", label: "Eletrônica", lastFmTags: ["electronic"] },
  { id: "jazz", label: "Jazz", lastFmTags: ["jazz"] },
  { id: "hip-hop", label: "Hip-Hop", lastFmTags: ["hip-hop"] },
] as const;

export const COLD_START_PODCAST_TOPICS = [
  { id: "tecnologia", label: "Tecnologia", searchTerms: ["tecnologia"] },
  { id: "ciencia", label: "Ciência", searchTerms: ["ciência"] },
  { id: "historia", label: "História", searchTerms: ["história"] },
  { id: "noticias", label: "Notícias", searchTerms: ["notícias"] },
  { id: "humor", label: "Humor", searchTerms: ["comédia"] },
  { id: "games", label: "Games", searchTerms: ["games"] },
  { id: "negocios", label: "Negócios", searchTerms: ["negócios"] },
  { id: "esportes", label: "Esportes", searchTerms: ["esportes"] },
  { id: "educacao", label: "Educação", searchTerms: ["educação"] },
  { id: "cinema", label: "Cinema e séries", searchTerms: ["cinema"] },
] as const;

export type ColdStartContent = "MUSIC" | "PODCAST" | "MIXED";
export type PodcastFollowMode = "SONORIZA_ONLY" | "SONORIZA_AND_SPOTIFY";

export interface ColdStartPreferences {
  content: ColdStartContent;
  genreIds: string[];
  artistNames: string[];
  podcastTopicIds: string[];
  podcastLanguage: string;
}

export function needsColdStart(input: {
  eligibleSourceCount: number;
  startFromZero?: boolean;
}): boolean {
  return input.startFromZero === true || input.eligibleSourceCount <= 0;
}

function normalizeSelections(
  raw: readonly string[],
  allowed: ReadonlySet<string>,
  limit: number,
): string[] {
  const result: string[] = [];
  for (const value of raw) {
    const id = value.trim();
    if (!allowed.has(id) || result.includes(id)) continue;
    result.push(id);
    if (result.length === limit) break;
  }
  return result;
}

/** Only declarative first-party preferences, never fabricated playback history. */
export function normalizeColdStartPreferences(input: {
  content: ColdStartContent;
  genreIds?: readonly string[];
  artistNames?: readonly string[];
  podcastTopicIds?: readonly string[];
  podcastLanguage?: string;
}): ColdStartPreferences {
  const music = input.content === "MUSIC" || input.content === "MIXED";
  const podcast = input.content === "PODCAST" || input.content === "MIXED";
  const genreIds = music
    ? normalizeSelections(
        input.genreIds ?? [],
        new Set<string>(COLD_START_GENRES.map((genre) => genre.id)),
        6,
      )
    : [];
  const normalizedArtistNames = (input.artistNames ?? [])
    .map((artist) => artist.trim().replace(/\s+/g, " ").slice(0, 120))
    .filter(Boolean);
  const artistNames = music
    ? normalizedArtistNames
        .filter((artist, index) =>
          normalizedArtistNames.findIndex((other) =>
            other.toLocaleLowerCase("pt-BR") === artist.toLocaleLowerCase("pt-BR"),
          ) === index,
        )
        .slice(0, 8)
    : [];
  const podcastTopicIds = podcast
    ? normalizeSelections(
        input.podcastTopicIds ?? [],
        new Set<string>(COLD_START_PODCAST_TOPICS.map((topic) => topic.id)),
        6,
      )
    : [];
  const language = (input.podcastLanguage ?? "pt-BR").trim();
  return {
    content: input.content,
    genreIds,
    artistNames,
    podcastTopicIds,
    podcastLanguage: podcast && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(language)
      ? language
      : "pt-BR",
  };
}

export interface PodcastFollowPlan {
  spotifyShowId: string;
  source: { spotifyType: "SHOW"; kind: "PODCAST" };
  followInSonoriza: true;
  followOnSpotify: boolean;
  spotifyLibraryUri: string | null;
  saveEpisodesToYourEpisodes: false;
}

/**
 * A SHOW source makes future episodes eligible to the Sonoriza planner.
 * Following a show in Spotify DOES NOT populate Spotify's "Your Episodes".
 * Saving individual episodes requires a separate explicit opt-in and gate.
 */
export function planPodcastFollow(input: {
  spotifyShowId: string;
  mode: PodcastFollowMode;
  confirmed: boolean;
}): PodcastFollowPlan {
  if (!input.confirmed) throw new Error("Confirmação explícita necessária.");
  const id = input.spotifyShowId.trim().replace(/^spotify:show:/, "");
  if (!/^[A-Za-z0-9]{22}$/.test(id)) {
    throw new Error("Identificador de podcast Spotify inválido.");
  }
  if (input.mode !== "SONORIZA_ONLY" && input.mode !== "SONORIZA_AND_SPOTIFY") {
    throw new Error("Modo de acompanhamento inválido.");
  }
  const followOnSpotify = input.mode === "SONORIZA_AND_SPOTIFY";
  return {
    spotifyShowId: id,
    source: { spotifyType: "SHOW", kind: "PODCAST" },
    followInSonoriza: true,
    followOnSpotify,
    spotifyLibraryUri: followOnSpotify ? `spotify:show:${id}` : null,
    saveEpisodesToYourEpisodes: false,
  };
}
