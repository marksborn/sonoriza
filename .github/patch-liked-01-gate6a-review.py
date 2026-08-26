from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one marker, got {count}")
    return text.replace(old, new, 1)


service = Path("src/services/music-preference/liked-discovery-expansion-shadow.ts")
text = service.read_text()

text = replace_once(
    text,
    '''export type LikedExpansionAggregate = {\n  candidateKey: string;\n  artistName: string;\n  normalizedArtistName: string;''',
    '''export type LikedExpansionSimilaritySignal = LikedSimilaritySignal & {\n  candidateArtistMbid?: string | null;\n};\n\nexport type LikedExpansionAggregate = {\n  candidateKey: string;\n  candidateArtistMbid: string | null;\n  artistName: string;\n  normalizedArtistName: string;''',
    "aggregate type",
)
text = replace_once(
    text,
    '''    notFound: number;\n    failures: Array<{ candidateKey: string; error: string }>;''',
    '''    notFound: number;\n    rejectedResolvedDirectArtists: number;\n    failures: Array<{ candidateKey: string; error: string }>;''',
    "resolution metric type",
)
text = replace_once(
    text,
    '''type MutableAggregate = {\n  candidateKeys: Set<string>;\n  artistName: string;''',
    '''type MutableAggregate = {\n  candidateKeys: Set<string>;\n  candidateArtistMbids: Set<string>;\n  artistName: string;''',
    "mutable aggregate",
)
text = replace_once(
    text,
    '''        candidateKey: true,\n        candidateArtistName: true,\n        sourceSpotifyArtistId: true,''',
    '''        candidateKey: true,\n        candidateArtistName: true,\n        candidateArtistMbid: true,\n        sourceSpotifyArtistId: true,''',
    "edge select mbid",
)
text = replace_once(
    text,
    '''  const probes = ranked.rows.slice(\n    0,\n    LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.historyProbeLimit,\n  );\n  const history = await getArtistHistoryCounts(\n    userId,\n    probes.map((row) => row.artistName),\n  );''',
    '''  // Build the history probe from the full ranked graph with seed round-robin\n  // diversity before truncation. Otherwise one prolific seed can consume the\n  // whole probe window and hide strong candidates from other affinity paths.\n  const probes = buildDiverseHistoryProbe(\n    ranked.rows,\n    LIKED_DISCOVERY_EXPANSION_SHADOW_POLICY.historyProbeLimit,\n  );\n  const history = await getArtistHistoryCounts(userId, probes);''',
    "diverse probes",
)
text = replace_once(
    text,
    '''  const spotify = await SpotifyCatalogSearchClient.forUser(userId);\n  const baselineTrackIds = new Set(''',
    '''  const spotify = await SpotifyCatalogSearchClient.forUser(userId);\n  const directSpotifyArtistIds = new Set(\n    directAffinities.map((row) => row.spotifyArtistId),\n  );\n  const baselineTrackIds = new Set(''',
    "direct ids",
)
text = replace_once(
    text,
    '''  let ambiguous = 0;\n  let notFound = 0;''',
    '''  let ambiguous = 0;\n  let notFound = 0;\n  let rejectedResolvedDirectArtists = 0;''',
    "resolved direct counter",
)
text = replace_once(
    text,
    '''      if (!resolution.spotifyArtist || !resolution.spotifyTrack) continue;\n      if (baselineTrackIds.has(resolution.spotifyTrack.id)) continue;''',
    '''      if (!resolution.spotifyArtist || !resolution.spotifyTrack) continue;\n      // Name aliases are only an acquisition hint. Canonical Spotify identity is\n      // authoritative after resolution, so a directly liked artist can never be\n      // reintroduced as exploratory under another spelling (for example The X/X).\n      if (\n        isResolvedDirectAffinityArtist(\n          resolution.spotifyArtist.id,\n          directSpotifyArtistIds,\n        )\n      ) {\n        rejectedResolvedDirectArtists += 1;\n        continue;\n      }\n      if (baselineTrackIds.has(resolution.spotifyTrack.id)) continue;''',
    "post-resolution direct guard",
)
text = replace_once(
    text,
    '''      ambiguous,\n      notFound,\n      failures,''',
    '''      ambiguous,\n      notFound,\n      rejectedResolvedDirectArtists,\n      failures,''',
    "return resolved direct metric",
)
text = replace_once(
    text,
    '''  similarityEdges: LikedSimilaritySignal[];''',
    '''  similarityEdges: LikedExpansionSimilaritySignal[];''',
    "extended edge input",
)
text = replace_once(
    text,
    '''    const current = aggregates.get(key) ?? {\n      candidateKeys: new Set<string>(),\n      artistName: edge.candidateArtistName,''',
    '''    const current = aggregates.get(key) ?? {\n      candidateKeys: new Set<string>(),\n      candidateArtistMbids: new Set<string>(),\n      artistName: edge.candidateArtistName,''',
    "mbid aggregate init",
)
text = replace_once(
    text,
    '''    current.candidateKeys.add(edge.candidateKey);\n    current.maxSimilarity = Math.max(current.maxSimilarity, edge.similarity);''',
    '''    current.candidateKeys.add(edge.candidateKey);\n    if (edge.candidateArtistMbid?.trim()) {\n      current.candidateArtistMbids.add(edge.candidateArtistMbid.trim().toLowerCase());\n    }\n    current.maxSimilarity = Math.max(current.maxSimilarity, edge.similarity);''',
    "mbid aggregate collect",
)
text = replace_once(
    text,
    '''    if (aggregate.candidateKeys.size !== 1) {\n      ambiguousSimilarityArtistNames += 1;\n      continue;\n    }''',
    '''    if (\n      aggregate.candidateKeys.size !== 1 ||\n      aggregate.candidateArtistMbids.size > 1\n    ) {\n      ambiguousSimilarityArtistNames += 1;\n      continue;\n    }''',
    "mbid ambiguity",
)
text = replace_once(
    text,
    '''    rows.push({\n      candidateKey,\n      artistName: aggregate.artistName,''',
    '''    rows.push({\n      candidateKey,\n      candidateArtistMbid:\n        aggregate.candidateArtistMbids.size === 1\n          ? [...aggregate.candidateArtistMbids][0]!\n          : null,\n      artistName: aggregate.artistName,''',
    "aggregate output mbid",
)

