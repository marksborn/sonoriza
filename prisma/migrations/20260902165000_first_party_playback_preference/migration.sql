-- SPOTIFY-COMPLIANCE-01 Gate 4
-- Additive first-party preference storage.
--
-- Deliberately does NOT backfill/copy LikedTrackPreference, ArtistAffinityState,
-- MusicPreferenceSignal or any other provider-derived/legacy profile data.

CREATE TYPE "FirstPartyPreferenceSource" AS ENUM (
    'USER_EXPLICIT',
    'SONORIZA_INTERACTION'
);

CREATE TYPE "PlaybackPreferenceSubjectType" AS ENUM (
    'TRACK',
    'ARTIST',
    'VERSION_TRAIT',
    'DISCOVERY',
    'REPEAT'
);

CREATE TYPE "PlaybackPreferencePolicy" AS ENUM (
    'PREFERRED',
    'NORMAL',
    'REDUCED',
    'EXCLUDED'
);

CREATE TABLE "FirstPartyPlaybackPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectType" "PlaybackPreferenceSubjectType" NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "policy" "PlaybackPreferencePolicy" NOT NULL,
    "value" JSONB,
    "source" "FirstPartyPreferenceSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FirstPartyPlaybackPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FirstPartyPlaybackPreference_userId_subjectType_subjectKey_key"
ON "FirstPartyPlaybackPreference"("userId", "subjectType", "subjectKey");

CREATE INDEX "FirstPartyPlaybackPreference_userId_subjectType_policy_idx"
ON "FirstPartyPlaybackPreference"("userId", "subjectType", "policy");

CREATE INDEX "FirstPartyPlaybackPreference_userId_source_idx"
ON "FirstPartyPlaybackPreference"("userId", "source");

ALTER TABLE "FirstPartyPlaybackPreference"
ADD CONSTRAINT "FirstPartyPlaybackPreference_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
