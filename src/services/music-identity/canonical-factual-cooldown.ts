import { createHash } from "node:crypto";
import { normalizeMusicIdentityText } from "@/services/music-preference/lastfm-coverage";
import { lineageForDiscoveryListeningEvent } from "@/services/data-policy/discovery-profile-policy";
import { compareGate5AFactualCooldown, type Gate5AProviderRef } from "./canonical-factual-cooldown-shadow";
import { classifyShadowResolverVersion, deriveBaseTitleSignal } from "./shadow-resolver-report";

export type CanonicalCooldownMode = "OFF" | "SHADOW" | "ACTIVE";
export type CanonicalCooldownScope = Readonly<{ mode: CanonicalCooldownMode; targetId: string | null }>;
export type CanonicalCooldownRef = Gate5AProviderRef & Readonly<{
  userId: string; provider: string; providerScope: string; resolutionLineage: unknown;
  versionClass: string | null; canonicalTitle: string; canonicalArtist: string;
}>;
export type CanonicalCooldownFact = Readonly<{
  userId: string; source: string; spotifyTrackId: string | null; trackName: string;
  artistName: string; isrc: string | null; trackMbid: string | null; playedAt: Date; metadata: unknown;
}>;
export type CanonicalCooldownState = {
  scope: CanonicalCooldownScope;
  status: "OFF" | "READY" | "FACTUAL_NOT_READY" | "POLICY_NOT_APPROVED" | "EVIDENCE_UNAVAILABLE";
  graphFingerprint: string | null;
  blockedRefs: ReadonlyMap<string, CanonicalCooldownRef>;
  linkedFactCount: number;
  matchedCandidateCount: number;
};

export const CANONICAL_COOLDOWN_APPROVAL = "PERSONAL_FACTUAL_RECORDING_COOLDOWN_V1";

/** A separate rollout: one explicit user:target pair, never an implicit global run. */
export function resolveCanonicalCooldownScope(input: {
  userId: string; targetIds?: readonly string[]; mode?: string; allowlist?: string;
}): CanonicalCooldownScope {
  const mode = input.mode?.trim().toUpperCase();
  const targets = [...new Set(input.targetIds ?? [])];
  if (mode !== "ACTIVE" && mode !== "SHADOW") return { mode: "OFF", targetId: null };
  const pairs = (input.allowlist ?? "").split(/[,;\s]+/);
  const allowed = pairs.filter(pair => pair.startsWith(`${input.userId}:`)).map(pair => pair.slice(input.userId.length + 1)).filter(Boolean);
  if (targets.length !== 1 || !targets[0]) {
    // An unscoped/multi-target real run must not bypass an opted-in target.
    return mode === "ACTIVE" && allowed.some(id => targets.length === 0 || targets.includes(id))
      ? { mode: "ACTIVE", targetId: null } : { mode: "OFF", targetId: null };
  }
  return pairs.includes(`${input.userId}:${targets[0]}`) ? { mode, targetId: targets[0] } : { mode: "OFF", targetId: null };
}

export function emptyCanonicalCooldown(scope: CanonicalCooldownScope, status: CanonicalCooldownState["status"] = "OFF"): CanonicalCooldownState {
  return { scope, status, graphFingerprint: null, blockedRefs: new Map(), linkedFactCount: 0, matchedCandidateCount: 0 };
}

