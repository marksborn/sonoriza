import { MusicIngestionTrigger } from "@prisma/client";

import { isEmailAllowed } from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";
import { syncMusicIngestionRuleSerialized } from "@/services/spotify/music-ingestion-serialized";

export type MusicIngestionJobResult = {
  ruleId: string;
  status: "SUCCESS" | "NOOP" | "FAILED";
  addedCount: number;
  duplicateCount: number;
  cooldownCount: number;
  error?: string;
};

/**
 * Periodic MUSIC-03 ingestion. The migration creates no rules and new rules are
 * disabled until their explicit activation path has established state, so this
 * job cannot silently import historical content after deploy. AUTH-01 filters
 * removed users before any Spotify call.
 */
export async function runMusicIngestionJob(): Promise<MusicIngestionJobResult[]> {
  const rules = (
    await prisma.musicIngestionRule.findMany({
      where: { enabled: true },
      select: {
        id: true,
        userId: true,
        user: { select: { email: true } },
      },
      orderBy: [{ userId: "asc" }, { createdAt: "asc" }],
    })
  ).filter((rule) => isEmailAllowed(rule.user.email));

  const results: MusicIngestionJobResult[] = [];
  for (const rule of rules) {
    try {
      const result = await syncMusicIngestionRuleSerialized(rule.userId, rule.id, {
        trigger: MusicIngestionTrigger.SCHEDULED,
      });
      results.push({
        ruleId: rule.id,
        status: result.status === "SUCCESS" ? "SUCCESS" : "NOOP",
        addedCount: result.addedCount,
        duplicateCount: result.duplicateCount,
        cooldownCount: result.cooldownCount,
      });
    } catch (error) {
      results.push({
        ruleId: rule.id,
        status: "FAILED",
        addedCount: 0,
        duplicateCount: 0,
        cooldownCount: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
