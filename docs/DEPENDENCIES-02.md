# DEPENDENCIES-02 — inventory and isolated security patch

Issue #523. Snapshot: 25 October 2026. Base: `fe0fc362b1163ab7bdbcab613515bc98e3cc8c95`.

## Reproducible baseline

The production host was inspected read-only: `srv914260`, Node `24.19.0`,
npm `11.17.0`, clean tracked checkout at the base SHA. Production lockfile
Git blob `ecb7f1d08e3cfbbe9f630b480bcb9af608f8f481` equals the isolated
worktree's base lockfile. No production installation or audit fix was run.
Audit queries were made locally against that lockfile with Node `24.22.1`
and npm `11.19.1`. Audit metadata includes platform-optional packages;
its package counts need not equal the installed Linux package count.

| Audit | Before | Patched branch |
|---|---|---|
| Full tree | 9: 1 critical, 5 high, 3 moderate | 0 |
| `--omit=dev` | 5: 1 critical, 4 high | 0 |

Raw JSON snapshots are in `security/dependencies-02/`. CI repeats both
queries and retains their JSON as an artifact. Zero means no advisories
reported by the registry at that time, not proof of universal security.

## Inventory and exposure assessment

Audit counts affected package entries, including propagated effects, rather
than independent exploits. The nine entries below include two shared chains.

| Package / installed version | Advisory / affected range | Exposure and correction |
|---|---|---|
| `next 15.5.27` (critical) | [GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw), Next 10–15.5.27; [GHSA-p3m5-59mp-jv5r](https://github.com/advisories/GHSA-p3m5-59mp-jv5r), Next 13–15.5.27 | Production framework. Image RCE advisory documents `sharp >=0.35.5` as a workaround; base already pins **0.35.5**, BrandLogo uses unoptimized local WebP, and no `dangerouslyAllowSVG` setting was found. This limits that vector but is not an exploit assessment of the entire deployment. App Router **does** use Server Actions, so the separate DoS advisory is relevant. Patch Next and matching ESLint config to **15.5.28**; preserve the sharp/postcss overrides. |
| `zod 3.25.76` (high) | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), `<4.6.6` | Production input/env validation. Existing Sonoriza Zod schemas use scalar/object validation; no `z.array`, `z.set` or `z.map` use was found, so the collection vector was not demonstrated in current routes. Upgrade to **4.6.7**, because the advisory has no fixed v3 release. |
| `brace-expansion 1.1.18 / 5.0.9` (high) | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p); affected installed v1/v5 ranges | ESLint/minimatch and TypeScript ESLint tooling. No application import found. Lockfile-only compatible updates to **1.1.21 / 5.0.12**; no global override needed. |
| `deepmerge-ts 7.1.5` (high) | [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), `<8.0.0` | Prisma config-loader chain. Cyclic object graphs are required; plain JSON does not create the condition. No application import or project Prisma config file was found. Scoped override under `@prisma/config` to **8.0.0**, with compatibility tests. |
| `@prisma/config 6.19.3` (high) | Propagated from `deepmerge-ts` | Same issue, not another independent exploit. Prisma config loader dynamically imports `deepmerge` as the `c12` merger. Fixed through the scoped override. |
| `prisma 6.19.3` (high) | Propagated through `@prisma/config` | CLI/tool chain, also included by `npm audit --omit=dev` because of the client peer dependency graph; this label alone does not demonstrate request-path use. Preserve Prisma CLI/client/engines **6.19.3**. |
| `postcss-selector-parser 6.1.4` (moderate) | [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf), `<7.1.6` | Tailwind/PostCSS build tooling; no runtime parsing of user CSS found. Override parser to **7.1.6**, preserving Tailwind 3 and verifying CSS compatibility. |
| `postcss-nested 6.2.0` (moderate) | Propagated from selector parser | Same build-time chain; fixed through parser override. |
| `tailwindcss 3.4.19` (moderate) | Propagated from parser/nested | Preserve Tailwind 3; no migration to Tailwind 4. Fixed through parser override. |

No exploit was attempted against production. Exposure descriptions above are
static assessments, not proof that upstream prerequisites can never be met.

## Why this differs from #309 and the initial #523 report