old_history = '''async function getArtistHistoryCounts(\n  userId: string,\n  artistNames: string[],\n): Promise<Map<string, number>> {\n  if (artistNames.length === 0) return new Map();\n  const rows = await prisma.trackListeningEvent.groupBy({\n    by: ["artistName"],\n    where: {\n      userId,\n      artistName: { in: artistNames, mode: "insensitive" },\n    },\n    _count: { _all: true },\n  });\n  return new Map(\n    rows\n      .filter((row) => Boolean(row.artistName))\n      .map((row) => [normalized(row.artistName ?? ""), row._count._all] as const),\n  );\n}\n'''
new_history = '''export function buildDiverseHistoryProbe(\n  rows: LikedExpansionAggregate[],\n  limit: number,\n): LikedExpansionAggregate[] {\n  if (!Number.isInteger(limit) || limit < 1) {\n    throw new Error("history probe limit must be a positive integer");\n  }\n  const groups = new Map<string, LikedExpansionAggregate[]>();\n  for (const row of rows) {\n    const seedId = row.dominantSeed.spotifyArtistId;\n    const group = groups.get(seedId) ?? [];\n    group.push(row);\n    groups.set(seedId, group);\n  }\n  const queues = [...groups.values()].map((group) => [...group]);\n  const selected: LikedExpansionAggregate[] = [];\n  while (selected.length < limit) {\n    let progressed = false;\n    for (const queue of queues) {\n      const row = queue.shift();\n      if (!row) continue;\n      selected.push(row);\n      progressed = true;\n      if (selected.length >= limit) break;\n    }\n    if (!progressed) break;\n  }\n  return selected;\n}\n\nexport function buildLikedExpansionHistoryCounts(\n  candidates: LikedExpansionAggregate[],\n  historyRows: Array<{ artistName: string; artistMbid: string | null; count: number }>,\n): Map<string, number> {\n  const byName = new Map<string, number>();\n  const byMbid = new Map<string, number>();\n  for (const row of historyRows) {\n    const name = normalized(row.artistName);\n    byName.set(name, (byName.get(name) ?? 0) + row.count);\n    if (row.artistMbid?.trim()) {\n      const mbid = row.artistMbid.trim().toLowerCase();\n      byMbid.set(mbid, (byMbid.get(mbid) ?? 0) + row.count);\n    }\n  }\n  return new Map(\n    candidates.map((candidate) => {\n      const nameCount = byName.get(candidate.normalizedArtistName) ?? 0;\n      const mbidCount = candidate.candidateArtistMbid\n        ? byMbid.get(candidate.candidateArtistMbid.toLowerCase()) ?? 0\n        : 0;\n      return [candidate.normalizedArtistName, Math.max(nameCount, mbidCount)] as const;\n    }),\n  );\n}\n\nasync function getArtistHistoryCounts(\n  userId: string,\n  candidates: LikedExpansionAggregate[],\n): Promise<Map<string, number>> {\n  if (candidates.length === 0) return new Map();\n  const artistNames = [...new Set(candidates.map((row) => row.artistName))];\n  const artistMbids = [\n    ...new Set(\n      candidates\n        .map((row) => row.candidateArtistMbid)\n        .filter((value): value is string => Boolean(value)),\n    ),\n  ];\n  const orFilters = [\n    { artistName: { in: artistNames, mode: "insensitive" as const } },\n    ...(artistMbids.length > 0 ? [{ artistMbid: { in: artistMbids } }] : []),\n  ];\n  const rows = await prisma.trackListeningEvent.groupBy({\n    by: ["artistName", "artistMbid"],\n    where: { userId, OR: orFilters },\n    _count: { _all: true },\n  });\n  return buildLikedExpansionHistoryCounts(\n    candidates,\n    rows.map((row) => ({\n      artistName: row.artistName,\n      artistMbid: row.artistMbid,\n      count: row._count._all,\n    })),\n  );\n}\n\nexport function isResolvedDirectAffinityArtist(\n  spotifyArtistId: string,\n  directSpotifyArtistIds: ReadonlySet<string>,\n): boolean {\n  return directSpotifyArtistIds.has(spotifyArtistId);\n}\n'''
text = replace_once(text, old_history, new_history, "history functions")
service.write_text(text)

