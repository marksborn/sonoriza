from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"anchor not found in {path}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "src/services/music-preference/liked-discovery-expansion-shadow.ts",
    "  spotifyArtistId: string;\n  spotifyTrackId: string;\n  trackName: string;\n  albumName: string | null;\n  resolutionReason: string;\n",
    "  spotifyArtistId: string;\n  spotifyTrackId: string;\n  spotifyUri: string;\n  durationMs: number;\n  isrc: string | null;\n  trackName: string;\n  albumId: string | null;\n  albumName: string | null;\n  resolutionReason: string;\n",
)
replace_once(
    "src/services/music-preference/liked-discovery-expansion-shadow.ts",
    "    spotifyArtistId: resolution.spotifyArtist.id,\n    spotifyTrackId: resolution.spotifyTrack.id,\n    trackName: resolution.spotifyTrack.name,\n    albumName: resolution.spotifyTrack.albumName,\n    resolutionReason: resolution.reason,\n",
    "    spotifyArtistId: resolution.spotifyArtist.id,\n    spotifyTrackId: resolution.spotifyTrack.id,\n    spotifyUri: resolution.spotifyTrack.uri,\n    durationMs: resolution.spotifyTrack.durationMs,\n    isrc: resolution.spotifyTrack.isrc,\n    trackName: resolution.spotifyTrack.name,\n    albumId: resolution.spotifyTrack.albumId,\n    albumName: resolution.spotifyTrack.albumName,\n    resolutionReason: resolution.reason,\n",
)

replace_once(
    "src/services/music-preference/liked-discovery-calibration-shadow.ts",
    "export type LikedNearDuplicateDiagnostic = {\n",
    "export type LikedCalibratedPilotCandidate = LikedExpansionResolvedCandidate & {\n  calibratedScore: number;\n};\n\nexport type LikedNearDuplicateDiagnostic = {\n",
)
replace_once(
    "src/services/music-preference/liked-discovery-calibration-shadow.ts",
    "  nearDuplicates: {\n    quarantined: number;\n    rows: LikedNearDuplicateDiagnostic[];\n  };\n  calibratedTop: LikedCalibratedDiscoveryTopEntry[];\n",
    "  nearDuplicates: {\n    quarantined: number;\n    rows: LikedNearDuplicateDiagnostic[];\n  };\n  pilotCandidates: LikedCalibratedPilotCandidate[];\n  calibratedTop: LikedCalibratedDiscoveryTopEntry[];\n",
)
replace_once(
    "src/services/music-preference/liked-discovery-calibration-shadow.ts",
    "  const ambiguityRate =\n",
    "  const resolvedByTrackId = new Map(\n    expansion.resolvedCandidates.map((row) => [row.spotifyTrackId, row] as const),\n  );\n  const pilotCandidates = calibratedTop\n    .filter(\n      (row): row is LikedCalibratedDiscoveryTopEntry & { spotifyTrackId: string } =>\n        row.source === \"LIKED_EXPANSION\" && Boolean(row.spotifyTrackId),\n    )\n    .map((row) => {\n      const resolved = resolvedByTrackId.get(row.spotifyTrackId);\n      return resolved ? { ...resolved, calibratedScore: row.calibratedScore } : null;\n    })\n    .filter((row): row is LikedCalibratedPilotCandidate => Boolean(row));\n\n  const ambiguityRate =\n",
)
replace_once(
    "src/services/music-preference/liked-discovery-calibration-shadow.ts",
    "    calibratedTop,\n    mix: {\n",
    "    pilotCandidates,\n    calibratedTop,\n    mix: {\n",
)

replace_once(
    "src/services/music-preference/liked-discovery-calibration-shadow.test.ts",
    "    spotifyTrackId,\n    trackName,\n    albumName: null,\n",
    "    spotifyTrackId,\n    spotifyUri: `spotify:track:${spotifyTrackId}`,\n    durationMs: 180000,\n    isrc: null,\n    trackName,\n    albumId: null,\n    albumName: null,\n",
)
replace_once(
    "src/services/music-preference/liked-discovery-expansion-shadow.test.ts",
    "    spotifyTrackId: \"track-new\",\n    trackName: \"New Track\",\n    albumName: \"New Album\",\n",
    "    spotifyTrackId: \"track-new\",\n    spotifyUri: \"spotify:track:track-new\",\n    durationMs: 180000,\n    isrc: null,\n    trackName: \"New Track\",\n    albumId: \"album-new\",\n    albumName: \"New Album\",\n",
)
replace_once(
    "src/services/music-preference/liked-discovery-expansion-shadow.test.ts",
    "  assert.equal(resolved.spotifyTrackId, \"track-doors\");\n",
    "  assert.equal(resolved.spotifyTrackId, \"track-doors\");\n  assert.equal(resolved.spotifyUri, \"spotify:track:track-doors\");\n  assert.equal(resolved.durationMs, 180000);\n  assert.equal(resolved.albumId, \"album-doors\");\n",
)
replace_once(
    "src/services/music-preference/liked-discovery-calibration-shadow.test.ts",
    "  assert.equal(report.readiness.status, \"READY_FOR_CONTROLLED_PILOT\");\n",
    "  assert.equal(report.readiness.status, \"READY_FOR_CONTROLLED_PILOT\");\n  assert.equal(report.pilotCandidates.length, 1);\n  assert.equal(report.pilotCandidates[0]?.artistName, \"Choldra\");\n  assert.equal(report.pilotCandidates[0]?.calibratedScore, 74.485);\n",
)