PR #311 / commit `c87d855` recorded 3 high remaining in the **same Prisma →
config → deepmerge chain**. Those are still present in this baseline. The
other six affected package entries are Next (1), Zod (1), brace-expansion (1)
and the CSS parser chain (3). The lockfile did not regress Next to the old
version: commit `6321125` subsequently raised Next to 15.5.27 and sharp to
0.35.5, while today's corrected Next release is 15.5.28.

Advisories and affected ranges have changed since the prior remediation.
The new Next advisories were indexed/updated on 22 October; the Zod advisory
was updated on 23 October. The 23 October deploy reported **8** affected
entries versus today's **9**. The historical eight-entry raw audit was not
preserved in #523; therefore the exact identity/timing of that one-entry
increase cannot be certified from the old count alone. Do not claim that
all nine are the old CVE or that the count increase proves a code regression.

## Compatibility decisions for major dependency changes

This is an explicit, tested selection, not `npm audit fix` or `--force`.

- **Zod 4.6.7:** required by the published fixed range. All nine importing
  source files were reviewed: public string/number/boolean/object/enum,
  `safeParse`, `infer`, and `error.issues` APIs remain available. No legacy
  internal types, error maps, one-argument records or coercion APIs were
  found. Existing signup tests and a new test exercise trimming, defaults,
  unknown-key stripping, required literal consent and rejection. A bounded
  collection regression verifies that oversized input is rejected before
  visiting elements. See the [official migration guide](https://zod.dev/v4/changelog).
  Major-version validation behavior is not claimed identical for every
  possible input; the deployed forms/routes still require normal functional
  smoke testing after a separately authorized release.
- **Deepmerge 8 scoped to Prisma config:** upstream breaking changes concern
  deep Map values, custom utility type names and `deepmergeInto` mutation.
  The reviewed loader uses the plain `deepmerge` API. Tests exercise actual
  Prisma config-file loading, nested plain-object/array merges and cyclic
  graph handling. No Prisma engine/client/schema major upgrade is made.
  See [upstream 8.0.0 notes](https://github.com/RebeccaStevens/deepmerge-ts/releases/tag/v8.0.0).
- **Selector parser 7.1.6:** upstream v7 changes insertion during iteration.
  Tests exercise Tailwind responsive/hover/arbitrary variants and nested
  selectors. A one-off baseline-versus-patched compilation of the complete
  project stylesheet and actual Tailwind config produced identical output:
  **69,719 bytes**, SHA-256
  `290249827295b07185ed595153517313c67736f651f912ac784f849ff95c5cf1`.
  This supports CSS compatibility without a Tailwind 4 migration; it does
  not replace post-release visual smoke testing.

## Validation and release boundary

The dedicated `DEPENDENCIES-02` workflow performs clean `npm ci`, full and
production audits, Prisma validate/generate, security/compatibility tests,
scheduler/cooldown/cleanup/Spotify/podcast/audiobook/planner/notification/PWA
regressions, typecheck, focused lint and production build. The CI job applies
the existing migrations to its disposable PostgreSQL 16 container so tests
gated on `DATABASE_URL` really run. Other integration tests with separate
opt-in flags remain skipped unless enabled. Local tests without a database
skip the guarded DB cases; those skips are not integration-test approval.
No operational database is used. Schema generation/validation do not
migrate or contact a DB.

Local validation results and exact CI head/run URLs are recorded in #523
and the PR. This change contains dependency resolutions, compatibility
tests, CI and evidence only; application source, Prisma models/migrations,
flags, schedules, Spotify provider logic and playlists are unchanged.

The broad regression run exposed two stale assertions in `client.test.ts`;
both were reproduced unchanged on the base checkout. The metrics fixture
omitted the two zero-valued critical-GET counters introduced previously.
The timeout test constructed a client without a user, which now correctly
fails the existing audiobook guard before any transport timeout. The test
now checks that guard explicitly with zero fetch calls and exercises the
admitted transport deadline separately against mocked fetch. No runtime
guard is bypassed or weakened in application code.

Merge, production deployment, flags and any real provider/playlist actions
are separate release decisions. #523 remains open until its release and
health criteria have been met; a zero local audit alone does not close it.
