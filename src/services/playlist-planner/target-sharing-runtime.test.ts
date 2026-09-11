import assert from "node:assert/strict";
import test from "node:test";

import {
  addTargetReservations,
  findTargetSharingViolations,
  reservationsForTarget,
  type TargetSharingReservationOwner,
} from "./target-sharing-runtime";

test("#204 Gate 5 SHAREABLE + SHAREABLE does not reserve against the second target", () => {
  const reservations = new Map<string, TargetSharingReservationOwner[]>();

  addTargetReservations({
    targetPlaylistId: "a",
    sharingPolicy: "SHAREABLE",
    uris: ["spotify:track:1"],
    reservationsByUri: reservations,
  });

  const result = reservationsForTarget({
    targetPlaylistId: "b",
    effectiveSharingPolicy: "SHAREABLE",
    reservationsByUri: reservations,
  });

  assert.equal(result.forbiddenUris.has("spotify:track:1"), false);
  assert.equal(result.shareableReservationCount, 1);
  assert.equal(result.blockedByPolicyCount, 0);
});

test("#204 Gate 5 EXCLUSIVE owner blocks SHAREABLE target", () => {
  const reservations = new Map<string, TargetSharingReservationOwner[]>([
    [
      "spotify:track:1",
      [{ targetPlaylistId: "a", sharingPolicy: "EXCLUSIVE" }],
    ],
  ]);

  const result = reservationsForTarget({
    targetPlaylistId: "b",
    effectiveSharingPolicy: "SHAREABLE",
    reservationsByUri: reservations,
  });

  assert.equal(result.forbiddenUris.has("spotify:track:1"), true);
  assert.deepEqual(result.conflictingTargetIds, ["a"]);
});

test("#204 Gate 5 SHAREABLE owner is blocked by EXCLUSIVE target", () => {
  const reservations = new Map<string, TargetSharingReservationOwner[]>([
    [
      "spotify:track:1",
      [{ targetPlaylistId: "a", sharingPolicy: "SHAREABLE" }],
    ],
  ]);

  const result = reservationsForTarget({
    targetPlaylistId: "b",
    effectiveSharingPolicy: "EXCLUSIVE",
    reservationsByUri: reservations,
  });

  assert.equal(result.forbiddenUris.has("spotify:track:1"), true);
});

test("#204 Gate 5 legacy initialReserved remains hard exclusive", () => {
  const result = reservationsForTarget({
    targetPlaylistId: "b",
    effectiveSharingPolicy: "SHAREABLE",
    legacyHardReserved: ["spotify:track:legacy"],
    reservationsByUri: new Map(),
  });

  assert.equal(result.forbiddenUris.has("spotify:track:legacy"), true);
});

test("#204 Gate 5 final guard permits only SHAREABLE + SHAREABLE", () => {
  const shareablePolicies = new Map([
    ["a", "SHAREABLE" as const],
    ["b", "SHAREABLE" as const],
  ]);

  const allowed = findTargetSharingViolations({
    targets: [
      { targetPlaylistId: "a", name: "A", uris: ["spotify:track:1"] },
      { targetPlaylistId: "b", name: "B", uris: ["spotify:track:1"] },
    ],
    sharingPolicyByTargetId: shareablePolicies,
  });

  assert.equal(allowed.length, 0);

  const blocked = findTargetSharingViolations({
    targets: [
      { targetPlaylistId: "a", name: "A", uris: ["spotify:track:1"] },
      { targetPlaylistId: "b", name: "B", uris: ["spotify:track:1"] },
    ],
    sharingPolicyByTargetId: new Map([
      ["a", "EXCLUSIVE"],
      ["b", "SHAREABLE"],
    ]),
  });

  assert.equal(blocked.length, 1);
  assert.equal(blocked[0]?.source, "PLANNED_TARGET");
});

test("#204 Gate 5 final guard includes managed targets outside partial batch", () => {
  const violations = findTargetSharingViolations({
    targets: [
      {
        targetPlaylistId: "current",
        name: "Current",
        uris: ["spotify:track:1"],
      },
    ],
    sharingPolicyByTargetId: new Map([
      ["current", "SHAREABLE"],
    ]),
    externalReservationsByUri: new Map([
      [
        "spotify:track:1",
        [
          {
            targetPlaylistId: "outside",
            sharingPolicy: "EXCLUSIVE",
          },
        ],
      ],
    ]),
  });

  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.rightTargetPlaylistId, "outside");
  assert.equal(violations[0]?.source, "EXTERNAL_TARGET");
});