replace_once(
    "src/services/music-preference/liked-discovery-pilot-runtime.ts",
    "export function isLikedDiscoveryPilotCandidate(\n",
    "export function likedDiscoveryPilotTargetIds(\n  value: string | null | undefined = process.env.LIKED_DISCOVERY_PILOT_TARGET_IDS,\n): ReadonlySet<string> {\n  return parseTargetIds(value);\n}\n\nexport function isLikedDiscoveryPilotCandidate(\n",
)

replace_once(
    "src/services/music-discovery/external-discovery-runtime.ts",
    'import type { Candidate } from "@/services/playlist-planner";\n\n',
    'import type { Candidate } from "@/services/playlist-planner";\nimport {\n  mergeLikedPilotWithStandardDiscovery,\n  resolveLikedDiscoveryPilotRuntime,\n  type LikedDiscoveryPilotEvidence,\n} from "@/services/music-preference/liked-discovery-pilot-runtime";\n\n',
)
replace_once(
    "src/services/music-discovery/external-discovery-runtime.ts",
    "  providerFailureCount: number;\n};\n",
    "  providerFailureCount: number;\n  likedPilot: LikedDiscoveryPilotEvidence;\n};\n",
)
replace_once(
    "src/services/music-discovery/external-discovery-runtime.ts",
    "export async function resolveRuntimeExternalDiscovery(input: {\n  userId: string;\n  asOf: Date;\n}): Promise<RuntimeExternalDiscoveryResult> {\n",
    "export async function resolveRuntimeExternalDiscovery(input: {\n  userId: string;\n  asOf: Date;\n  userEmail?: string | null;\n  likedPilotTargetRuntimeEnabled?: boolean;\n}): Promise<RuntimeExternalDiscoveryResult> {\n",
)
replace_once(
    "src/services/music-discovery/external-discovery-runtime.ts",
    "  return {\n    discoveries,\n    evidence: {\n",
    "  const likedPilot = await resolveLikedDiscoveryPilotRuntime({\n    userId: input.userId,\n    userEmail: input.userEmail,\n    baseDiscoveryEnabled: input.likedPilotTargetRuntimeEnabled === true,\n    masterEnabled: process.env.LIKED_DISCOVERY_PILOT_ENABLED,\n    allowlistedEmails: process.env.LIKED_DISCOVERY_PILOT_USER_EMAILS,\n    allowlistedTargetIds: process.env.LIKED_DISCOVERY_PILOT_TARGET_IDS,\n  });\n  const merged = mergeLikedPilotWithStandardDiscovery({\n    standard: discoveries,\n    pilot: likedPilot.discovery,\n  });\n  const likedPilotEvidence = {\n    ...likedPilot.evidence,\n    duplicateSuppressedAgainstStandardDiscovery: merged.duplicateSuppressed,\n  };\n\n  return {\n    discoveries: merged.discoveries,\n    evidence: {\n",
)
replace_once(
    "src/services/music-discovery/external-discovery-runtime.ts",
    "      providerFailureCount: batch.failures.length,\n    },\n",
    "      providerFailureCount: batch.failures.length,\n      likedPilot: likedPilotEvidence,\n    },\n",
)

