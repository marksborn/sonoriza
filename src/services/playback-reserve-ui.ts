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
