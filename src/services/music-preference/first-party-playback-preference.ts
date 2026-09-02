import {
  lineageFromRootSource,
  type DataLineage,
} from "@/services/data-policy";

/**
 * SPOTIFY-COMPLIANCE-01 / Gate 4
 *
 * Explicit Sonoriza-owned preference contract. This domain intentionally does
 * not accept provider-derived sources. A provider may be used later to resolve
 * the identity of a referenced track/artist operationally, but that provider
 * metadata must keep its own lineage and must never change the origin of the
 * user's explicit preference.
 */
export const FIRST_PARTY_PREFERENCE_SOURCES = [
  "USER_EXPLICIT",
  "SONORIZA_INTERACTION",
] as const;

export type FirstPartyPreferenceSource =
  (typeof FIRST_PARTY_PREFERENCE_SOURCES)[number];

export const PLAYBACK_PREFERENCE_SUBJECT_TYPES = [
  "TRACK",
  "ARTIST",
  "VERSION_TRAIT",
  "DISCOVERY",
  "REPEAT",
] as const;

export type PlaybackPreferenceSubjectType =
  (typeof PLAYBACK_PREFERENCE_SUBJECT_TYPES)[number];

export const PLAYBACK_PREFERENCE_POLICIES = [
  "PREFERRED",
  "NORMAL",
  "REDUCED",
  "EXCLUDED",
] as const;

export type PlaybackPreferencePolicy =
  (typeof PLAYBACK_PREFERENCE_POLICIES)[number];

export type FirstPartyPlaybackPreferenceValue =
  | string
  | number
  | boolean
  | null
  | readonly FirstPartyPlaybackPreferenceValue[]
  | { readonly [key: string]: FirstPartyPlaybackPreferenceValue };

export type FirstPartyPlaybackPreference = Readonly<{
  id: string;
  userId: string;
  subjectType: PlaybackPreferenceSubjectType;
  subjectKey: string;
  policy: PlaybackPreferencePolicy;
  value: FirstPartyPlaybackPreferenceValue | null;
  source: FirstPartyPreferenceSource;
  createdAt: Date;
  updatedAt: Date;
}>;

export type SetFirstPartyPlaybackPreferenceInput = Readonly<{
  userId: string;
  subjectType: PlaybackPreferenceSubjectType;
  subjectKey: string;
  policy: PlaybackPreferencePolicy;
  value?: FirstPartyPlaybackPreferenceValue;
  source: FirstPartyPreferenceSource;
}>;

export const FIRST_PARTY_PREFERENCE_SUBJECT_KEY_MAX_LENGTH = 512;

const FIRST_PARTY_PREFERENCE_SOURCE_SET = new Set<string>(
  FIRST_PARTY_PREFERENCE_SOURCES,
);

export function isFirstPartyPreferenceSource(
  source: string,
): source is FirstPartyPreferenceSource {
  return FIRST_PARTY_PREFERENCE_SOURCE_SET.has(source);
}

/**
 * Runtime fail-closed boundary. TypeScript types are not sufficient for request
 * payloads or unsafe casts, so an unrecognized/provider-derived source is
 * rejected before it can receive FIRST_PARTY lineage or be persisted.
 */
export function assertFirstPartyPreferenceSource(
  source: string,
): asserts source is FirstPartyPreferenceSource {
  if (!isFirstPartyPreferenceSource(source)) {
    throw new Error(`Not a first-party preference source: ${source}`);
  }
}

/**
 * subjectKey is an opaque Sonoriza-domain reference, not a declaration of data
 * origin. It may eventually point to a Sonoriza canonical entity or an
 * operational provider identity, but the referenced metadata must preserve its
 * own lineage separately.
 */
export function normalizeFirstPartyPreferenceSubjectKey(subjectKey: string): string {
  const normalized = subjectKey.trim();

  if (normalized.length === 0) {
    throw new Error("First-party preference subjectKey must not be empty");
  }
  if (normalized.length > FIRST_PARTY_PREFERENCE_SUBJECT_KEY_MAX_LENGTH) {
    throw new Error(
      `First-party preference subjectKey exceeds ${FIRST_PARTY_PREFERENCE_SUBJECT_KEY_MAX_LENGTH} characters`,
    );
  }

  return normalized;
}

/**
 * Every source admitted by this module is first-party by construction. This is
 * the compliance boundary that keeps legacy Spotify-derived LIKED/SKIP/profile
 * data out of the explicit-preference domain.
 */
export function lineageForFirstPartyPreference(
  source: FirstPartyPreferenceSource,
): DataLineage {
  assertFirstPartyPreferenceSource(source);
  return lineageFromRootSource(source);
}

export function normalizeSetFirstPartyPlaybackPreferenceInput(
  input: SetFirstPartyPlaybackPreferenceInput,
): SetFirstPartyPlaybackPreferenceInput {
  assertFirstPartyPreferenceSource(input.source);

  return Object.freeze({
    ...input,
    subjectKey: normalizeFirstPartyPreferenceSubjectKey(input.subjectKey),
  });
}
