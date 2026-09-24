import { prisma } from "@/lib/prisma";
import {
  buildGate4E0ActivationProjection,
  persistGate4E0ActivationProjection,
} from "@/services/music-identity/canonical-dedupe-activation-projection";
import { runMusicIdentityCanonicalRepresentativeSelectionShadow } from "@/services/music-identity/canonical-representative-selection-shadow";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function main() {
  const userId = argValue("user");
  const targetPlaylistId = argValue("target");
  if (!userId || !targetPlaylistId) {
    throw new Error(
      "Uso: npx tsx scripts/report-music-identity-dedupe-activation-projection.ts --user=<id> --target=<id> [--write] [--json]",
    );
  }

  const gate4d = await runMusicIdentityCanonicalRepresentativeSelectionShadow(userId);
  const projection = buildGate4E0ActivationProjection(gate4d, targetPlaylistId);
  const persistence = hasArg("write")
    ? await persistGate4E0ActivationProjection(projection)
    : null;

  const output = {
    gate: "4E0" as const,
    mode: hasArg("write")
      ? "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_PERSISTED"
      : "CANONICAL_DEDUPE_ACTIVATION_PROJECTION_PREVIEW",
    write: hasArg("write"),
    projection,
    persistence,
    authority: {
      plannerInfluence: false,
      consumerActivation: false,
      spotifyPlaylistWrites: false,
      identityWrites: false,
      canonicalWrites: false,
      providerRefReassociation: false,
      projectionPersistenceMayWrite: hasArg("write"),
    },
  };

  if (hasArg("json")) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Gate:                         ${output.gate}`);
  console.log(`Mode:                         ${output.mode}`);
  console.log(`User:                         ${projection.userId}`);
  console.log(`Target:                       ${projection.targetName} (${projection.targetPlaylistId})`);
  console.log(`Policy:                       ${projection.policy}`);
  console.log(`Components:                   ${projection.componentCount}`);
  console.log(`Hypothetical drops:           ${projection.hypotheticalDrops}`);
  console.log(`Projection fingerprint:       ${projection.projectionFingerprint}`);
  console.log(`Planner influence:            ${output.authority.plannerInfluence}`);
  console.log(`Consumer activation:          ${output.authority.consumerActivation}`);
  console.log(`Projection persisted:         ${Boolean(persistence)}`);
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
    await prisma.$disconnect();
  });