cli = Path("scripts/report-liked-discovery-expansion-shadow.ts")
cli_text = cli.read_text()
cli_text = replace_once(
    cli_text,
    '''  p("  not found:", report.resolution.notFound);\n  p("  provider failures:", report.resolution.failures.length);''',
    '''  p("  not found:", report.resolution.notFound);\n  p(\n    "  rejected resolved direct artists:",\n    report.resolution.rejectedResolvedDirectArtists,\n  );\n  p("  provider failures:", report.resolution.failures.length);''',
    "cli resolved direct metric",
)
cli.write_text(cli_text)

test_file = Path("src/services/music-preference/liked-discovery-expansion-shadow.test.ts")
tests = test_file.read_text()
tests = replace_once(
    tests,
    '''import type { LikedDirectAffinitySignal, LikedSimilaritySignal } from "./liked-shadow-discovery";\nimport {\n  buildLikedExpandedDiscoveryTop,''',
    '''import type { LikedDirectAffinitySignal } from "./liked-shadow-discovery";\nimport {\n  buildDiverseHistoryProbe,\n  buildLikedExpandedDiscoveryTop,\n  buildLikedExpansionHistoryCounts,\n  isResolvedDirectAffinityArtist,''',
    "test imports",
)
tests = replace_once(
    tests,
    '''  selectLikedExpansionResolutionCandidates,\n  type LikedExpansionResolvedCandidate,\n} from "./liked-discovery-expansion-shadow";''',
    '''  selectLikedExpansionResolutionCandidates,\n  type LikedExpansionResolvedCandidate,\n  type LikedExpansionSimilaritySignal,\n} from "./liked-discovery-expansion-shadow";''',
    "test type imports",
)
tests = replace_once(
    tests,
    '''  similarity: number,\n): LikedSimilaritySignal {\n  return {\n    candidateKey,\n    candidateArtistName,''',
    '''  similarity: number,\n  candidateArtistMbid: string | null = null,\n): LikedExpansionSimilaritySignal {\n  return {\n    candidateKey,\n    candidateArtistName,\n    candidateArtistMbid,''',
    "edge helper mbid",
)

