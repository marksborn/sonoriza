# Issue #278 — Gate 3 hard guard AI

**SPOTIFY-COMPLIANCE-01 — separar Spotify de analytics derivados, perfis e IA**

- Date: 2026-09-02
- Base: Gate 2 `c65d1355f087dd73253299086267ca4072440623`
- Branch: `issue-278-gate3-ai-guard`
- Canonical scope: **hard guard AI only**
- Runtime AI/LLM integration added: **none**
- Spotify calls/writes: **none**
- Prisma schema/migration: **none**
- Planner/discovery behavior change: **none**
- OAuth scope change: **none**

> Gate 3 implements the architectural barrier required by #278: Spotify lineage must not be ingested by AI/LLM/Tião Brain. It does not create an AI feature and it does not make a legal determination.

---

## 1. Scope alignment

The canonical #278 gate definition is:

```text
Gate 3 — hard guard AI
Impedir tecnicamente qualquer ingestão de Spotify lineage em IA.
```

`EXTERNAL_EXPORT` remains part of the Gate 2 `PolicyUse` vocabulary, but Gate 3 does **not** add an export guard. That concern must be handled by its own approved scope instead of being silently bundled into this gate.

---

## 2. New hard boundary

File:

```text
src/services/data-policy/ai-ingestion-guard.ts
```

The module exposes one policy use:

```ts
AI_INGESTION_POLICY_USE = "AI"
```

and three levels of API.

### Read-only evaluation

```ts
evaluateAiIngestion(lineage)
```

- normalizes lineage through the Gate 2 contract;
- empty lineage becomes `UNKNOWN`;
- returns the Gate 2 `PolicyDecision`;
- performs no external side effect.

### Authorization

```ts
authorizeAiIngestion(lineage)
```

- `ALLOW` -> returns a nominal `AiIngestionAuthorization` token;
- `REVIEW_REQUIRED` -> throws `AiIngestionPolicyError`;
- `DENY` -> throws `AiIngestionPolicyError`.

The authorization token is branded by a module-private `Symbol`. Future AI adapters should require this token rather than accepting raw lineage directly.

This does not make bypass impossible against malicious TypeScript casts, but it prevents normal structural construction and creates one explicit code-review boundary.

### Side-effect boundary

```ts
runAiIngestion(lineage, operation)
```

The operation callback is invoked **only after** `authorizeAiIngestion()` succeeds. Therefore callers do not have to remember to validate after an LLM/provider call has already happened.

The generic return type also supports an async operation because `T` may be a `Promise`.

---

## 3. Fail-closed behavior

Current Gate 2 policy produces the following important results for `AI`:

```text
FIRST_PARTY     -> REVIEW_REQUIRED -> BLOCK
SPOTIFY         -> DENY            -> BLOCK
LASTFM          -> REVIEW_REQUIRED -> BLOCK
OTHER_PROVIDER  -> REVIEW_REQUIRED -> BLOCK
USER_IMPORT     -> REVIEW_REQUIRED -> BLOCK
UNKNOWN         -> DENY            -> BLOCK
```

Therefore **no current origin is AI-enabled by Gate 3**.

That is deliberate. Gate 3 is a barrier, not an AI enablement gate. A future first-party/appropriately licensed AI feature must first introduce an explicit reviewed capability/policy change; it must not become allowed merely because the source is not Spotify.

---

## 4. Spotify laundering prevention

Gate 2 already defines lineage as the union of contributing origins and uses the most restrictive decision.

Gate 3 consumes that result directly.

Example:

```text
USER_EXPLICIT + SPOTIFY_RECENTLY_PLAYED
              ↓
      [FIRST_PARTY, SPOTIFY]
              ↓
            AI
              ↓
            DENY
```

The final payload does not need to contain the original Spotify JSON for the guard to block it. If Spotify contributed to the derived value and lineage was propagated correctly, the AI boundary rejects it.

This is the central protection against laundering Spotify-origin data through an aggregate/profile table.

---

## 5. Regression tests

File:

```text
src/services/data-policy/ai-ingestion-guard.test.ts
```

Coverage added for:

1. Gate 3 is scoped to `AI`;
2. empty lineage normalizes to `UNKNOWN` and is denied;
3. Spotify Recently Played lineage is denied;
4. first-party `REVIEW_REQUIRED` is still blocked;
5. mixed `FIRST_PARTY + SPOTIFY` cannot be laundered into AI;
6. blocked ingestion never invokes the side-effect callback;
7. every currently declared `DataOrigin` is fail-closed for AI until an explicit policy change is reviewed.

The existing Gate 2 script already includes all tests under this directory:

```text
npm run test:data-policy
```

so no package-script change was required in Gate 3.

---

## 6. Validation performed in this gate

A strict TypeScript compile check of the new guard contract against the Gate 2 interface passed in an isolated read-only validation environment.

The connected GitHub environment used for this gate does not expose a checked-out repository/runtime process, so the full repository `npm run test:data-policy`, build and application runtime were **not executed here**. The committed tests are deterministic and require no provider calls.

No GitHub Actions run existed/was triggered as part of this gate.

---

## 7. What Gate 3 deliberately does not do

Gate 3 does not:

- add OpenAI/Anthropic/other LLM dependencies;
- add Tião Brain integration;
- send any user/provider payload to AI;
- add an external-export guard;
- alter Spotify OAuth scopes;
- alter Recently Played, Saved Tracks or Extended History ingestion;
- modify MUSIC-01, MUSIC-05, DISCOVERY, ALBUM or podcast planner behavior;
- add/change Prisma models;
- migrate/delete existing data;
- create a production AI capability override;
- merge or deploy anything.

---

## 8. Gate result

**Gate 3: IMPLEMENTED — ready for repository test/review, not merged.**

The technical AI boundary now exists. Its key invariant is:

```text
AI side effect
     ↑
AiIngestionAuthorization required
     ↑
authorizeAiIngestion(lineage)
     ↑
Gate 2 policy
     ↑
Spotify in lineage => DENY
UNKNOWN lineage    => DENY
REVIEW_REQUIRED    => BLOCK
```

---

## 9. Next canonical gate

Per #278, the next gate is:

```text
Gate 4 — separar perfil first-party
Criar preferências explícitas do Sonoriza independentes de Spotify-derived behavior.
```

Gate 4 should remain isolated from the current Spotify-derived affinity/profile models and should not reclassify legacy `LIKED_TRACK_SYNC`/Spotify-derived aggregates as first-party intent.
