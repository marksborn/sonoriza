import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPlaybackReserveMinutesInput,
  formatPlaybackReservePolicyLabel,
  formatPlaybackReserveUpdatePolicyLabel,
  parsePlaybackReservePolicyForm,
} from "./playback-reserve-ui";

function durationForm(minutes: string) {
  return {
    get(name: string): string | null {
      if (name === "reserveMode") return "DURATION";
      if (name === "durationMinutes") return minutes;
      return null;
    },
  };
}

test("#460: 901 seconds displays as two decimal minutes, not a repeating fraction", () => {
  assert.equal(formatPlaybackReserveMinutesInput(901), "15.02");
  assert.equal(formatPlaybackReserveMinutesInput(900), "15");
  assert.equal(formatPlaybackReserveMinutesInput(902), "15.03");
  assert.equal(formatPlaybackReserveMinutesInput(1), "0.02");

  // The backend stores whole seconds; formatting must not silently lose a second.
  assert.equal(parsePlaybackReservePolicyForm(durationForm("15.02")).durationSeconds, 901);
});

test("#460: every duration from one second to four hours round-trips unchanged", () => {
  for (let seconds = 1; seconds <= 4 * 60 * 60; seconds += 1) {
    const minutes = formatPlaybackReserveMinutesInput(seconds);
    assert.match(minutes, /^\d+(?:\.\d{1,2})?$/);
    const parsed = parsePlaybackReservePolicyForm(durationForm(minutes));
    assert.equal(parsed.durationSeconds, seconds, `lost precision on ${seconds} seconds (${minutes} min)`);
  }
});

test("#460: user labels use Brazilian formatting and friendly update modes", () => {
  assert.equal(
    formatPlaybackReservePolicyLabel({
      reserveMode: "DURATION",
      durationSeconds: 901,
      musicTrackCount: null,
      podcastEpisodeCount: null,
      podcastInDurationReserve: "IF_FITS",
    }),
    "+15,02 min · podcast se couber",
  );
  assert.equal(formatPlaybackReserveUpdatePolicyLabel("KEEP_FILLED"), "Manter completa");
  assert.equal(formatPlaybackReserveUpdatePolicyLabel("REBUILD_DAILY"), "Reconstrução diária");
  assert.equal(formatPlaybackReserveUpdatePolicyLabel("MANUAL"), "Manual");
  assert.equal(formatPlaybackReserveUpdatePolicyLabel("unsupported"), "Outra forma de atualização");
});

test("#460: the original duration parser continues rejecting empty and invalid inputs", () => {
  for (const value of ["", "0", "-1", "NaN", "Infinity", "abc"]) {
    assert.throws(() => parsePlaybackReservePolicyForm(durationForm(value)));
  }
});