function isrc(value: string | null) {
  const code = value?.replace(/[-\s]/g, "").toUpperCase() ?? "";
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code) ? code : null;
}
function mbid(value: string | null) {
  const id = value?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : null;
}
function permittedLineage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const origins = (value as { origins?: unknown }).origins;
  return Array.isArray(origins) && origins.length > 0 &&
    origins.every(origin => ["FIRST_PARTY", "SPOTIFY", "LASTFM"].includes(origin));
}
function factualLineageSafe(fact: CanonicalCooldownFact) {
  if (lineageForDiscoveryListeningEvent(fact).origins.some(origin => origin !== "LASTFM")) return false;
  if (fact.metadata === null || fact.metadata === undefined) return true;
  if (typeof fact.metadata !== "object" || Array.isArray(fact.metadata)) return false;
  const metadata = fact.metadata as Record<string, unknown>;
  if (["spotifyExtendedHistory", "spotifyRecentlyPlayed", "spotifySavedTracks", "spotify"].some(key => Object.hasOwn(metadata, key))) return false;
  if (Object.hasOwn(metadata, "origins") && (!Array.isArray(metadata.origins) || metadata.origins.some(o => o !== "LASTFM"))) return false;
  return true;
}
function standardOrRemaster(title: string) {
  const version = classifyShadowResolverVersion({ trackName: title });
  const normalized = normalizeMusicIdentityText(title) ?? "";
  return ["STANDARD", "REMASTER"].includes(version) && !/\b(?:re ?record(?:ed|ing)?|regrav(?:ada|ado|acao))\b/.test(normalized);
}
function metadataMatches(title: string, artist: string | null | undefined, ref: CanonicalCooldownRef) {
  return standardOrRemaster(title) && Boolean(deriveBaseTitleSignal(title)) &&
    deriveBaseTitleSignal(title) === deriveBaseTitleSignal(ref.canonicalTitle) &&
    Boolean(normalizeMusicIdentityText(artist)) && normalizeMusicIdentityText(artist) === normalizeMusicIdentityText(ref.canonicalArtist);
}
function strong(ref: CanonicalCooldownRef, userId: string) {
  return ref.userId === userId && ref.provider === "spotify" && ref.providerScope === "global" &&
    Boolean(ref.providerTrackId && ref.recordingIdentityId && ref.canonicalTitle && ref.canonicalArtist) &&
    ["EXACT_PROVIDER_ALIAS", "SAME_RECORDING_HIGH_CONFIDENCE"].includes(ref.matchReason) &&
    Number.isInteger(ref.confidenceBasisPoints) && ref.confidenceBasisPoints >= 9000 && ref.confidenceBasisPoints <= 10000 &&
    ["STANDARD", "REMASTER"].includes(ref.versionClass ?? "") && permittedLineage(ref.resolutionLineage) &&
    Boolean(isrc(ref.isrc) || mbid(ref.trackMbid)) &&
    (!ref.isrc || isrc(ref.isrc) !== null) && (!ref.trackMbid || mbid(ref.trackMbid) !== null);
}
function identifiersAgree(a: Pick<CanonicalCooldownRef, "isrc" | "trackMbid">, b: Pick<CanonicalCooldownRef, "isrc" | "trackMbid">) {
  return !(isrc(a.isrc) && isrc(b.isrc) && isrc(a.isrc) !== isrc(b.isrc)) &&
    !(mbid(a.trackMbid) && mbid(b.trackMbid) && mbid(a.trackMbid) !== mbid(b.trackMbid));
}

