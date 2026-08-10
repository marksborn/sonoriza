const ALLOWED_EMAILS_ENV = "SONORIZA_ALLOWED_EMAILS";

export type EmailAllowlistOptions = {
  raw?: string | null;
  production?: boolean;
};

export function parseAllowedEmails(raw: string | null | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[\s,;]+/)
      .map((value) => normalizeEmail(value))
      .filter((value): value is string => Boolean(value)),
  );
}

export function isEmailAllowed(
  email: string | null | undefined,
  options: EmailAllowlistOptions = {},
): boolean {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const raw = options.raw === undefined ? process.env[ALLOWED_EMAILS_ENV] : options.raw;
  const production =
    options.production === undefined
      ? process.env.NODE_ENV === "production"
      : options.production;
  const allowed = parseAllowedEmails(raw);

  // Production is deliberately fail-closed so a missing deployment variable
  // can never reopen registration by accident. Local/test environments remain
  // usable without copying a personal production allowlist.
  if (allowed.size === 0) return !production;
  return allowed.has(normalized);
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase() ?? "";
  return normalized || null;
}