marker = '''test("expanded discovery can introduce resolved related artists without mutating current pool rows", () => {'''
block = '''test("persisted candidate MBID rejects renamed historical artists before Spotify resolution", () => {\n  const report = rankLikedExpansionAggregates({\n    directAffinities: direct,\n    similarityEdges: [\n      edge("mbid:artist-1", "Current Alias", "seed-a", "Seed A", 0.9, "ARTIST-MBID-1"),\n    ],\n  });\n  const candidate = report.rows[0]!;\n  assert.equal(candidate.candidateArtistMbid, "artist-mbid-1");\n\n  const history = buildLikedExpansionHistoryCounts([candidate], [\n    { artistName: "Old Artist Name", artistMbid: "artist-mbid-1", count: 8 },\n  ]);\n  const selected = selectLikedExpansionResolutionCandidates({\n    rows: [candidate],\n    historyByNormalizedArtistName: history,\n    budget: 1,\n    maxPerDominantSeed: 1,\n  });\n\n  assert.equal(history.get("current alias"), 8);\n  assert.equal(selected.rejectedKnownHistoryArtistNames, 1);\n  assert.equal(selected.selected.length, 0);\n});\n\ntest("history probe round-robin preserves seed diversity before truncation", () => {\n  const report = rankLikedExpansionAggregates({\n    directAffinities: direct,\n    similarityEdges: [\n      edge("candidate:a1", "A1", "seed-a", "Seed A", 1),\n      edge("candidate:a2", "A2", "seed-a", "Seed A", 0.99),\n      edge("candidate:a3", "A3", "seed-a", "Seed A", 0.98),\n      edge("candidate:a4", "A4", "seed-a", "Seed A", 0.97),\n      edge("candidate:b1", "B1", "seed-b", "Seed B", 0.7),\n    ],\n  });\n  const probes = buildDiverseHistoryProbe(report.rows, 3);\n\n  assert.equal(probes.length, 3);\n  assert.ok(probes.some((row) => row.dominantSeed.spotifyArtistId === "seed-b"));\n  assert.equal(\n    probes.filter((row) => row.dominantSeed.spotifyArtistId === "seed-a").length,\n    2,\n  );\n});\n\ntest("resolved Spotify identity cannot re-enter a directly liked artist through an alias", () => {\n  const directIds = new Set(["spotify-direct"]);\n  assert.equal(isResolvedDirectAffinityArtist("spotify-direct", directIds), true);\n  assert.equal(isResolvedDirectAffinityArtist("spotify-new", directIds), false);\n});\n\n'''
if block.strip() not in tests:
    if marker not in tests:
        raise SystemExit("test insertion marker not found")
    tests = tests.replace(marker, block + marker, 1)

tests = replace_once(
    tests,
    '''  const expansion: LikedExpansionResolvedCandidate = {\n    candidateKey: "candidate:new",\n    artistName: "New Artist",''',
    '''  const expansion: LikedExpansionResolvedCandidate = {\n    candidateKey: "candidate:new",\n    candidateArtistMbid: null,\n    artistName: "New Artist",''',
    "resolved candidate mbid",
)
test_file.write_text(tests)
