import { createHash } from "node:crypto";

import { Prisma, PrelaunchSignupStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  PRELAUNCH_PRIVACY_VERSION,
  normalizePrelaunchEmail,
} from "@/services/prelaunch-contract";

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_ATTEMPTS = 5;

export class PrelaunchRateLimitError extends Error {
  constructor() {
    super("Muitas tentativas. Aguarde alguns minutos e tente novamente.");
    this.name = "PrelaunchRateLimitError";
  }
}

export async function registerPrelaunchInterest({
  email,
  requestIdentity,
}: {
  email: string;
  requestIdentity: string;
}) {
  const normalizedEmail = normalizePrelaunchEmail(email);

  await consumeRateLimit(`ip:${requestIdentity}`);
  await consumeRateLimit(`email:${normalizedEmail}`);

  const now = new Date();
  return prisma.prelaunchSignup.upsert({
    where: { email: normalizedEmail },
    create: {
      email: normalizedEmail,
      status: PrelaunchSignupStatus.WAITING,
      source: "HOME",
      privacyVersion: PRELAUNCH_PRIVACY_VERSION,
      privacyAcceptedAt: now,
      lastSubmittedAt: now,
    },
    update: {
      privacyVersion: PRELAUNCH_PRIVACY_VERSION,
      privacyAcceptedAt: now,
      lastSubmittedAt: now,
      submissionCount: { increment: 1 },
    },
    select: { status: true },
  });
}

export function getPrelaunchRequestIdentity(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip")?.trim() || "unknown";
}

async function consumeRateLimit(identity: string) {
  const keyHash = hashRateLimitIdentity(identity);
  const now = new Date();
  const windowThreshold = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);

  const allowed = await prisma.$transaction(
    async (tx) => {
      const bucket = await tx.prelaunchRateLimitBucket.findUnique({
        where: { keyHash },
      });

      if (!bucket || bucket.windowStartedAt < windowThreshold) {
        await tx.prelaunchRateLimitBucket.upsert({
          where: { keyHash },
          create: { keyHash, windowStartedAt: now, attemptCount: 1 },
          update: { windowStartedAt: now, attemptCount: 1 },
        });
        return true;
      }

      if (bucket.attemptCount >= RATE_LIMIT_ATTEMPTS) return false;

      await tx.prelaunchRateLimitBucket.update({
        where: { keyHash },
        data: { attemptCount: { increment: 1 } },
      });
      return true;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  if (!allowed) throw new PrelaunchRateLimitError();
}

function hashRateLimitIdentity(identity: string): string {
  const secret =
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    (process.env.NODE_ENV === "production" ? "" : "sonoriza-development-only");

  if (!secret) {
    throw new Error("AUTH_SECRET is required for prelaunch rate limiting.");
  }

  return createHash("sha256").update(`${secret}:${identity}`).digest("hex");
}
