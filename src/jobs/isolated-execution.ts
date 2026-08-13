export async function runIsolated<T>(
  entries: readonly T[],
  run: (entry: T) => Promise<void>,
  onError: (entry: T, error: unknown) => Promise<void>,
): Promise<void> {
  for (const entry of entries) {
    try {
      await run(entry);
    } catch (error) {
      await onError(entry, error);
    }
  }
}
