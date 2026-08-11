export type EmailAllowlistEnvironment = {
  NODE_ENV?: string;
  SONORIZA_ALLOWED_EMAILS?: string;
};

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function parseAllowedEmails(value: unknown): ReadonlySet<string> {
  if (typeof value !== "string") return new Set<string>();

  return new Set(
    value
      .split(/[\r\n,]+/)
      .map((entry) => normalizeEmail(entry))
      .filter((entry): entry is string => entry !== null),
  );
}

/**
 * AUTH-01 runtime policy.
 *
 * Production is deliberately fail-closed: an absent/empty allowlist authorizes
 * nobody. Development/test remain open when the variable is absent so local
 * onboarding and CI do not require a developer-specific email address.
 * Once a list is configured, every environment obeys it.
 */
export function isEmailAllowed(
  email: unknown,
  environment: EmailAllowlistEnvironment = process.env,
): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const allowed = parseAllowedEmails(environment.SONORIZA_ALLOWED_EMAILS);
  if (allowed.size === 0) return environment.NODE_ENV !== "production";

  return allowed.has(normalized);
}

export function readOAuthProfileEmail(profile: unknown): string | null {
  if (!profile || typeof profile !== "object") return null;
  return normalizeEmail((profile as { email?: unknown }).email);
}

/**
 * OAuth authorization is stricter than a normal session check: the provider
 * itself must return an allowed email, and the Auth.js user identity must also
 * be allowed. Checking both prevents an old, now-disallowed session from being
 * used to link a newly authorized provider account onto that user.
 */
export function isOAuthIdentityAllowed(
  userEmail: unknown,
  profile: unknown,
  environment: EmailAllowlistEnvironment = process.env,
): boolean {
  const profileEmail = readOAuthProfileEmail(profile);
  return (
    profileEmail !== null &&
    isEmailAllowed(profileEmail, environment) &&
    isEmailAllowed(userEmail, environment)
  );
}
