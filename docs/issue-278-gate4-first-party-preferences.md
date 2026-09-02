# Issue #278 — Gate 4: perfil first-party

**SPOTIFY-COMPLIANCE-01 — separar Spotify de analytics derivados, perfis e IA**

- Date: 2026-09-02
- Base: Gate 3 `05894df47aa4fa57ad0ea64b2aff0d6b3cd50e93`
- Branch: `issue-278-gate4-first-party-preferences`
- Canonical scope: **criar preferências explícitas do Sonoriza independentes de Spotify-derived behavior**
- Planner/discovery behavior change: **none**
- Spotify reads/writes: **none**
- Legacy profile backfill/reclassification: **none**
- Production migration/deploy: **none**

> Gate 4 creates a new first-party preference domain. It does not reinterpret existing Spotify-derived rows as first-party and it does not yet make the planner consume these preferences.

---

## 1. Why existing preference-looking models are not reused

### `NativeSourcePreference`

`NativeSourcePreference` is a product configuration switch for native sources such as `LIKED_TRACKS`. Its runtime configuration reads counts/freshness from `LikedTrackPreference`; it is not a user musical-preference profile.

Therefore Gate 4 does not expand it into track/artist/version preferences.

### `MusicPreferenceSignal`

`MusicPreferenceSignal` currently stores `INFERRED_SKIP` signals and provider identities such as `spotifyTrackId`. It represents inferred behavior, not direct first-party intent.

Therefore Gate 4 does not add explicit preference types to that table.

### `LikedTrackPreference` / `ArtistAffinityState`

Despite historical naming/comments that describe liked state as explicit preference evidence, the current persistence contract is tied to Spotify identities and `LIKED_TRACK_BACKFILL` / `LIKED_TRACK_SYNC` provenance. Gate 1 established that an explicit Sonoriza like can collapse into those provider-sync semantics.

Gate 4 therefore does **not**:

- copy these rows;
- backfill them;
- change their provenance;
- label them `FIRST_PARTY`;
- use `ArtistAffinityState` as the new first-party profile.

---

## 2. New persistent domain

New Prisma model:

```text
FirstPartyPlaybackPreference
```

Identity/current-state key:

```text
(userId, subjectType, subjectKey)
```

Fields intentionally kept narrow:

```text
id
userId
subjectType
subjectKey
policy
source
createdAt
updatedAt
```

There is deliberately **no generic JSON payload/evidence column**. This prevents the new first-party table from becoming a convenient container for Spotify metadata, listening metrics or other provider-derived evidence.

The migration is additive only and contains no legacy `INSERT ... SELECT`, data copy or destructive statement.

---

## 3. First-party source boundary

The new persistence/domain enum accepts only:

```text
USER_EXPLICIT
SONORIZA_INTERACTION
```

It intentionally does not accept:

```text
SPOTIFY
PROVIDER_RESTRICTED
LIKED_TRACK_SYNC
LIKED_TRACK_BACKFILL
LASTFM
LICENSED_EXTERNAL_SOURCE
```

The broader architecture may support reviewed/licensed external sources later, but they are **not first-party** and must not be stored in this table merely to gain first-party capabilities.

### Runtime guard

TypeScript typing alone is insufficient because HTTP/JSON payloads or unsafe casts can provide arbitrary strings.

Gate 4 therefore adds:

```ts
isFirstPartyPreferenceSource(source)
assertFirstPartyPreferenceSource(source)
```

and both:

```ts
lineageForFirstPartyPreference(source)
normalizeSetFirstPartyPlaybackPreferenceInput(input)
```

fail closed when the runtime source is not one of the two first-party values.

A forged `"SPOTIFY" as FirstPartyPreferenceSource` is rejected before it can receive `FIRST_PARTY` lineage or reach the Prisma store.

---

## 4. Lineage

Both admitted sources map through the Gate 2 root-source contract:

```text
USER_EXPLICIT        -> FIRST_PARTY
SONORIZA_INTERACTION -> FIRST_PARTY
```

This lineage describes **the origin of the preference instruction itself**.

It does not magically make referenced catalog metadata first-party. For example, if a future UI resolves an artist through Spotify and the user explicitly says “do not play this artist”:

```text
user instruction       -> FIRST_PARTY
artist catalog metadata -> SPOTIFY
```

A future consumer that combines both data sets must merge their lineages according to Gate 2. Gate 4 does not launder provider metadata through the preference row.

---

## 5. Subjects and policies

### Subject types

```text
TRACK
ARTIST
VERSION_TRAIT
DISCOVERY
REPEAT
```

### Policies

```text
PREFERRED
NORMAL
REDUCED
EXCLUDED
```

`PREFERRED` is included because #278 contains positive explicit intent such as “prefiro covers” and “quero mais descoberta”; the original example `NORMAL | REDUCED | EXCLUDED` did not express a positive preference without another value channel. Adding `PREFERRED` lets the row stay narrow and avoids a generic payload.

### Canonical examples

