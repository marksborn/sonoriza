import assert from "node:assert/strict";
import test from "node:test";

import { spotifyCatalogRecommendationCapability } from "@/services/data-policy";

import {
  AlbumOpportunityComplianceQuarantinedError,
  getAlbumOpportunityReport,
} from "./opportunity-report";
import { getAlbumOpportunitySnapshotRefreshState } from "./opportunity-snapshot";

test("Spotify catalog is not currently authorized for album recommendation", () => {
  const capability = spotifyCatalogRecommendationCapability();
  assert.equal(capability.allowed, false);
  assert.equal(capability.decisions.RECOMMENDATION, "DENY");
});

test("ALBUM-01 report fails before database/profile/provider acquisition", async () => {
  await assert.rejects(
    () => getAlbumOpportunityReport("no-database-access-needed"),
    AlbumOpportunityComplianceQuarantinedError,
  );
});

test("quarantined album snapshots do not schedule refresh loops", async () => {
  const state = await getAlbumOpportunitySnapshotRefreshState(
    "no-file-access-needed",
    new Date("2026-09-02T12:00:00.000Z"),
  );
  assert.deepEqual(state, {
    status: "MISSING",
    completeness: null,
    generatedAt: null,
    ageMs: null,
    shouldRefresh: false,
  });
});
