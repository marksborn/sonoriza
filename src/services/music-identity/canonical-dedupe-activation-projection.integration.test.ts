import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import { CanonicalDedupeProjectionStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  GATE4E0_POLICY,
  persistGate4E0ActivationProjection,
  type Gate4E0ActivationProjection,
} from "./canonical-dedupe-activation-projection";

const dbEnabled = process.env.MUSIC_IDENTITY_DB_TEST === "1";

test(
  "Gate 4E0 persistence is versioned, idempotent and stales the previous READY projection",
  { skip: !dbEnabled },
  async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const userId = `gate4e0-user-${suffix}`;
    const targetPlaylistId = `gate4e0-target-${suffix}`;
    const sourceA = `gate4e0-source-a-${suffix}`;
    const sourceB = `gate4e0-source-b-${suffix}`;
    const sourceC = `gate4e0-source-c-${suffix}`;
    const podcastSource = `gate4e0-podcast-${suffix}`;
    const effectiveSourceIds = [sourceA, sourceB].sort();

    await prisma.user.create({ data: { id: userId } });
    await prisma.sourcePlaylist.createMany({
      data: [
        {
          id: sourceA,
          userId,
          kind: "MUSIC",
          spotifyType: "PLAYLIST",
          spotifyId: `spotify-a-${suffix}`,
        },
        {
          id: sourceB,
          userId,
          kind: "MUSIC",
          spotifyType: "PLAYLIST",
          spotifyId: `spotify-b-${suffix}`,
        },
        {
          id: podcastSource,
          userId,
          kind: "PODCAST",
          spotifyType: "SHOW",
          spotifyId: `spotify-podcast-${suffix}`,
        },
      ],
    });
    await prisma.targetPlaylist.create({
      data: {
        id: targetPlaylistId,
        userId,
        name: "Avulsa test",
        enabled: true,
        sourceScopeMode: "INHERIT_GLOBAL",
        sequencePattern: ["MUSIC"],
      },
    });

    const base: Gate4E0ActivationProjection = {
      gate: "4E0",
      mode: "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_READY",
      userId,
      targetPlaylistId,
      targetName: "Avulsa test",
      policy: GATE4E0_POLICY,
      gate4cSnapshotFingerprint: "gate4c-a",
      gate4dOrderedInputFingerprint: "gate4d-a",
      sourceScopeFingerprint: sha(effectiveSourceIds),
      effectiveSourceIds,
      projectionFingerprint: "projection-a",
      validatedAt: new Date("2026-09-24T21:08:55.507Z"),
      componentCount: 1,
      hypotheticalDrops: 1,
      components: [
        {
          componentId: "component-a",
          memberProviderTrackIds: ["track-a", "track-b"],
          representativeProviderTrackId: "track-a",
          preferenceState: "NO_EXPLICIT_TRACK_PREFERENCE",
          containsExcludedPreference: false,
        },
      ],
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

    try {
      const first = await persistGate4E0ActivationProjection(base);
      assert.equal(first.created, true);
      assert.equal(first.revalidated, false);
      assert.equal(first.version, 1);
      assert.equal(first.status, CanonicalDedupeProjectionStatus.READY);

      // O durable preview deve reutilizar a READY persistida sem provider
      // e ignorar a fonte PODCAST habilitada no mesmo usuário.
      const durable = runDurablePreview(userId, targetPlaylistId);
      assert.equal(
        durable.mode,
        "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_DURABLE_PREVIEW",
      );
      assert.equal(durable.evidenceSource, "PERSISTED_READY");
      assert.equal(durable.providerReadSession, null);
      assert.equal(durable.projection.componentCount, 1);
      assert.equal(
        durable.projection.projectionFingerprint,
        base.projectionFingerprint,
      );
      assert.deepEqual(
        durable.projection.effectiveSourceIds,
        effectiveSourceIds,
      );
      assert.equal(durable.authority.plannerInfluence, false);
      assert.equal(durable.authority.consumerActivation, false);
      assert.equal(durable.authority.spotifyPlaylistWrites, false);

      const second = await persistGate4E0ActivationProjection(base);
      assert.equal(second.created, false);
      assert.equal(second.revalidated, true);
      assert.equal(second.version, 1);
      assert.equal(second.projectionId, first.projectionId);

      // PODCAST habilitado não pertence ao domínio MUSIC da projection.
      // Uma nova fonte MUSIC, porém, deve continuar invalidando o snapshot.
      await prisma.sourcePlaylist.create({
        data: {
          id: sourceC,
          userId,
          kind: "MUSIC",
          spotifyType: "PLAYLIST",
          spotifyId: `spotify-c-${suffix}`,
        },
      });

      const durableStaleError = runDurablePreviewFailure(
        userId,
        targetPlaylistId,
      );
      assert.match(
        durableStaleError,
        /durable READY projection is stale: target source scope changed/,
      );

      await assert.rejects(
        () => persistGate4E0ActivationProjection(base),
        /target source scope changed before persistence/,
      );

      await prisma.sourcePlaylist.delete({ where: { id: sourceC } });

      const changed: Gate4E0ActivationProjection = {
        ...base,
        gate4cSnapshotFingerprint: "gate4c-b",
        gate4dOrderedInputFingerprint: "gate4d-b",
        projectionFingerprint: "projection-b",
        validatedAt: new Date("2026-09-24T22:08:55.507Z"),
      };
      const third = await persistGate4E0ActivationProjection(changed);
      assert.equal(third.created, true);
      assert.equal(third.revalidated, false);
      assert.equal(third.version, 2);

      const rows = await prisma.canonicalDedupeActivationProjection.findMany({
        where: { userId, targetPlaylistId, policy: GATE4E0_POLICY },
        orderBy: { version: "asc" },
        include: { components: true },
      });
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.status, CanonicalDedupeProjectionStatus.STALE);
      assert.equal(rows[1]!.status, CanonicalDedupeProjectionStatus.READY);
      assert.equal(rows[0]!.components.length, 1);
      assert.equal(rows[1]!.components.length, 1);
    } finally {
      await prisma.canonicalDedupeActivationProjection.deleteMany({
        where: { userId, targetPlaylistId },
      });
      await prisma.targetPlaylist.deleteMany({ where: { id: targetPlaylistId } });
      await prisma.sourcePlaylist.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  },
);

