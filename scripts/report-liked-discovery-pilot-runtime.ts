import { prisma } from "@/lib/prisma";
import {
  resolveLikedDiscoveryPilotPolicy,
  resolveLikedDiscoveryPilotRuntime,
} from "@/services/music-preference/liked-discovery-pilot-runtime";

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() || null : null;
}

function hasArg(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function main() {
  const email = argValue("email");
  if (!email) {
    throw new Error(
      "Uso: npm run liked:pilot-runtime -- --email=usuario@exemplo.com [--resolve] [--json]",
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) throw new Error(`Usuário não encontrado: ${email}`);

  const targets = await prisma.targetPlaylist.findMany({
    where: { userId: user.id, enabled: true },
    orderBy: { priority: "asc" },
    select: {
      id: true,
      name: true,
      discoveryEnabled: true,
      discoveryNoveltyEnabled: true,
      discoveryIntensity: true,
      updatePolicy: true,
    },
  });

  const policy = resolveLikedDiscoveryPilotPolicy({
    baseDiscoveryEnabled: true,
    userEmail: user.email,
    masterEnabled: process.env.LIKED_DISCOVERY_PILOT_ENABLED,
    allowlistedEmails: process.env.LIKED_DISCOVERY_PILOT_USER_EMAILS,
    allowlistedTargetIds: process.env.LIKED_DISCOVERY_PILOT_TARGET_IDS,
  });
  const resolved = hasArg("resolve")
    ? await resolveLikedDiscoveryPilotRuntime({
        userId: user.id,
        userEmail: user.email,
        baseDiscoveryEnabled: true,
        masterEnabled: process.env.LIKED_DISCOVERY_PILOT_ENABLED,
        allowlistedEmails: process.env.LIKED_DISCOVERY_PILOT_USER_EMAILS,
        allowlistedTargetIds: process.env.LIKED_DISCOVERY_PILOT_TARGET_IDS,
      })
    : null;

  if (hasArg("json")) {
    console.log(
      JSON.stringify(
        {
          user: user.email ?? user.id,
          policy: {
            ...policy,
            targetIds: [...policy.targetIds],
          },
          targets,
          resolved: resolved
            ? {
                targetIds: [...resolved.targetIds],
                evidence: resolved.evidence,
                discovery: resolved.discovery,
              }
            : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  const p = (label: string, value: unknown) =>
    console.log(`${label.padEnd(42)}${String(value)}`);

  console.log("========== LIKED-01 — GATE 6C PILOT RUNTIME ==========");
  p("User:", user.email ?? user.id);
  p("Policy enabled:", policy.enabled);
  p("Policy reason:", policy.reason);
  p("Target allowlist:", [...policy.targetIds].join(", ") || "none");
  console.log();
  console.log("Enabled targets:");
  targets.forEach((target, index) => {
    const allowlisted = policy.targetIds.has(target.id);
    console.log(
      `  ${index + 1}. ${target.name} | id=${target.id} | discovery=${target.discoveryEnabled} | novelty=${target.discoveryNoveltyEnabled} | intensity=${target.discoveryIntensity} | update=${target.updatePolicy} | pilotAllowlisted=${allowlisted}`,
    );
  });

  if (!resolved) {
    console.log();
    console.log(
      "Use --resolve somente quando quiser executar a resolução read-only do candidato piloto; sem essa opção nenhuma resolução Spotify adicional é feita.",
    );
    return;
  }

  console.log();
  console.log("Read-only pilot resolution:");
  p("  status:", resolved.evidence.status);
  p("  reason:", resolved.evidence.reason);
  p("  calibration readiness:", resolved.evidence.calibrationReadiness);
  p("  Spotify catalog calls:", resolved.evidence.spotifyCatalogCalls);
  p("  Spotify failures:", resolved.evidence.spotifyFailures);
  p("  Spotify rate limits:", resolved.evidence.spotifyRateLimits);
  p("  near-duplicates quarantined:", resolved.evidence.nearDuplicateQuarantined);
  if (resolved.evidence.selectedCandidate) {
    const row = resolved.evidence.selectedCandidate;
    console.log(
      `  candidate: ${row.artistName} — ${row.trackName} | track=${row.spotifyTrackId} | raw=${row.rawScore.toFixed(3)} | calibrated=${row.calibratedScore.toFixed(3)}`,
    );
  } else {
    console.log("  candidate: none");
  }
  console.log();
  console.log(
    "Este comando é diagnóstico. O Gate 6C só altera um plano real quando as flags, usuário, target ID e política de Descobrir estão simultaneamente habilitados no runtime.",
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
