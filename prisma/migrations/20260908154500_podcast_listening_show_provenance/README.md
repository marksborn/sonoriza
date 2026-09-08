# PODCAST-06 Gate 4I

Adds nullable `spotifyShowId` provenance to canonical podcast listening state.

This migration intentionally performs no historical backfill. Existing rows remain unknown until authoritative provider metadata is observed again. Cadence must continue to fail closed for any factual row whose show provenance cannot be resolved.

The runtime reuses `show.id` already present in existing Spotify episode payloads, so Gate 4I adds no provider read or write solely to populate this field.
