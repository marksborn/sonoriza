/**
 * #460: A KEEP_FILLED target must not enter a real Spotify write unless its
 * current snapshot and exact preservation plan were prepared by the server.
 *
 * An unscoped simulation is still allowed for CONFIG-04 onboarding, but it
 * cannot be treated as an approved KEEP_FILLED/Reserve simulation. An explicitly
 * scoped simulation must carry the same context as a real KEEP_FILLED run.
 */
export type KeepFilledContextGuardInput = Readonly<{
  simulate: boolean;
  targetScope: readonly string[] | null;
  targets: readonly Readonly<{ id: string; updatePolicy: string }>[];
  preservedByTargetId?: Readonly<Record<string, readonly unknown[]>>;
  keepFilledByTargetId?: Readonly<
    Record<
      string,
      Readonly<{
        snapshotBefore: string;
        preservedUris: readonly string[];
        removeUris: readonly string[];
      }>
    >
  >;
  scheduledPolicyByTargetId?: Readonly<Record<string, string>>;
  /**
   * CALENDAR-05 (#553): targets of this run scoped to one calendar event. The
   * scheduler deliberately rebuilds a KEEP_FILLED target per event (the
   * previous event's items are not valid for the next one).
   */
  eventScopedTargetIds?: readonly string[];
  /** Live snapshot read by the scheduler for a rebuild (REBUILD path guard). */
  rebuildByTargetId?: Readonly<Record<string, Readonly<{ snapshotBefore: string }>>>;
}>;

export function missingKeepFilledPreparation(
  input: KeepFilledContextGuardInput,
): string[] {
  // Keep the existing unscoped configuration simulation compatible. It is
  // never evidence of a target-specific KEEP_FILLED snapshot.
  if (input.simulate && input.targetScope === null) return [];

  const eventScoped = new Set(input.eventScopedTargetIds ?? []);
  return input.targets.flatMap((target) => {
    if (target.updatePolicy !== "KEEP_FILLED") return [];

    // CALENDAR-05: an event-scoped real run of a KEEP_FILLED target goes
    // through the guarded rebuild path. It is safe only when the scheduler
    // chose REBUILD_DAILY for it AND read the live snapshot that the final
    // pre-write check compares against; anything else still fails closed.
    const rebuildSnapshot = input.rebuildByTargetId?.[target.id]?.snapshotBefore;
    if (
      eventScoped.has(target.id) &&
      input.scheduledPolicyByTargetId?.[target.id] === "REBUILD_DAILY" &&
      typeof rebuildSnapshot === "string" &&
      rebuildSnapshot.trim().length > 0
    ) {
      return [];
    }

    const patch = input.keepFilledByTargetId?.[target.id];
    const prepared =
      input.scheduledPolicyByTargetId?.[target.id] === "KEEP_FILLED" &&
      typeof patch?.snapshotBefore === "string" &&
      patch.snapshotBefore.trim().length > 0 &&
      Array.isArray(patch.preservedUris) &&
      Array.isArray(patch.removeUris) &&
      Array.isArray(input.preservedByTargetId?.[target.id]);

    return prepared ? [] : [target.id];
  });
}