```text
“não quero versões ao vivo”
subjectType = VERSION_TRAIT
subjectKey  = live
policy      = EXCLUDED
source      = USER_EXPLICIT

“tocar menos Artista X”
subjectType = ARTIST
subjectKey  = <opaque canonical reference>
policy      = REDUCED
source      = USER_EXPLICIT

“não tocar Artista Y”
subjectType = ARTIST
subjectKey  = <opaque canonical reference>
policy      = EXCLUDED
source      = USER_EXPLICIT

“prefiro covers”
subjectType = VERSION_TRAIT
subjectKey  = cover
policy      = PREFERRED
source      = USER_EXPLICIT

“quero mais descoberta”
subjectType = DISCOVERY
subjectKey  = global
policy      = PREFERRED
source      = USER_EXPLICIT

“quero menos repetição”
subjectType = REPEAT
subjectKey  = global
policy      = REDUCED
source      = USER_EXPLICIT
```

`subjectKey` is trimmed, cannot be empty, and is limited to 512 characters at the domain boundary. It is intentionally opaque: identity resolution is a separate concern from preference provenance.

---

## 6. Persistence API

New store contract:

```ts
FirstPartyPlaybackPreferenceStore
```

Operations:

```text
set(input)                 // upsert current preference
list(userId, subjectType?) // read current first-party profile
remove(userId, type, key)  // remove explicit preference
```

Prisma implementation:

```ts
prismaFirstPartyPlaybackPreferenceStore
```

The adapter accesses only `FirstPartyPlaybackPreference`.

It does not read/write:

```text
TrackListeningEvent
TrackListeningState
MusicPreferenceSignal
LikedTrackPreference
ArtistAffinityState
```

and performs no provider API call.

---

## 7. Schema/migration safety

New enums:

```text
FirstPartyPreferenceSource
PlaybackPreferenceSubjectType
PlaybackPreferencePolicy
```

New model/table:

```text
FirstPartyPlaybackPreference
```

Migration:

```text
prisma/migrations/20260902165000_first_party_playback_preference/migration.sql
```

Properties:

- additive only;
- no table/column drop;
- no existing-row update;
- no backfill;
- FK uses `ON DELETE CASCADE`, matching user-owned preference lifecycle;
- unique current-state key on `(userId, subjectType, subjectKey)`;
- indexes for profile filtering and source auditing.

The final schema diff against Gate 3 is additive (`+48 / -0`).

---

## 8. Regression tests

### Domain boundary

`first-party-playback-preference.test.ts` covers:

- only the two first-party sources are admitted;
- `SPOTIFY`, `PROVIDER_RESTRICTED` and legacy `LIKED_TRACK_SYNC` are not admitted;
- forged provider source is rejected at runtime;
- both valid sources map to `FIRST_PARTY` lineage;
- canonical subjects/policies remain explicit;
- subject-key normalization;
- normalization never changes source.

### Prisma/domain drift

`first-party-playback-preference-prisma.test.ts` compares the generated Prisma enums with the Gate 4 domain constants.

A schema enum change therefore requires an explicit corresponding domain review instead of silently broadening the first-party boundary.

The existing `test:music-preference` glob already includes these tests; no new package script is required.

---

## 9. Validation status

Performed during this gate:

- branch based exactly on Gate 3 head;
- final GitHub compare reviewed;
- schema final diff confirmed additive (`+48 / -0`);
- migration reviewed as additive/no-backfill;
- isolated TypeScript `strict` compile of the pure Gate 4 domain contract against the Gate 2 root-source shape passed.

Not executed in the connected environment:

```text
prisma generate
prisma validate
npm run test:music-preference
npm run typecheck
npm run build
migration against a database
```

The GitHub connector does not expose a checked-out repository with the project's installed Prisma Client/runtime. These validations remain required before merge/deploy.

---

## 10. Deliberate non-goals

Gate 4 does **not**:

- apply the migration to production;
- expose a UI or HTTP endpoint;
- wire preferences into the planner;
- wire preferences into DISCOVERY/ALBUM;
- alter MUSIC-01/MUSIC-05;
- change Spotify OAuth scopes;
- call/write Spotify;
- convert Saved Tracks into first-party preferences;
- convert `ArtistAffinityState` into first-party profile;
- convert inferred skips into first-party preferences;
- change `confirmProbableLike()`;
- enable AI;
- merge or deploy.

---

## 11. Gate result

**Gate 4: IMPLEMENTED — first-party preference domain/storage created, isolated from Spotify-derived behavior, not merged/deployed.**

Core invariant:

```text
Direct Sonoriza intent
       ↓
USER_EXPLICIT / SONORIZA_INTERACTION
       ↓
FirstPartyPlaybackPreference
       ↓
FIRST_PARTY lineage

Spotify history / Saved Tracks / inferred skips
       X
       X no backfill / no reclassification
       X
FirstPartyPlaybackPreference
```

---

## 12. Next canonical gate

Per #278:

```text
Gate 5 — ajustar analytics/discovery
Garantir que consumers de analytics/profile/recommendation respeitem provenance/capabilities e não usem Spotify-derived behavior na variante compliant.
```

Gate 5 must decide consumer-by-consumer how the new first-party preferences replace or coexist with legacy behavioral paths. It was **not started** in Gate 4.
