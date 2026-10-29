/**
 * Build identity injected by next.config.mjs at `next build`. Missing values
 * (dev server without git, tests) degrade to a readable "dev" label.
 */
export type AppVersion = Readonly<{
  version: string;
  sha: string | null;
  shortSha: string | null;
  commitDate: Date | null;
  buildTime: Date | null;
}>;

export function appVersion(
  env: Readonly<Record<string, string | undefined>> = {
    SONORIZA_VERSION: process.env.SONORIZA_VERSION,
    SONORIZA_BUILD_SHA: process.env.SONORIZA_BUILD_SHA,
    SONORIZA_COMMIT_DATE: process.env.SONORIZA_COMMIT_DATE,
    SONORIZA_BUILD_TIME: process.env.SONORIZA_BUILD_TIME,
  },
): AppVersion {
  const sha = /^[0-9a-f]{7,40}$/i.test(env.SONORIZA_BUILD_SHA ?? "")
    ? env.SONORIZA_BUILD_SHA!.toLowerCase()
    : null;
  return {
    version: env.SONORIZA_VERSION?.trim() || "dev",
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    commitDate: validDate(env.SONORIZA_COMMIT_DATE),
    buildTime: validDate(env.SONORIZA_BUILD_TIME),
  };
}

function validDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