replace_once(
    "src/jobs/discovery-runtime.ts",
    'import { getDiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";\n',
    'import { getDiscoveryTrackIdentityEvidence } from "@/services/music-discovery/track-identity";\nimport {\n  discoveriesForPilotTarget,\n  likedDiscoveryPilotTargetIds,\n} from "@/services/music-preference/liked-discovery-pilot-runtime";\n',
)
replace_once(
    "src/jobs/discovery-runtime.ts",
    "    external = await resolveRuntimeExternalDiscovery({\n      userId: state.userId,\n      asOf: state.asOf,\n    });\n",
    "    external = await resolveRuntimeExternalDiscovery({\n      userId: state.userId,\n      asOf: state.asOf,\n      userEmail: state.userEmail,\n      likedPilotTargetRuntimeEnabled: targetScoped,\n    });\n",
)
replace_once(
    "src/jobs/discovery-runtime.ts",
    "  const targetById = new Map(\n    input.targets.map((target) => [target.targetPlaylistId, target] as const),\n  );\n\n  for (const planned of input.baseline.targets) {\n",
    "  const targetById = new Map(\n    input.targets.map((target) => [target.targetPlaylistId, target] as const),\n  );\n  const likedPilotTargets = likedDiscoveryPilotTargetIds();\n\n  for (const planned of input.baseline.targets) {\n",
)
replace_once(
    "src/jobs/discovery-runtime.ts",
    "    const applied = applyDiscoveryGate5H({\n      baseline: { targets: [current] },\n      targets: [target],\n      discoveries: remaining,\n",
    "    const targetDiscoveries = discoveriesForPilotTarget(\n      remaining,\n      planned.targetPlaylistId,\n      likedPilotTargets,\n    );\n    const applied = applyDiscoveryGate5H({\n      baseline: { targets: [current] },\n      targets: [target],\n      discoveries: targetDiscoveries,\n",
)
replace_once(
    "src/jobs/discovery-runtime.ts",
    "      discoveryCeiling: caps.externalDiscoveryCeiling,\n      applied: applied.applied,\n",
    "      discoveryCeiling: caps.externalDiscoveryCeiling,\n      likedPilotAllowed: likedPilotTargets.has(planned.targetPlaylistId),\n      likedPilotCandidateAvailable: targetDiscoveries.some(\n        (row) => row.pathLabel === \"LIKED_SIMILAR_EXPLORATORY\",\n      ),\n      applied: applied.applied,\n",
)

replace_once(
    "package.json",
    '    "liked:calibrate-shadow": "tsx scripts/report-liked-discovery-calibration-shadow.ts",\n',
    '    "liked:calibrate-shadow": "tsx scripts/report-liked-discovery-calibration-shadow.ts",\n    "liked:pilot-runtime": "tsx scripts/report-liked-discovery-pilot-runtime.ts",\n',
)

final_workflow = '''name: LIKED-01 validation

on:
  pull_request:
    paths:
      - "prisma/**"
      - "src/services/music-preference/**"
      - "src/services/music-discovery/**"
      - "src/jobs/discovery-runtime.ts"
      - "scripts/report-liked-track-affinity.ts"
      - "scripts/report-liked-artist-similarity.ts"
      - "scripts/report-liked-shadow-discovery.ts"
      - "scripts/report-liked-artist-similarity-backfill.ts"
      - "scripts/report-liked-discovery-expansion-shadow.ts"
      - "scripts/report-liked-discovery-calibration-shadow.ts"
      - "scripts/report-liked-discovery-pilot-runtime.ts"
      - "package.json"
      - ".github/workflows/liked-01-validation.yml"
  push:
    branches:
      - main
    paths:
      - "prisma/**"
      - "src/services/music-preference/**"
      - "src/services/music-discovery/**"
      - "src/jobs/discovery-runtime.ts"
      - "scripts/report-liked-track-affinity.ts"
      - "scripts/report-liked-artist-similarity.ts"
      - "scripts/report-liked-shadow-discovery.ts"
      - "scripts/report-liked-artist-similarity-backfill.ts"
      - "scripts/report-liked-discovery-expansion-shadow.ts"
      - "scripts/report-liked-discovery-calibration-shadow.ts"
      - "scripts/report-liked-discovery-pilot-runtime.ts"
      - "package.json"
      - ".github/workflows/liked-01-validation.yml"

jobs:
  validate:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: sonoriza_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres -d sonoriza_test"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    env:
      DATABASE_URL: postgresql://postgres:postgres@localhost:5432/sonoriza_test?schema=public
      AUTH_SECRET: test-secret-for-ci-only
      AUTH_URL: http://localhost:3000
      SPOTIFY_CLIENT_ID: test
      SPOTIFY_CLIENT_SECRET: test
      GOOGLE_CLIENT_ID: test
      GOOGLE_CLIENT_SECRET: test

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.19.0
          cache: npm
      - run: npm ci
      - run: npx prisma validate
      - run: npx prisma migrate deploy
      - run: npm run test:music-preference
      - run: npm run typecheck
      - run: npm run build
'''
Path(".github/workflows/liked-01-validation.yml").write_text(final_workflow)
Path("scripts/patch-liked-gate6c.py").unlink()
