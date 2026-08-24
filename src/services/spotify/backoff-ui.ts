export function spotifyBackoffRemainingMs(
  blockedUntil: string,
  nowMs = Date.now(),
): number | null {
  const blockedUntilMs = Date.parse(blockedUntil);
  if (!Number.isFinite(blockedUntilMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, blockedUntilMs - nowMs);
}
