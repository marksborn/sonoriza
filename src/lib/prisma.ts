import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient across hot reloads in development and across the
// long-lived PM2 process in production.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const transactionTimeoutMs = parsePositiveInteger(
  process.env.PRISMA_TRANSACTION_TIMEOUT_MS,
);
const transactionMaxWaitMs = parsePositiveInteger(
  process.env.PRISMA_TRANSACTION_MAX_WAIT_MS,
);

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    ...(transactionTimeoutMs !== null || transactionMaxWaitMs !== null
      ? {
          transactionOptions: {
            ...(transactionTimeoutMs !== null ? { timeout: transactionTimeoutMs } : {}),
            ...(transactionMaxWaitMs !== null ? { maxWait: transactionMaxWaitMs } : {}),
          },
        }
      : {}),
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

function parsePositiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