/** Consumes approved associations only; no new identity is inferred or persisted. */
export function buildCanonicalCooldown(input: {
  userId: string; scope: CanonicalCooldownScope; cutoff: Date; asOf: Date;
  refs: readonly CanonicalCooldownRef[]; facts: readonly CanonicalCooldownFact[];
}): CanonicalCooldownState {
  const state = emptyCanonicalCooldown(input.scope, "READY");
  if (input.scope.mode === "OFF") return emptyCanonicalCooldown(input.scope);
  if (!Number.isFinite(input.cutoff.getTime()) || !Number.isFinite(input.asOf.getTime()) || input.cutoff > input.asOf) throw new Error("Invalid canonical fact window");
  const refsById = new Map<string, CanonicalCooldownRef>();
  for (const ref of input.refs) {
    if (ref.userId !== input.userId || ref.provider !== "spotify" || ref.providerScope !== "global") continue;
    if (refsById.has(ref.providerTrackId)) throw new Error("Ambiguous canonical provider reference");
    refsById.set(ref.providerTrackId, ref);
  }
  const refs = [...refsById.values()];
  // Freeze the whole relevant graph, including weak/revoked/conflicting rows.
  state.graphFingerprint = createHash("sha256").update(JSON.stringify({
    refs: refs.map(ref => [ref.providerTrackId, ref.recordingIdentityId, ref.matchReason, ref.confidenceBasisPoints,
      ref.isrc, ref.trackMbid, ref.versionClass, ref.canonicalTitle, ref.canonicalArtist, ref.resolutionLineage])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    facts: input.facts.map(f => JSON.stringify([f.userId, f.source, f.spotifyTrackId, f.trackName, f.artistName,
      f.isrc, f.trackMbid, Number.isFinite(f.playedAt.getTime()) ? f.playedAt.toISOString() : null,
      lineageForDiscoveryListeningEvent(f).origins, factualLineageSafe(f)])).sort(),
  })).digest("hex");
  const blocked = new Map<string, CanonicalCooldownRef>();
  const groups = new Map<string, CanonicalCooldownRef[]>();
  for (const ref of refs) {
    const group = groups.get(ref.recordingIdentityId) ?? [];
    group.push(ref);
    groups.set(ref.recordingIdentityId, group);
  }
  const unsafe = new Set<string>();
  for (const [id, group] of groups) {
    // Even a shared recording must abstain on conflicting persisted metadata.
    if (new Set(group.map(r => r.canonicalTitle)).size !== 1 || new Set(group.map(r => r.canonicalArtist)).size !== 1 ||
        new Set(group.map(r => r.versionClass)).size !== 1 || group.some(r => (r.isrc && !isrc(r.isrc)) || (r.trackMbid && !mbid(r.trackMbid))) ||
        new Set(group.map(r => isrc(r.isrc)).filter(Boolean)).size > 1 ||
        new Set(group.map(r => mbid(r.trackMbid)).filter(Boolean)).size > 1) unsafe.add(id);
  }
  // At most three witness signatures per recording (ISRC, MBID, both).
  // Repeated scrobbles never multiply the full provider-ref scan.
  const witnesses = new Map<string, Map<string, { anchor: CanonicalCooldownRef; fact: CanonicalCooldownFact }>>();
  for (const fact of input.facts) {
    if (fact.userId !== input.userId || fact.source !== "LASTFM_SCROBBLE" || !fact.spotifyTrackId ||
        !Number.isFinite(fact.playedAt.getTime()) || fact.playedAt < input.cutoff || fact.playedAt > input.asOf ||
        !factualLineageSafe(fact)) continue;
    const anchor = refsById.get(fact.spotifyTrackId);
    if (!anchor || unsafe.has(anchor.recordingIdentityId) || !strong(anchor, input.userId) || !metadataMatches(fact.trackName, fact.artistName, anchor) ||
        (fact.isrc && !isrc(fact.isrc)) || (fact.trackMbid && !mbid(fact.trackMbid)) || !identifiersAgree(anchor, fact)) continue;
    state.linkedFactCount++;
    const bucket = witnesses.get(anchor.recordingIdentityId) ?? new Map();
    bucket.set(`${isrc(anchor.isrc) ? "I" : ""}${mbid(anchor.trackMbid) ? "M" : ""}`, { anchor, fact });
    witnesses.set(anchor.recordingIdentityId, bucket);
  }
  for (const [id, bucket] of witnesses) {
    for (const ref of groups.get(id) ?? []) {
      if (!strong(ref, input.userId)) continue;
      for (const { anchor, fact } of bucket.values()) {
        if (
          ref.canonicalTitle !== anchor.canonicalTitle || ref.canonicalArtist !== anchor.canonicalArtist ||
          !identifiersAgree(ref, anchor)) continue;
        const comparison = compareGate5AFactualCooldown({
          published: { spotifyTrackId: ref.providerTrackId, trackName: ref.canonicalTitle, artistName: ref.canonicalArtist },
          events: [fact], refs: [anchor, ...(ref.providerTrackId === anchor.providerTrackId ? [] : [ref])],
        });
        if (comparison.canonical === "EXACT_PROVIDER_REF" || comparison.canonical === "STRONG_SAME_RECORDING") blocked.set(ref.providerTrackId, ref);
      }
    }
  }
  state.blockedRefs = blocked;
  return state;
}

export function matchesCanonicalCooldown(candidate: { spotifyTrackId?: string | null; title: string; primaryArtistName?: string | null; subtitle?: string | null }, state?: CanonicalCooldownState) {
  if (!state || state.status !== "READY" || state.scope.mode === "OFF" || !candidate.spotifyTrackId) return false;
  const ref = state.blockedRefs.get(candidate.spotifyTrackId);
  return Boolean(ref && metadataMatches(candidate.title, candidate.primaryArtistName ?? candidate.subtitle, ref));
}

export function assertCanonicalCooldownReady(state?: CanonicalCooldownState) {
  if (state?.scope.mode === "ACTIVE" && state.status !== "READY") throw new Error("Canonical factual cooldown evidence unavailable; write blocked");
}

export function canonicalSnapshotChanged(previous?: CanonicalCooldownState, next?: CanonicalCooldownState) {
  if (previous?.scope.mode !== "ACTIVE" && next?.scope.mode !== "ACTIVE") return false;
  return previous?.scope.mode !== next?.scope.mode || previous?.scope.targetId !== next?.scope.targetId ||
    previous?.status !== "READY" || next?.status !== "READY" || !previous.graphFingerprint ||
    previous.graphFingerprint !== next.graphFingerprint;
}

export type CanonicalPreservationEvidence = Readonly<{ targetId: string; fingerprint: string }>;
export function canonicalPreservationMismatch(expected: readonly CanonicalPreservationEvidence[] | undefined, current?: CanonicalCooldownState) {
  return Boolean(expected?.some(e => current?.scope.mode !== "ACTIVE" || current.status !== "READY" ||
    current.scope.targetId !== e.targetId || current.graphFingerprint !== e.fingerprint));
}
