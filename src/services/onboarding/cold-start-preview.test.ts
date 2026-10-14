import assert from "node:assert/strict";
import test from "node:test";

import { ColdStartPreviewService } from "./cold-start-preview";

const show = {
  id: "0123456789012345678901",
  name: "Ciência em Foco",
  publisher: "Editora",
  description: null,
  languages: ["pt"],
  totalEpisodes: 10,
  spotifyUrl: "https://open.spotify.com/show/0123456789012345678901",
};

test("#473 Gate B previews a genre with public Last.fm only and caches duplicate requests", async () => {
  const calls: string[] = [];
  const lastfm = {
    getPublicTagTopArtists: async (tag: string) => {
      calls.push("artists:" + tag);
      return [{ name: "Pitty", mbid: null, url: null }];
    },
    getPublicTagTopTracks: async (tag: string) => {
      calls.push("tracks:" + tag);
      return [{ name: "Equalize", artistName: "Pitty", mbid: null, url: null }];
    },
    getPublicArtistTopTracks: async () => [],
    getPublicSimilarArtists: async () => [],
  };
  const spotify = {
    searchShows: async () => [show],
    getDiscoveredShow: async () => show,
  };
  const preview = new ColdStartPreviewService(lastfm, spotify);
  const first = await preview.previewGenre("mpb");
  const second = await preview.previewGenre("mpb");
  assert.deepEqual(first, second);
  assert.equal(first.provenance, "LASTFM_PUBLIC_TAG");
  assert.equal(first.spotifyResolved, false);
  assert.deepEqual(calls, ["artists:mpb", "tracks:mpb"]);
  await assert.rejects(preview.previewGenre("not-a-genre"), /Unknown/);
});

test("#473 Gate B retrieves podcast themes by Spotify search only, never saving episodes", async () => {
  const searches: string[] = [];
  const lastfm = {
    getPublicTagTopArtists: async () => [],
    getPublicTagTopTracks: async () => [],
    getPublicArtistTopTracks: async () => [],
    getPublicSimilarArtists: async () => [],
  };
  const spotify = {
    searchShows: async (query: { query: string; market?: string; limit?: number }) => {
      searches.push(query.query + ":" + query.market + ":" + query.limit);
      return [show];
    },
    getDiscoveredShow: async (query: { id: string }) =>
      query.id === show.id ? show : null,
  };
  const preview = new ColdStartPreviewService(lastfm, spotify);
  const topics = await preview.previewPodcastTopic("tecnologia");
  assert.deepEqual(searches, ["tecnologia:BR:8"]);
  assert.equal(topics.followed, false);
  assert.equal(topics.episodesSaved, false);
  assert.equal(topics.shows[0]?.id, show.id);
  assert.equal((await preview.inspectShow(show.id))?.name, show.name);
  await assert.rejects(preview.previewPodcastTopic("invalid"), /Unknown/);
  await assert.rejects(preview.searchPodcasts(" "), /Invalid/);
});
