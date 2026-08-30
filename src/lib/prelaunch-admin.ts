import { normalizeEmail, parseAllowedEmails } from "@/lib/email-allowlist";

export type PrelaunchAdminEnvironment = {
  NODE_ENV?: string;
  SONORIZA_ADMIN_EMAILS?: string;
};

export function isPrelaunchAdmin(
  email: unknown,
  environment: PrelaunchAdminEnvironment = process.env,
): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const admins = parseAllowedEmails(environment.SONORIZA_ADMIN_EMAILS);
  return admins.has(normalized);
}
