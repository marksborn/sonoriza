/**
 * FEATURE-PARITY-01 / Gate A — read-only operational inventory.
 * Usage (Node >= 20; from application root):
 *   SONORIZA_AUDIT_EMAIL='account@example.com' node --env-file=.env scripts/report-feature-parity-inventory.mjs
 *
 * Never publishes user/Spotify/target IDs, email addresses or allowlist contents.
 * Prints target names, so keep its output private and redact before public issues.
 * Only Prisma findFirst/findMany calls; no generation, scheduler or provider writes.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function asStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}
function extractRuntime(summary) {
  const keys = [
    'music07ExposureEligibility',
    'music06PlannerInfluence',
    'discoveryRuntime',
    'targetDiscoveryRuntime',
    'likedTrackSourceShadow',
    'playbackReserveRuntime',
    'podcast09ContinuationShadow',
    'podcast06PlannerShadow',
    'musicIdentityCanonicalDedupe',
    'podcast08ActiveGate',
    'podcast08Shadow',
    'podcast08PrewriteGate',
    'podcast08EphemeralPreview',
  ];
  const result = {};
  for (const key of keys) {
    const data = record(summary[key]);
    const compact = {};
    for (const field of ['configuredMode', 'requestedMode', 'effectiveMode', 'mode', 'status', 'reason', 'activationReason', 'plannerInfluence', 'enabled']) {
      const value = data[field];
      if (['string', 'boolean', 'number'].includes(typeof value)) compact[field] = value;
    }
    if (Object.keys(compact).length) result[key] = compact;
    else if (summary[key] !== undefined && summary[key] !== null) result[key] = { present: true, detailedEffectiveState: 'REVIEW_IN_PRIVATE_RUN_SUMMARY' };
  }
  return result;
}
function rolloutEnv() {
  const modes = [
    'MUSIC_07_ELIGIBILITY_MODE', 'MUSIC_07_ELIGIBILITY_SCOPE',
    'MUSIC_IDENTITY_GATE4E1_MODE', 'PLAYBACK_RESERVE_RUNTIME_MODE',
    'PODCAST_09_PLANNER_MODE', 'PODCAST08_ACTIVE_MODE',
    'PODCAST08_SHADOW_MODE', 'PODCAST08_DURATION_EDITOR_ENABLED',
    'DISCOVER_DEST_RUNTIME_ENABLED', 'LIKED_TRACK_OPERATIONAL_SYNC_MODE',
  ];
  const lists = [
    'MUSIC_07_ELIGIBILITY_EMAIL_ALLOWLIST', 'MUSIC_07_ELIGIBILITY_TARGET_IDS',
    'MUSIC_IDENTITY_GATE4E1_ALLOWLIST', 'PLAYBACK_RESERVE_ACTIVE_TARGET_IDS',
    'PODCAST_09_SHADOW_TARGET_ALLOWLIST', 'PODCAST_09_ACTIVE_ALLOWLIST',
    'PODCAST_09_REAL_ACTIVE_ALLOWLIST', 'PODCAST_09_SCHEDULED_ACTIVE_ALLOWLIST',
    'PODCAST08_ACTIVE_TARGET_IDS', 'DISCOVER_DEST_RUNTIME_USER_EMAILS',
  ];
  return {
    requestedModes: Object.fromEntries(modes.map((key) => [key, process.env[key]?.trim() || 'UNSET'])),
    allowlistsConfigured: Object.fromEntries(lists.map((key) => [key, Boolean(process.env[key]?.trim())])),
  };
}

async function main() {
  const email = process.env.SONORIZA_AUDIT_EMAIL?.trim();
  if (!email) throw new Error('Define SONORIZA_AUDIT_EMAIL to scope the read-only report to one account.');
  const user = await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { id: true } });
  if (!user) throw new Error('Account not found; no data was changed.');
  const [targets, sources, runs] = await Promise.all([
    prisma.targetPlaylist.findMany({
      where: { userId: user.id }, orderBy: [{ priority: 'asc' }, { name: 'asc' }],
      select: {
        id: true, name: true, enabled: true, priority: true, spotifyPlaylistId: true,
        compositionMode: true, musicOrderMode: true, sequencePattern: true,
        podcastDurationSlotBands: true, podcastPercent: true,
        podcastEpisodeMaxDurationMode: true, durationMode: true, calendarMode: true,
        calendarDurationStrategy: true, emptyCalendarBehavior: true,
        updatePolicy: true, dailyScheduleMinutes: true, scheduleTimezone: true,
        discoveryEnabled: true, discoveryIntensity: true,
        discoveryFamiliarEnabled: true, discoveryRediscoveryEnabled: true,
        discoveryNoveltyEnabled: true, discoveryReleasesEnabled: true,
        sourceScopeMode: true, sharingPolicy: true,
        sourceSelections: { select: { sourcePlaylistId: true } },
      },
    }),
    prisma.sourcePlaylist.findMany({ where: { userId: user.id }, select: { id: true, kind: true, enabled: true } }),
    prisma.generationRun.findMany({
      where: { userId: user.id }, orderBy: { startedAt: 'desc' }, take: 24,
      select: { trigger: true, simulation: true, status: true, startedAt: true, summary: true },
    }),
  ]);
  const bySource = new Map(sources.map((s) => [s.id, s]));
  const targetsView = targets.map((t) => {
    const sourceIds = t.sourceScopeMode === 'SELECTED_ONLY'
      ? t.sourceSelections.map((x) => x.sourcePlaylistId)
      : sources.filter((s) => s.enabled).map((s) => s.id);
    const selectedSources = sourceIds.map((id) => bySource.get(id)).filter(Boolean);
    const activeSources = selectedSources.filter((s) => s.enabled);
    const sequence = asStrings(t.sequencePattern);
    const bands = asStrings(t.podcastDurationSlotBands);
    const podcastSlots = t.compositionMode === 'SEQUENCE' ? sequence.filter((s) => s === 'PODCAST').length : (t.podcastPercent > 0 ? 1 : 0);
    return {
      name: t.name, enabled: t.enabled, generationPriority: t.priority,
      linkedToSpotify: Boolean(t.spotifyPlaylistId),
      composition: t.compositionMode,
      sequence: t.compositionMode === 'SEQUENCE' ? sequence : undefined,
      podcastDurationBands: t.compositionMode === 'SEQUENCE' ? (bands.length === sequence.length ? bands : 'LEGACY_ANY_OR_UNALIGNED') : 'NOT_APPLICABLE',
      podcastContentEligible: podcastSlots > 0 && activeSources.some((s) => s.kind === 'PODCAST'),
      podcastSourceCount: activeSources.filter((s) => s.kind === 'PODCAST').length,
      musicSourceCount: activeSources.filter((s) => s.kind === 'MUSIC').length,
      sourceScope: t.sourceScopeMode,
      selectedSourceCount: selectedSources.length,
      musicOrder: t.musicOrderMode,
      updatePolicy: t.updatePolicy, scheduleConfigured: t.dailyScheduleMinutes !== null && Boolean(t.scheduleTimezone),
      durationMode: t.durationMode, calendarMode: t.calendarMode,
      calendarDurationStrategy: t.calendarDurationStrategy,
      emptyCalendarBehavior: t.emptyCalendarBehavior,
      maxPodcastDurationMode: t.podcastEpisodeMaxDurationMode,
      targetSharingPolicy: t.sharingPolicy,
      discovery: {
        enabled: t.discoveryEnabled, intensity: t.discoveryIntensity,
        familiar: t.discoveryFamiliarEnabled, rediscovery: t.discoveryRediscoveryEnabled,
        novelty: t.discoveryNoveltyEnabled, releases: t.discoveryReleasesEnabled,
      },
      capabilities: {
        podcastSequence: t.compositionMode === 'SEQUENCE' && podcastSlots > 0,
        podcastDurationBands: t.compositionMode === 'SEQUENCE' && podcastSlots > 0,
        calendar: t.durationMode === 'CALENDAR',
        scheduledMaintenance: t.enabled && t.updatePolicy !== 'MANUAL',
        reserveMaintenancePolicy: t.updatePolicy === 'KEEP_FILLED' || t.updatePolicy === 'REBUILD_DAILY',
      },
    };
  });
  // Do not attribute a global/multi-target run to any one playlist.
  const runsView = runs.map((run) => {
    const summary = record(run.summary);
    const scope = asStrings(summary.resolvedTargetIds).length
      ? asStrings(summary.resolvedTargetIds) : asStrings(summary.targetScope);
    const names = scope.map((id) => targets.find((t) => t.id === id)?.name).filter(Boolean);
    return {
      startedAt: run.startedAt.toISOString(), trigger: run.trigger,
      simulation: run.simulation, status: run.status,
      targetScope: scope.length === 1 ? names[0] ?? 'ONE_TARGET_UNKNOWN' : scope.length > 1 ? `MULTI_TARGET_${scope.length}` : 'NOT_PROVEN_SINGLE_TARGET',
      effectiveRuntimeEvidence: extractRuntime(summary),
    };
  });
  const output = {
    audit: 'FEATURE-PARITY-01-GATE-A', timestamp: new Date().toISOString(),
    evidenceLevel: 'READ_ONLY_LIVE_DB_AND_ENV_WITH_RECENT_RUN_SUMMARIES',
    warnings: [
      'Configured environment variables do not prove an ACTIVE runtime.',
      'Recent run summaries may have incomplete target scopes; never attribute multi-target evidence to one target.',
      'Disabled targets remain disabled; no simulation or provider API call was performed.',
      'Playlist names are private: redact before posting to any public issue or pull request.',
    ],
    counts: { targets: targets.length, enabledTargets: targets.filter((t) => t.enabled).length, recentRuns: runs.length },
    rolloutConfiguration: rolloutEnv(), targets: targetsView, recentRuns: runsView,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

try {
  await main();
} catch (error) {
  process.stderr.write(`Read-only inventory failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}