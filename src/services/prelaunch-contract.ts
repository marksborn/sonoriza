import { z } from "zod";

export const PRELAUNCH_PRIVACY_VERSION = "2026-08-30";

export const prelaunchSignupSchema = z.object({
  email: z.string().trim().email().max(320),
  privacyAccepted: z.literal(true),
  website: z.string().max(0).optional().default(""),
});

export type PrelaunchSignupInput = z.infer<typeof prelaunchSignupSchema>;

export function normalizePrelaunchEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
}
