import assert from "node:assert/strict";
import test from "node:test";

import {
  carryForwardLastFmFactualPlanningCounters,
  filterMusicCandidatesForLastFmFactualCooldown,
  lastFmMusicIdentityKey,
  mustBlockRealWriteForLastFmFactualCooldown,
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
    preWriteRevalidationCount: 0,
    preWriteBlockedTotalCount: 0,
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

test("#512 ACTIVE cannot admit symbol-only or missing-artist music even with no scrobbles", () => {
  const symbolOnly = { ...fresh, uri: "spotify:track:symbol-only", title: "∞" };
  const missingArtist = {
    ...fresh, uri: "spotify:track:no-artist",
    primaryArtistName: "", subtitle: "",
  };
  assert.equal(lastFmMusicIdentityKey("∞", "Unknown Artist"), null);
  assert.equal(lastFmMusicIdentityKey("Valid Title", ""), null);

  const result = filterMusicCandidatesForLastFmFactualCooldown(
    [symbolOnly, missingArtist, fresh],
    state("ACTIVE", []),
  );
  assert.deepEqual(result.candidates.map((candidate) => candidate.uri), [fresh.uri]);
  assert.equal(result.matchedCandidateCount, 0);
  assert.equal(result.skippedCandidateCount, 2);
});

test("#512 SHADOW does not exclude symbol-only music", () => {
  const symbolOnly = { ...fresh, uri: "spotify:track:symbol-only", title: "∞" };
  const result = filterMusicCandidatesForLastFmFactualCooldown(
    [symbolOnly, fresh],
    state("SHADOW", []),
  );
  assert.deepEqual(result.candidates.map((candidate) => candidate.uri), [
    symbolOnly.uri, fresh.uri,
  ]);
  assert.equal(result.matchedCandidateCount, 0);
  assert.equal(result.skippedCandidateCount, 0);
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


test("Gate #512 bloqueia geração real quando ACTIVE degrada para SHADOW", () => {
  const unavailable = state("ACTIVE", []);
  unavailable.effectiveMode = "SHADOW";
  unavailable.status = "PROVIDER_UNAVAILABLE";
  unavailable.providerComplete = false;
  unavailable.failure = "Last.fm returned invalid JSON (503)";

  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(unavailable, false), true);
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(unavailable, true), false);

  unavailable.status = "PROVIDER_INCOMPLETE";
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(unavailable, false), true);

  unavailable.status = "NOT_CONFIGURED";
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(unavailable, false), true);

  unavailable.status = "POLICY_INCOMPLETE";
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(unavailable, false), true);
});

test("Gate #512 permite somente regra ACTIVE com cobertura completa ou sem opt-in", () => {
  const active = state("ACTIVE", []);
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(active, false), false);
  active.providerComplete = false;
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(active, false), true);
  active.providerComplete = true;
  active.effectiveMode = "SHADOW";
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(active, false), true);

  const disabled = state("ACTIVE", []);
  disabled.effectiveMode = "OFF";
  disabled.status = "POLICY_DISABLED";
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(disabled, false), false);
  disabled.status = "USER_NOT_ALLOWLISTED";
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(disabled, false), false);

  const shadow = state("SHADOW", []);
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(shadow, false), false);
  assert.equal(mustBlockRealWriteForLastFmFactualCooldown(undefined, false), false);
});

test("#512 preserva contagem de candidatas filtradas após revalidação factual", () => {
  const key = lastFmMusicIdentityKey(listened.title, listened.subtitle)!;
  const before = state("ACTIVE", [key]);
  const filtered = filterMusicCandidatesForLastFmFactualCooldown(
    [listened, fresh],
    before,
  );
  before.matchedCandidateCount += filtered.matchedCandidateCount;
  before.skippedCandidateCount += filtered.skippedCandidateCount;

  const revalidated = state("ACTIVE", [key]);
  revalidated.asOf = new Date(before.asOf.getTime() + 1_000);
  revalidated.preWriteRevalidated = true;
  revalidated.preWriteRevalidationCount = 1;

  carryForwardLastFmFactualPlanningCounters(before, revalidated);
  assert.equal(revalidated.matchedCandidateCount, 1);
  assert.equal(revalidated.skippedCandidateCount, 1);
  assert.equal(revalidated.preWriteRevalidationCount, 1);
  assert.equal(revalidated.preWriteRevalidated, true);
  assert.notEqual(revalidated, before);
  assert.deepEqual(filtered.candidates.map((candidate) => candidate.uri), [fresh.uri]);

  const next = state("ACTIVE", [key]);
  next.preWriteRevalidated = true;
  next.preWriteRevalidationCount = 2;
  carryForwardLastFmFactualPlanningCounters(revalidated, next);
  assert.equal(next.matchedCandidateCount, 1);
  assert.equal(next.skippedCandidateCount, 1);
  assert.equal(next.preWriteRevalidationCount, 2);
});
