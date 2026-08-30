import { createHash, randomBytes } from "node:crypto";

import { PrelaunchSignupStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { normalizePrelaunchEmail } from "@/services/prelaunch-contract";

export const PRELAUNCH_INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export function hashPrelaunchInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function maskPrelaunchEmail(email: string): string {
  const normalized = normalizePrelaunchEmail(email);
  const [local, domain] = normalized.split("@");
  if (!local || !domain) return "e-mail do convite";

  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(3, local.length - visible.length))}@${domain}`;
}

export async function createPrelaunchInvite({
  signupId,
  actorUserId,
  actorEmail,
}: {
  signupId: string;
  actorUserId: string;
  actorEmail: string;
}) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashPrelaunchInviteToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PRELAUNCH_INVITE_TTL_MS);

  const invite = await prisma.$transaction(async (tx) => {
    const signup = await tx.prelaunchSignup.findUnique({
      where: { id: signupId },
      select: { id: true, email: true, status: true },
    });
    if (!signup) throw new Error("Inscrição não encontrada.");
    if (signup.status !== PrelaunchSignupStatus.INVITED) {
      throw new Error("A inscrição precisa estar marcada como convidada.");
    }

    await tx.prelaunchInvite.updateMany({
      where: {
        prelaunchSignupId: signup.id,
        consumedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    return tx.prelaunchInvite.create({
      data: {
        prelaunchSignupId: signup.id,
        tokenHash,
        expectedEmail: signup.email,
        expiresAt,
        createdByUserId: actorUserId,
        createdByEmail: normalizePrelaunchEmail(actorEmail),
      },
      select: { expiresAt: true },
    });
  });

  return { token, expiresAt: invite.expiresAt };
}

export async function findValidPrelaunchInvite(token: string) {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(token)) return null;

  return prisma.prelaunchInvite.findFirst({
    where: {
      tokenHash: hashPrelaunchInviteToken(token),
      consumedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
      prelaunchSignup: { status: PrelaunchSignupStatus.INVITED },
    },
    select: {
      id: true,
      expectedEmail: true,
      expiresAt: true,
    },
  });
}
