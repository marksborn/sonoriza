import type {
  PlaybackReservePolicyInput,
  PlaybackReservePolicySnapshot,
  TargetPlaybackReservePolicyInput,
} from "./playback-reserve-policy";

export type PlaybackReserveFormReader = Readonly<{
  get(name: string): unknown;
}>;

export function parsePlaybackReservePolicyForm(
  form: PlaybackReserveFormReader,
): PlaybackReservePolicyInput {
  const reserveMode = text(form, "reserveMode");

  switch (reserveMode) {
    case "NONE":
      return { reserveMode: "NONE" };

    case "DURATION": {
      const durationMinutes = positiveNumber(form, "durationMinutes");
      const durationSeconds = Math.round(durationMinutes * 60);
      if (durationSeconds < 1) {
        throw new Error("durationMinutes must resolve to at least one second.");
      }
      return {
        reserveMode: "DURATION",
        durationSeconds,
        podcastInDurationReserve:
          text(form, "podcastInDurationReserve") === "IF_FITS"
            ? "IF_FITS"
            : "DISABLED",
      };
    }

    case "MUSIC_TRACKS":
      return {
        reserveMode: "MUSIC_TRACKS",
        musicTrackCount: positiveInteger(form, "musicTrackCount"),
      };

    case "PODCAST_EPISODES":
      return {
        reserveMode: "PODCAST_EPISODES",
        podcastEpisodeCount: positiveInteger(form, "podcastEpisodeCount"),
      };

    default:
      throw new Error("reserveMode is invalid.");
  }
}

export function parseTargetPlaybackReservePolicyForm(
  form: PlaybackReserveFormReader,
): TargetPlaybackReservePolicyInput {
  const policyMode = text(form, "policyMode");
  if (policyMode === "INHERIT_GLOBAL") {
    return { policyMode: "INHERIT_GLOBAL" };
  }
  if (policyMode !== "OVERRIDE") {
    throw new Error("policyMode is invalid.");
  }

  return {
    policyMode: "OVERRIDE",
    ...parsePlaybackReservePolicyForm(form),
  };
}

/**
 * HTML number inputs use "." as the serialized decimal separator.
 * Two decimal places are enough to round-trip every whole second:
 * 1/60 minute rounds to 0.02, which parses back to 1 second.
 * This is presentation only; it never rewrites the stored policy.
 */
export function formatPlaybackReserveUpdatePolicyLabel(policy: string): string {
  switch (policy) {
    case "KEEP_FILLED":
      return "Manter completa";
    case "REBUILD_DAILY":
      return "Reconstrução diária";
    case "MANUAL":
      return "Manual";
    default:
      return "Outra forma de atualização";
  }
}

export function formatPlaybackReserveMinutesInput(durationSeconds: number): string {
  return String(Math.round((durationSeconds / 60) * 100) / 100);
}

export function formatPlaybackReservePolicyLabel(
  policy: Pick<
    PlaybackReservePolicySnapshot,
    | "reserveMode"
    | "durationSeconds"
    | "musicTrackCount"
    | "podcastEpisodeCount"
    | "podcastInDurationReserve"
  >,
): string {
  switch (policy.reserveMode) {
    case "NONE":
      return "Sem reserva";
    case "DURATION": {
      const minutes = (policy.durationSeconds ?? 0) / 60;
      const duration = Number.isInteger(minutes)
        ? String(minutes)
        : minutes.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
      return `+${duration} min${
        policy.podcastInDurationReserve === "IF_FITS" ? " · podcast se couber" : ""
      }`;
    }
    case "MUSIC_TRACKS":
      return `+${policy.musicTrackCount ?? 0} música${
        policy.musicTrackCount === 1 ? "" : "s"
      }`;
    case "PODCAST_EPISODES":
      return `+${policy.podcastEpisodeCount ?? 0} podcast${
        policy.podcastEpisodeCount === 1 ? "" : "s"
      }`;
  }
}

function text(form: PlaybackReserveFormReader, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function positiveNumber(form: PlaybackReserveFormReader, name: string): number {
  const value = Number(text(form, name));
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return value;
}

function positiveInteger(form: PlaybackReserveFormReader, name: string): number {
  const value = Number(text(form, name));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export type PlaybackReserveSimulationView = Readonly<{
  /** INCLUDED: RESERVE is part of the simulated plan; PREVIEW: projection only. */
  kind: "INCLUDED" | "PREVIEW";
  itemCount: number;
  musicCount: number;
  podcastCount: number;
  plannedMinutes: number;
  shortfall: boolean;
}>;

/**
 * #470: reads the RESERVE outcome of one simulated target from
 * GenerationRun.summary. A capability-only simulation (READY_PREVIEW_SIMULATION)
 * keeps RESERVE out of the plan so the simulated order matches what a real run
 * publishes; its projection is presented as a preview, never as included.
 */
export function readPlaybackReserveSimulationView(
  summary: unknown,
  targetPlaylistId: string,
): PlaybackReserveSimulationView | null {
  const root = asRecord(summary);
  const runtime = asRecord(root?.playbackReserveRuntime);
  const kind =
    runtime?.status === "READY_ACTIVE_SIMULATION"
      ? "INCLUDED"
      : runtime?.status === "READY_PREVIEW_SIMULATION"
        ? "PREVIEW"
        : null;
  if (!kind) return null;

  const evidence = asRecord(root?.playbackReserveShadow);
  const targets = Array.isArray(evidence?.targets) ? evidence.targets : [];
  const target = targets
    .map(asRecord)
    .find((entry) => entry?.targetPlaylistId === targetPlaylistId);
  const reserve = asRecord(target?.reserve);
  if (!target || !reserve) return null;

  return {
    kind,
    itemCount: numberOrZero(reserve.itemCount),
    musicCount: numberOrZero(reserve.musicCount),
    podcastCount: numberOrZero(reserve.podcastCount),
    plannedMinutes: Math.round(numberOrZero(reserve.plannedDurationMs) / 60_000),
    shortfall: target.status === "SHORTFALL",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
