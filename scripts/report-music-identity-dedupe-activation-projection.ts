import { createHash } from "node:crypto";

process.env.PRISMA_TRANSACTION_TIMEOUT_MS ??= "30000";

const DEFAULT_PROVIDER_BUDGET = 25;
let disconnectPrisma: (() => Promise<void>) | null = null;

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function providerBudget(): number {
  const raw = argValue("provider-budget");
  if (raw === null) return DEFAULT_PROVIDER_BUDGET;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("--provider-budget must be an integer between 0 and 100");
  }
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} is not a string array`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function main() {
  const userId = argValue("user");
  const targetPlaylistId = argValue("target");
  const refreshEvidence = hasArg("refresh-evidence");
  const write = hasArg("write");

  if (!userId || !targetPlaylistId) {
    throw new Error(
      "Uso: npx tsx scripts/report-music-identity-dedupe-activation-projection.ts --user=<id> --target=<id> [--refresh-evidence] [--provider-budget=25] [--write] [--json]",
    );
  }
  if (write && !refreshEvidence) {
    throw new Error(
      "Gate 4E0 --write requires --refresh-evidence. Provider-free preview never mutates persisted evidence.",
    );
  }

  const [
    { CanonicalDedupeProjectionStatus },
    { prisma },
    activation,
    { runMusicIdentityCanonicalRepresentativeSelectionShadow },
    { runMusicIdentityCanonicalConsumerDedupeShadow },
    { resolveTargetSourceScope },
    { SpotifyCatalogReadSession },
    { SpotifyCatalogSearchClient },
  ] = await Promise.all([
    import("@prisma/client"),
    import("@/lib/prisma"),
    import("@/services/music-identity/canonical-dedupe-activation-projection"),
    import("@/services/music-identity/canonical-representative-selection-shadow"),
    import("@/services/music-identity/canonical-consumer-dedupe-shadow"),
    import("@/services/target-source-scope"),
    import("@/services/spotify/catalog-read-session"),
    import("@/services/spotify/catalog-search"),
  ]);
  disconnectPrisma = () => prisma.$disconnect();

  let projection: ReturnType<typeof activation.buildGate4E0ActivationProjection>;
  let persistence: Awaited<
    ReturnType<typeof activation.persistGate4E0ActivationProjection>
  > | null = null;
  let providerReadSession: ReturnType<
    InstanceType<typeof SpotifyCatalogReadSession>["getMetrics"]
  > | null = null;
  let evidenceSource: "PERSISTED_READY" | "EXPLICIT_GATE4D_REFRESH";

  if (!refreshEvidence) {
    evidenceSource = "PERSISTED_READY";
    const existing = await prisma.canonicalDedupeActivationProjection.findFirst({
      where: {
        userId,
        targetPlaylistId,
        policy: activation.GATE4E0_POLICY,
        status: CanonicalDedupeProjectionStatus.READY,
      },
      orderBy: { version: "desc" },
      include: { components: { orderBy: { componentId: "asc" } } },
    });
    if (!existing) {
      throw new Error(
        "Gate 4E0 provider-free preview requires a durable READY projection. No READY evidence exists; run an explicit --refresh-evidence checkpoint after provider backoff is clear.",
      );
    }

    const [target, sources] = await Promise.all([
      prisma.targetPlaylist.findFirst({
        where: { id: targetPlaylistId, userId, enabled: true },
        select: {
          id: true,
          name: true,
          sourceScopeMode: true,
          sourceSelections: { select: { sourcePlaylistId: true } },
        },
      }),
      prisma.sourcePlaylist.findMany({
        where: { userId },
        select: { id: true, enabled: true },
      }),
    ]);
    if (!target) {
      throw new Error("durable READY projection target is missing or disabled");
    }

    const effectiveSourceIds = stringArray(
      existing.effectiveSourceIds,
      "persisted effectiveSourceIds",
    );
    const currentScope = resolveTargetSourceScope({
      targetPlaylistId: target.id,
      targetName: target.name,
      sourceScopeMode: target.sourceScopeMode,
      selectedSourceIds: target.sourceSelections.map((row) => row.sourcePlaylistId),
      sources,
    });
    if (!sameStrings(currentScope.effectiveSourceIds, effectiveSourceIds)) {
      throw new Error(
        "durable READY projection is stale: target source scope changed; explicit --refresh-evidence required",
      );
    }
    if (hashJson(currentScope.effectiveSourceIds) !== existing.sourceScopeFingerprint) {
      throw new Error(
        "durable READY projection is stale: source-scope fingerprint changed; explicit --refresh-evidence required",
      );
    }
    if (existing.components.length === 0) {
      throw new Error("durable READY projection has no components");
    }

    const components = existing.components.map((component) => {
      const memberProviderTrackIds = stringArray(
        component.memberProviderTrackIds,
        `component ${component.componentId} memberProviderTrackIds`,
      );
      if (
        memberProviderTrackIds.length < 2 ||
        !memberProviderTrackIds.includes(component.representativeProviderTrackId) ||
        component.containsExcludedPreference
      ) {
        throw new Error(`durable READY component is invalid: ${component.componentId}`);
      }
      return {
        componentId: component.componentId,
        memberProviderTrackIds,
        representativeProviderTrackId: component.representativeProviderTrackId,
        preferenceState: component.preferenceState,
        containsExcludedPreference: false as const,
      };
    });

    projection = {
      gate: "4E0",
      mode: "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_READY",
      userId: existing.userId,
      targetPlaylistId: existing.targetPlaylistId,
      targetName: target.name,
      policy: activation.GATE4E0_POLICY,
      gate4cSnapshotFingerprint: existing.gate4cSnapshotFingerprint,
      gate4dOrderedInputFingerprint: existing.gate4dOrderedInputFingerprint,
      sourceScopeFingerprint: existing.sourceScopeFingerprint,
      effectiveSourceIds,
      projectionFingerprint: existing.projectionFingerprint,
      validatedAt: existing.validatedAt,
      componentCount: components.length,
      hypotheticalDrops: components.reduce(
        (sum, component) => sum + component.memberProviderTrackIds.length - 1,
        0,
      ),
      components,
      authority: {
        persistenceOnly: true,
        plannerInfluence: false,
        consumerActivation: false,
        identityWrites: false,
        canonicalWrites: false,
        providerRefReassociation: false,
        preferenceWrites: false,
        sourceCacheWrites: false,
        spotifyPlaylistWrites: false,
        providerCallsInPlannerHotPath: false,
      },
    };
  } else {
    evidenceSource = "EXPLICIT_GATE4D_REFRESH";
    const readSession = new SpotifyCatalogReadSession(userId, {
      requestBudget: providerBudget(),
    });
    const provider = await SpotifyCatalogSearchClient.forUser(userId, {
      readSession,
    });
    const gate4d = await runMusicIdentityCanonicalRepresentativeSelectionShadow(userId, {
      gate4cRunner: (requestedUserId) =>
        runMusicIdentityCanonicalConsumerDedupeShadow(requestedUserId, { provider }),
    });
    providerReadSession = readSession.getMetrics();

    if (gate4d.mode !== "SHADOW_CANONICAL_REPRESENTATIVE_SELECTION_READ_ONLY") {
      throw new Error(
        `Explicit Gate 4D refresh abstained: reason=${gate4d.abstentionReason}; detail=${gate4d.detail ?? "-"}; providerReadSession=${JSON.stringify(providerReadSession)}`,
      );
    }

    projection = activation.buildGate4E0ActivationProjection(gate4d, targetPlaylistId);
    persistence = write
      ? await activation.persistGate4E0ActivationProjection(projection)
      : null;
  }

  const output = {
    gate: "4E0" as const,
    mode: write
      ? "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_PERSISTED"
      : refreshEvidence
        ? "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_REFRESH_PREVIEW"
        : "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_DURABLE_PREVIEW",
    write,
    refreshEvidence,
    evidenceSource,
    providerReadSession,
    projection,
    persistence,
    authority: {
      providerCallsPossible: refreshEvidence,
      providerCallsInDefaultPreview: false,
      plannerInfluence: false,
      consumerActivation: false,
      spotifyPlaylistWrites: false,
      identityWrites: false,
      canonicalWrites: false,
      providerRefReassociation: false,
      projectionPersistenceMayWrite: write,
    },
  };

  if (hasArg("json")) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Gate:                         ${output.gate}`);
  console.log(`Mode:                         ${output.mode}`);
  console.log(`Evidence source:              ${output.evidenceSource}`);
  console.log(`Provider refresh requested:  ${output.refreshEvidence}`);
  console.log(`User:                         ${projection.userId}`);
  console.log(`Target:                       ${projection.targetName} (${projection.targetPlaylistId})`);
  console.log(`Policy:                       ${projection.policy}`);
  console.log(`Components:                   ${projection.componentCount}`);
  console.log(`Hypothetical drops:           ${projection.hypotheticalDrops}`);
  console.log(`Projection fingerprint:       ${projection.projectionFingerprint}`);
  console.log(`Planner influence:            ${output.authority.plannerInfluence}`);
  console.log(`Consumer activation:          ${output.authority.consumerActivation}`);
  console.log(`Projection persisted:         ${Boolean(persistence)}`);
  if (providerReadSession) {
    console.log(`Provider request budget:      ${providerReadSession.requestBudget}`);
    console.log(`Provider network requests:    ${providerReadSession.networkRequests}`);
    console.log(`Provider cache hits:          ${providerReadSession.cacheHits}`);
    console.log(`Provider cache misses:        ${providerReadSession.cacheMisses}`);
    console.log(`Provider cache writes:        ${providerReadSession.cacheWrites}`);
  }
  if (persistence) {
    console.log(`Projection id:                ${persistence.projectionId}`);
    console.log(`Projection version:           ${persistence.version}`);
    console.log(`Projection status:            ${persistence.status}`);
    console.log(`Created:                      ${persistence.created}`);
    console.log(`Revalidated:                  ${persistence.revalidated}`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma?.();
  });
