import { PrelaunchSignupStatus } from "@prisma/client";

import {
  isEmailAllowed,
  normalizeEmail,
  readOAuthProfileEmail,
} from "@/lib/email-allowlist";
import { prisma } from "@/lib/prisma";

export async function isApplicationEmailAllowed(email: unknown): Promise<boolean> {
  if (isEmailAllowed(email)) return true;

  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const signup = await prisma.prelaunchSignup.findUnique({
    where: { email: normalized },
    select: {
      status: true,
      invites: {
        where: {
          consumedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        take: 1,
        select: { id: true },
      },
    },
  });

  return (
    signup?.status === PrelaunchSignupStatus.ACTIVATED ||
    (signup?.status === PrelaunchSignupStatus.INVITED &&
      signup.invites.length > 0)
  );
}

export async function isOAuthIdentityAdmitted(
  userEmail: unknown,
  profile: unknown,
): Promise<boolean> {
  const normalizedUser = normalizeEmail(userEmail);
  const profileEmail = readOAuthProfileEmail(profile);
  if (!normalizedUser || !profileEmail || normalizedUser !== profileEmail) {
    return false;
  }

  return isApplicationEmailAllowed(normalizedUser);
}

export async function activatePrelaunchSignup(email: unknown, userId: string) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;

  await prisma.$transaction(async (tx) => {
    const signup = await tx.prelaunchSignup.findUnique({
      where: { email: normalized },
      select: { id: true, status: true },
    });
    if (!signup || signup.status !== PrelaunchSignupStatus.INVITED) return;

    const now = new Date();
    const activeInvite = await tx.prelaunchInvite.findFirst({
      where: {
        prelaunchSignupId: signup.id,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!activeInvite) return;

    await tx.prelaunchInvite.update({
      where: { id: activeInvite.id },
      data: { consumedAt: now },
    });
    await tx.prelaunchSignup.update({
      where: { id: signup.id },
      data: {
        status: PrelaunchSignupStatus.ACTIVATED,
        activatedAt: now,
      },
    });
    await tx.prelaunchSignupStatusEvent.create({
      data: {
        prelaunchSignupId: signup.id,
        previousStatus: PrelaunchSignupStatus.INVITED,
        status: PrelaunchSignupStatus.ACTIVATED,
        actorUserId: userId,
        actorEmail: normalized,
      },
    });
  });
}