type DurablePreviewOutput = {
  mode: string;
  evidenceSource: string;
  providerReadSession: unknown;
  projection: {
    componentCount: number;
    projectionFingerprint: string;
    effectiveSourceIds: string[];
  };
  authority: {
    plannerInfluence: boolean;
    consumerActivation: boolean;
    spotifyPlaylistWrites: boolean;
  };
};

function durablePreviewArgs(
  userId: string,
  targetPlaylistId: string,
): string[] {
  return [
    "tsx",
    "scripts/report-music-identity-dedupe-activation-projection.ts",
    `--user=${userId}`,
    `--target=${targetPlaylistId}`,
    "--json",
  ];
}

function runDurablePreview(
  userId: string,
  targetPlaylistId: string,
): DurablePreviewOutput {
  const stdout = execFileSync(
    "npx",
    durablePreviewArgs(userId, targetPlaylistId),
    {
      encoding: "utf8",
      env: process.env,
    },
  );

  return JSON.parse(stdout) as DurablePreviewOutput;
}

function runDurablePreviewFailure(
  userId: string,
  targetPlaylistId: string,
): string {
  try {
    execFileSync(
      "npx",
      durablePreviewArgs(userId, targetPlaylistId),
      {
        encoding: "utf8",
        env: process.env,
      },
    );
  } catch (error) {
    const failure = error as Error & {
      stderr?: string | Buffer;
    };

    if (typeof failure.stderr === "string") {
      return failure.stderr;
    }

    if (failure.stderr) {
      return failure.stderr.toString("utf8");
    }

    return failure.message;
  }

  throw new Error(
    "durable preview unexpectedly succeeded after MUSIC source-scope change",
  );
}

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
