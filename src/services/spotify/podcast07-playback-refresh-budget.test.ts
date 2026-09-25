import assert from "node:assert/strict";
import test from "node:test";

import {
  PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES,
  planPodcast07PlaybackRefresh,
  podcast07PlaybackRefreshBudgetRemaining,
} from "./podcast07-playback-refresh";

const NOW = new Date("2026-09-25T10:30:00.000Z");
const HOUR = 60 * 60 * 1000;

function row(id: string, ageMs: number) {
  return {
    spotifyEpisodeId: id,
    status: "NOT_STARTED" as const,
    lastObservedAt: new Date(NOW.getTime() - ageMs),
  };
}

test("recent factual observations consume the shared one-hour refresh budget", () => {
  const states = [
    row("recent-1", 5 * 60 * 1000),
    row("recent-2", 10 * 60 * 1000),
    row("stale-1", 2 * HOUR),
    row("stale-2", 3 * HOUR),
  ];

  assert.equal(
    podcast07PlaybackRefreshBudgetRemaining(states, NOW),
    PODCAST07_PLAYBACK_REFRESH_MAX_EPISODES - 2,
  );
});

test("eight recent observations stop another isolated run from rotating into stale backlog", () => {
  const byShow = new Map<string, readonly string[]>();
  const states = [];

  for (let index = 0; index < 8; index += 1) {
    const id = `recent-${index}`;
    byShow.set(`recent-show-${index}`, [id]);
    states.push(row(id, 10 * 60 * 1000));
  }

  for (let index = 0; index < 12; index += 1) {
    const id = `stale-${index}`;
    byShow.set(`stale-show-${index}`, [id]);
    states.push(row(id, (index + 2) * HOUR));
  }

  const remaining = podcast07PlaybackRefreshBudgetRemaining(states, NOW);
  assert.equal(remaining, 0);

  const plan = planPodcast07PlaybackRefresh({
    publishedEpisodeIdsByShow: byShow,
    listeningStates: states,
    now: NOW,
    maxEpisodeCount: remaining,
  });

  assert.equal(plan.eligibleEpisodeCount, 12);
  assert.deepEqual(plan.selectedEpisodeIds, []);
  assert.equal(plan.skippedByBudgetCount, 12);
});

test("partial remaining budget is never expanded back to the legacy per-run cap", () => {
  const byShow = new Map<string, readonly string[]>();
  const states = [];

  for (let index = 0; index < 6; index += 1) {
    const id = `recent-${index}`;
    byShow.set(`recent-show-${index}`, [id]);
    states.push(row(id, 15 * 60 * 1000));
  }

  for (let index = 0; index < 10; index += 1) {
    const id = `stale-${index}`;
    byShow.set(`stale-show-${index}`, [id]);
    states.push(row(id, (index + 2) * HOUR));
  }

  const remaining = podcast07PlaybackRefreshBudgetRemaining(states, NOW);
  assert.equal(remaining, 2);

  const plan = planPodcast07PlaybackRefresh({
    publishedEpisodeIdsByShow: byShow,
    listeningStates: states,
    now: NOW,
    maxEpisodeCount: remaining,
  });

  assert.equal(plan.selectedEpisodeIds.length, 2);
  assert.equal(plan.skippedByBudgetCount, 8);
});
