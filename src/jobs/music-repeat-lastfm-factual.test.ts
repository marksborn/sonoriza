import assert from "node:assert/strict";
import test from "node:test";

import {
  filterMusicCandidatesForLastFmFactualCooldown,
  lastFmMusicIdentityKey,
  type LastFmFactualCooldownRuntimeState,
} from "./music-repeat-runtime";

function state(
  mode: "SHADOW" | "ACTIVE",
  keys: readonly string[],
): LastFmFactualCooldownRuntimeState {
  return {
    configuredMode: mode,
    effectiveMode: mode,
    status: mode === "ACTIVE" ? "READY_ACTIVE" : "READY_SHADOW",
    productiveInfluenceAllowed: mode === "ACTIVE",
    windowValue: 6,
    windowUnit: "MONTHS",
    cutoff: new Date("2026-03-28T12:00:00.000Z"),
    asOf: new Date("2026-09-28T12:00:00.000Z"),
    blockedIdentityKeys: new Set(keys),
    localScrobbleCount: keys.length,
    providerScrobbleCount: 0,
    providerRequestedFrom: null,
    providerRequestedTo: null,
    providerPagesFetched: 0,
    providerTotalPages: 0,
    providerComplete: true,
    matchedCandidateCount: 0,
    skippedCandidateCount: 0,
    preWriteRevalidated: false,
    preWriteBlockedCount: 0,
    failure: null,
  };
}

const listened = {
  type: "MUSIC" as const,
  uri: "spotify:track:heard",
  spotifyTrackId: "heard",
  title: "I'm So Sick",
  subtitle: "Flyleaf",
  primaryArtistName: "Flyleaf",
  durationMs: 185000,
};

const fresh = {
  type: "MUSIC" as const,
  uri: "spotify:track:fresh",
  spotifyTrackId: "fresh",
  title: "Fresh Track",
  subtitle: "Fresh Artist",
  primaryArtistName: "Fresh Artist",
  durationMs: 190000,
};

test("normaliza artista+faixa de forma conservadora e estável", () => {
  assert.equal(
    lastFmMusicIdentityKey("A Ele", "Oficina G3"),
    lastFmMusicIdentityKey("A Éle", "OFICINA   G3"),
  );
  assert.notEqual(
    lastFmMusicIdentityKey("A Ele - Live", "Oficina G3"),
    lastFmMusicIdentityKey("A Ele", "Oficina G3"),
  );
});

test("aceita diferença apenas de espaço no título com artista exato", () => {
  assert.equal(
    lastFmMusicIdentityKey("Dragon Fly", "Atomship"),
    lastFmMusicIdentityKey("Dragonfly", "Atomship"),
  );
  assert.notEqual(
    lastFmMusicIdentityKey("Dragon Fly", "Atomship"),
    lastFmMusicIdentityKey("Dragonfly", "Another Artist"),
  );
  assert.notEqual(
    lastFmMusicIdentityKey("Dragon Fly - Live", "Atomship"),
    lastFmMusicIdentityKey("Dragonfly", "Atomship"),
  );
});

test("ACTIVE remove candidata com scrobble factual dentro da janela", () => {
  const key = lastFmMusicIdentityKey(listened.title, listened.subtitle)!;
  const result = filterMusicCandidatesForLastFmFactualCooldown(
    [listened, fresh],
    state("ACTIVE", [key]),
  );

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.uri),
    [fresh.uri],
  );
  assert.equal(result.matchedCandidateCount, 1);
  assert.equal(result.skippedCandidateCount, 1);
});

test("SHADOW mede a candidata ouvida sem alterar elegibilidade", () => {
  const key = lastFmMusicIdentityKey(listened.title, listened.subtitle)!;
  const result = filterMusicCandidatesForLastFmFactualCooldown(
    [listened, fresh],
    state("SHADOW", [key]),
  );

  assert.deepEqual(
    result.candidates.map((candidate) => candidate.uri),
    [listened.uri, fresh.uri],
  );
  assert.equal(result.matchedCandidateCount, 1);
  assert.equal(result.skippedCandidateCount, 0);
});

test("podcast nunca é afetado pelo cooldown factual de música", () => {
  const podcast = {
    type: "PODCAST" as const,
    uri: "spotify:episode:one",
    title: "I'm So Sick",
    subtitle: "Flyleaf",
    durationMs: 1200000,
  };
  const key = lastFmMusicIdentityKey(podcast.title, podcast.subtitle)!;
  const result = filterMusicCandidatesForLastFmFactualCooldown(
    [podcast],
    state("ACTIVE", [key]),
  );

  assert.equal(result.candidates.length, 1);
  assert.equal(result.matchedCandidateCount, 0);
  assert.equal(result.skippedCandidateCount, 0);
});
