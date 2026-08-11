from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected one match, got {text.count(old)} for {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# -----------------------------------------------------------------------------
# Configuration readiness / fingerprint.
# -----------------------------------------------------------------------------
CR = "src/services/configuration-readiness.ts"
replace_once(
    CR,
    'import { prisma } from "@/lib/prisma";',
    'import { prisma } from "@/lib/prisma";\nimport { isValidTimeZone } from "@/services/target-schedule";',
)
replace_once(
    CR,
    '''    maxTracksPerArtist: number | null;
    maxTracksPerAlbum: number | null;
  }>;''',
    '''    maxTracksPerArtist: number | null;
    maxTracksPerAlbum: number | null;
    updatePolicy: "MANUAL" | "KEEP_FILLED" | "REBUILD_DAILY";
    dailyScheduleMinutes: number | null;
    scheduleTimezone: string | null;
  }>;''',
)
replace_once(
    CR,
    '''          maxTracksPerArtist: true,
          maxTracksPerAlbum: true,
        },''',
    '''          maxTracksPerArtist: true,
          maxTracksPerAlbum: true,
          updatePolicy: true,
          dailyScheduleMinutes: true,
          scheduleTimezone: true,
        },''',
)
replace_once(
    CR,
    '''    maxTracksPerArtist: target.maxTracksPerArtist,
    maxTracksPerAlbum: target.maxTracksPerAlbum,
  }));''',
    '''    maxTracksPerArtist: target.maxTracksPerArtist,
    maxTracksPerAlbum: target.maxTracksPerAlbum,
    updatePolicy: target.updatePolicy,
    dailyScheduleMinutes: target.dailyScheduleMinutes,
    scheduleTimezone: target.scheduleTimezone,
  }));''',
)
replace_once(
    CR,
    '''    if (!rawTarget.spotifyPlaylistId) {
      pushIssue({''',
    '''    if (rawTarget.updatePolicy !== "MANUAL") {
      if (
        rawTarget.dailyScheduleMinutes === null ||
        !Number.isInteger(rawTarget.dailyScheduleMinutes) ||
        rawTarget.dailyScheduleMinutes < 0 ||
        rawTarget.dailyScheduleMinutes > 1439
      ) {
        pushIssue({
          code: `TARGET_SCHEDULE_REQUIRED:${rawTarget.id}`,
          message: `${label}: informe um horário diário válido para a atualização automática.`,
          href: "/dashboard/configuracao/destinos",
        });
      }
      if (
        !rawTarget.scheduleTimezone?.trim() ||
        !isValidTimeZone(rawTarget.scheduleTimezone)
      ) {
        pushIssue({
          code: `TARGET_SCHEDULE_TIMEZONE_INVALID:${rawTarget.id}`,
          message: `${label}: informe um fuso horário IANA válido para a atualização automática.`,
          href: "/dashboard/configuracao/destinos",
        });
      }
    }

    if (!rawTarget.spotifyPlaylistId) {
      pushIssue({''',
)
replace_once(
    CR,
    '''      maxTracksPerArtist: target.maxTracksPerArtist,
      maxTracksPerAlbum: target.maxTracksPerAlbum,
    })),''',
    '''      maxTracksPerArtist: target.maxTracksPerArtist,
      maxTracksPerAlbum: target.maxTracksPerAlbum,
      updatePolicy: target.updatePolicy,
      dailyScheduleMinutes:
        target.updatePolicy === "MANUAL" ? null : target.dailyScheduleMinutes,
      scheduleTimezone:
        target.updatePolicy === "MANUAL" ? null : target.scheduleTimezone,
    })),''',
)

# Structural regression for the new safety contract.
T = Path("src/services/configuration-readiness.test.ts")
T.write_text(
    T.read_text()
    + r'''

test("SCHEDULE-01 policy, local time and timezone participate in configuration fingerprint", () => {
  const source = readFileSync("src/services/configuration-readiness.ts", "utf8");
  const fingerprintStart = source.indexOf("const fingerprintPayload");
  const fingerprintEnd = source.indexOf("return {", fingerprintStart);
  const fingerprintSource = source.slice(fingerprintStart, fingerprintEnd);
  assert.match(fingerprintSource, /updatePolicy/);
  assert.match(fingerprintSource, /dailyScheduleMinutes/);
  assert.match(fingerprintSource, /scheduleTimezone/);
});

test("SCHEDULE-01 scheduler excludes MANUAL targets and uses auditable daily slots", () => {
  const source = readFileSync("src/jobs/scheduled-generation.ts", "utf8");
  assert.match(source, /updatePolicy:\s*\{\s*not:\s*"MANUAL"/);
  assert.match(source, /dailyScheduleSlot/);
  assert.match(source, /targetScheduleRun/);
  assert.match(source, /scheduleKey/);
});

test("SCHEDULE-01 KEEP_FILLED revalidates target snapshot before any incremental mutation", () => {
  const source = readFileSync("src/jobs/generate-playlists-incremental.ts", "utf8");
  const preflight = source.indexOf("keepFilledSnapshotViolations");
  const append = source.indexOf("appendPlaylistItems");
  const remove = source.indexOf("removePlaylistItems");
  assert.ok(preflight >= 0);
  assert.ok(append > preflight);
  assert.ok(remove > preflight);
});
'''
)

# Planner regression: preserved valid content is the starting state, not rebuilt.
P = Path("src/services/playlist-planner/planner.test.ts")
P.write_text(
    P.read_text()
    + r'''

test("#58 KEEP_FILLED starts from preserved valid content and fills only the deficit", () => {
  const preserved = music("preserved", 180_000);
  const pools = {
    music: [music("new-1", 180_000), music("new-2", 180_000)],
    podcasts: [],
  };
  const result = planPlaylist({
    rules: rules({ targetDurationMs: 540_000, podcastPercent: 0 }),
    pools,
    preserved: [preserved],
  });
  assert.equal(result.items[0]?.uri, preserved.uri);
  assert.equal(result.items.length, 3);
  assert.equal(result.stats.totalDurationMs, 540_000);
  assert.equal(result.items.filter((item) => item.uri === preserved.uri).length, 1);
});

test("#58 KEEP_FILLED sequence resumes from the slot after the preserved prefix", () => {
  const preservedMusic = music("preserved-sequence", 180_000);
  const nextPodcast = podcast("next-podcast", 180_000, "program-next");
  const result = planPlaylist({
    rules: rules({
      targetDurationMs: 360_000,
      compositionMode: "SEQUENCE",
      sequencePattern: ["MUSIC", "PODCAST"],
    }),
    pools: { music: [], podcasts: [nextPodcast] },
    preserved: [preservedMusic],
  });
  assert.deepEqual(result.items.map((item) => item.type), ["MUSIC", "PODCAST"]);
  assert.equal(result.items[0]?.uri, preservedMusic.uri);
});
'''
)

# Provenance must describe real playlist writes, never a simulation snapshot.
replace_once(
    "src/services/keep-filled-maintenance.ts",
    '''          where: {
            userId,
            items: { some: { targetPlaylistId: target.id } },
          },''',
    '''          where: {
            userId,
            simulation: false,
            status: { in: ["SUCCESS", "PARTIAL"] },
            items: { some: { targetPlaylistId: target.id } },
          },''',
)

# Scheduler Prisma update typing.
SG = "src/jobs/scheduled-generation.ts"
replace_once(
    SG,
    '''import type {
  TargetPlaylist,
  TargetScheduleRun,
  TargetScheduleRunStatus,
} from "@prisma/client";''',
    '''import type {
  Prisma,
  TargetPlaylist,
  TargetScheduleRun,
  TargetScheduleRunStatus,
} from "@prisma/client";''',
)
replace_once(
    SG,
    '''  data: Record<string, unknown> = {},
) {''',
    '''  data: Prisma.TargetScheduleRunUpdateInput = {},
) {''',
)

# -----------------------------------------------------------------------------
# CONFIG-03 form.
# -----------------------------------------------------------------------------
FORM = "src/components/TargetPlaylistForm.tsx"
replace_once(FORM, 'import { useState } from "react";', 'import { useEffect, useState } from "react";')
replace_once(
    FORM,
    'type MusicOrderMode = "STANDARD" | "RANDOMIZED";',
    'type MusicOrderMode = "STANDARD" | "RANDOMIZED";\ntype TargetUpdatePolicy = "MANUAL" | "KEEP_FILLED" | "REBUILD_DAILY";',
)
replace_once(
    FORM,
    '''  maxTracksPerArtist: number | null;
  maxTracksPerAlbum: number | null;
  destinationValue: string;''',
    '''  maxTracksPerArtist: number | null;
  maxTracksPerAlbum: number | null;
  updatePolicy: TargetUpdatePolicy;
  dailyScheduleTime: string;
  scheduleTimezone: string;
  destinationValue: string;''',
)
replace_once(
    FORM,
    '''  const [albumDiversityEnabled, setAlbumDiversityEnabled] = useState(
    initial.maxTracksPerAlbum !== null,
  );
  const [podcastPercent,''',
    '''  const [albumDiversityEnabled, setAlbumDiversityEnabled] = useState(
    initial.maxTracksPerAlbum !== null,
  );
  const [updatePolicy, setUpdatePolicy] = useState<TargetUpdatePolicy>(
    initial.updatePolicy,
  );
  const [scheduleTimezone, setScheduleTimezone] = useState(initial.scheduleTimezone);
  const [podcastPercent,''',
)
replace_once(
    FORM,
    '''  const musicPercent = 100 - podcastPercent;
  const idPrefix = initial.id ?? "new-target";
''',
    '''  const musicPercent = 100 - podcastPercent;
  const idPrefix = initial.id ?? "new-target";

  useEffect(() => {
    if (updatePolicy === "MANUAL" || scheduleTimezone) return;
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected) setScheduleTimezone(detected);
  }, [scheduleTimezone, updatePolicy]);
''',
)

anchor = '''      <fieldset>
        <legend className="text-sm font-black text-ink-inverse">Como definir a duração?</legend>'''
schedule_ui = '''      <fieldset className={sectionClass}>
        <legend className="px-1 text-sm font-black text-ink-inverse">
          Atualização automática
        </legend>
        <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
          A política é por destino. Salvar esta tela nunca executa a playlist imediatamente.
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-3">
          {(
            [
              ["MANUAL", "Somente manual", "Só muda quando você iniciar uma geração."],
              [
                "KEEP_FILLED",
                "Manter playlist completa",
                "Preserva o que ainda vale, remove o que deixou de valer e completa apenas o déficit.",
              ],
              [
                "REBUILD_DAILY",
                "Refazer diariamente",
                "Planeja do zero e substitui a playlist somente depois dos gates de segurança.",
              ],
            ] as const
          ).map(([value, title, description]) => (
            <label key={value} className={optionClass(updatePolicy === value)}>
              <input
                type="radio"
                name="updatePolicy"
                value={value}
                checked={updatePolicy === value}
                onChange={() => setUpdatePolicy(value)}
                className="sr-only"
              />
              <span className="block font-black text-ink-inverse">{title}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                {description}
              </span>
            </label>
          ))}
        </div>

        {updatePolicy !== "MANUAL" && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className={fieldLabelClass}>
              Horário diário
              <input
                className={inputClass}
                type="time"
                name="dailyScheduleTime"
                required
                defaultValue={initial.dailyScheduleTime || "04:30"}
              />
              <span className={helperClass}>
                Se o dispatcher perder o minuto exato, o Sonoriza ainda executa o slot pendente no mesmo dia.
              </span>
            </label>
            <label className={fieldLabelClass}>
              Fuso horário
              <input
                className={inputClass}
                name="scheduleTimezone"
                required
                value={scheduleTimezone}
                onChange={(event) => setScheduleTimezone(event.target.value)}
                placeholder="America/Sao_Paulo"
              />
              <span className={helperClass}>
                Use um fuso IANA. O navegador preenche automaticamente quando possível.
              </span>
            </label>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className="text-sm font-black text-ink-inverse">Como definir a duração?</legend>'''
replace_once(FORM, anchor, schedule_ui)

# -----------------------------------------------------------------------------
# CONFIG-03 server validation, storage and visible audit/next-run.
# -----------------------------------------------------------------------------
PAGE = "src/app/dashboard/configuracao/destinos/page.tsx"
replace_once(
    PAGE,
    '''import {
  SpotifyClient,
  type SpotifyPlaylistSummary,
} from "@/services/spotify";''',
    '''import {
  SpotifyClient,
  type SpotifyPlaylistSummary,
} from "@/services/spotify";
import {
  dailyScheduleSlot,
  formatScheduleTime,
  isValidTimeZone,
  nextScheduleLabel,
  parseScheduleTime,
} from "@/services/target-schedule";''',
)
replace_once(
    PAGE,
    '''  const musicOrderMode = String(formData.get("musicOrderMode") ?? "STANDARD").trim();
  const emptyCalendarBehavior = String(''',
    '''  const musicOrderMode = String(formData.get("musicOrderMode") ?? "STANDARD").trim();
  const updatePolicy = String(formData.get("updatePolicy") ?? "MANUAL").trim();
  const dailyScheduleTime = String(formData.get("dailyScheduleTime") ?? "").trim();
  const scheduleTimezone = String(formData.get("scheduleTimezone") ?? "").trim();
  const emptyCalendarBehavior = String(''',
)
replace_once(
    PAGE,
    '''  if (!normalizedMusicOrderMode) fail("invalid");
  if (!sequencePattern || podcastPercent === null || maxEpisodesPerProgram === null) {''',
    '''  if (!normalizedMusicOrderMode) fail("invalid");
  const normalizedUpdatePolicy =
    updatePolicy === "MANUAL" ||
    updatePolicy === "KEEP_FILLED" ||
    updatePolicy === "REBUILD_DAILY"
      ? updatePolicy
      : null;
  if (!normalizedUpdatePolicy) fail("schedule");
  const dailyScheduleMinutes =
    normalizedUpdatePolicy === "MANUAL" ? null : parseScheduleTime(dailyScheduleTime);
  if (
    normalizedUpdatePolicy !== "MANUAL" &&
    (dailyScheduleMinutes === null || !isValidTimeZone(scheduleTimezone))
  ) {
    fail("schedule");
  }
  if (!sequencePattern || podcastPercent === null || maxEpisodesPerProgram === null) {''',
)
replace_once(
    PAGE,
    '''    maxTracksPerArtist,
    maxTracksPerAlbum,
  } as const;''',
    '''    maxTracksPerArtist,
    maxTracksPerAlbum,
    updatePolicy: normalizedUpdatePolicy,
    dailyScheduleMinutes,
    scheduleTimezone:
      normalizedUpdatePolicy === "MANUAL" ? null : scheduleTimezone,
  } as const;''',
)
replace_once(
    PAGE,
    '''    prisma.targetPlaylist.findMany({
      where: { userId },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    }),''',
    '''    prisma.targetPlaylist.findMany({
      where: { userId },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      include: {
        targetScheduleRuns: {
          orderBy: { startedAt: "desc" },
          take: 1,
        },
      },
    }),''',
)
replace_once(
    PAGE,
    '''            : params.error === "source-conflict"
              ? "Essa playlist já é uma fonte de conteúdo.''',
    '''            : params.error === "schedule"
              ? "Revise a política automática, o horário diário e o fuso horário do destino."
              : params.error === "source-conflict"
              ? "Essa playlist já é uma fonte de conteúdo.''',
)
replace_once(
    PAGE,
    '''                  maxTracksPerArtist: null,
                  maxTracksPerAlbum: null,
                  destinationValue: CREATE_NEW,''',
    '''                  maxTracksPerArtist: null,
                  maxTracksPerAlbum: null,
                  updatePolicy: "MANUAL",
                  dailyScheduleTime: "04:30",
                  scheduleTimezone: "",
                  destinationValue: CREATE_NEW,''',
)
replace_once(
    PAGE,
    '''                const sequencePattern = parseSequencePattern(target.sequencePattern);

                return (''',
    '''                const sequencePattern = parseSequencePattern(target.sequencePattern);
                const latestSchedule = target.targetScheduleRuns[0] ?? null;
                const schedule = schedulePresentation(target, latestSchedule);

                return (''',
)
replace_once(
    PAGE,
    '''                          {` · ${musicDiversityLabel(target)}`}
                        </p>
                        <p className="mt-1 text-xs text-muted-inverse/65">''',
    '''                          {` · ${musicDiversityLabel(target)}`}
                          {` · ${schedule.policy}`}
                        </p>
                        {schedule.audit && (
                          <p className="mt-1 text-xs text-muted-inverse/65">
                            {schedule.audit}
                          </p>
                        )}
                        <p className="mt-1 text-xs text-muted-inverse/65">''',
)
replace_once(
    PAGE,
    '''                            maxTracksPerArtist: target.maxTracksPerArtist,
                            maxTracksPerAlbum: target.maxTracksPerAlbum,
                            destinationValue:''',
    '''                            maxTracksPerArtist: target.maxTracksPerArtist,
                            maxTracksPerAlbum: target.maxTracksPerAlbum,
                            updatePolicy: target.updatePolicy,
                            dailyScheduleTime:
                              target.dailyScheduleMinutes === null
                                ? "04:30"
                                : formatScheduleTime(target.dailyScheduleMinutes),
                            scheduleTimezone: target.scheduleTimezone ?? "",
                            destinationValue:''',
)

# Add presentation helper before page component.
replace_once(
    PAGE,
    '''export default async function DestinationsPage({ searchParams }: DestinationsPageProps) {''',
    '''function schedulePresentation(
  target: {
    id: string;
    updatePolicy: "MANUAL" | "KEEP_FILLED" | "REBUILD_DAILY";
    dailyScheduleMinutes: number | null;
    scheduleTimezone: string | null;
  },
  latest: {
    status: string;
    scheduledLocalDate: string;
    finishedAt: Date | null;
    preservedCount: number;
    removedCount: number;
    addedCount: number;
    reason: string | null;
  } | null,
): { policy: string; audit: string | null } {
  if (target.updatePolicy === "MANUAL") {
    return { policy: "atualização manual", audit: null };
  }
  const label =
    target.updatePolicy === "KEEP_FILLED"
      ? "manter completa"
      : "refazer diariamente";
  const minutes = target.dailyScheduleMinutes;
  const timeZone = target.scheduleTimezone ?? "";
  if (minutes === null || !isValidTimeZone(timeZone)) {
    return { policy: `${label} · agenda inválida`, audit: null };
  }
  const now = new Date();
  const slot = dailyScheduleSlot(target.id, minutes, timeZone, now);
  const completedToday = Boolean(
    latest &&
      latest.scheduledLocalDate === slot.localDate &&
      ["SUCCESS", "NOOP", "PARTIAL"].includes(latest.status),
  );
  const next = nextScheduleLabel(minutes, timeZone, now, completedToday);
  if (!latest) {
    return {
      policy: `${label} às ${formatScheduleTime(minutes)}`,
      audit: `Ainda sem execução automática · próxima: ${next}`,
    };
  }
  const finished = latest.finishedAt
    ? new Intl.DateTimeFormat("pt-BR", {
        timeZone,
        dateStyle: "short",
        timeStyle: "short",
      }).format(latest.finishedAt)
    : "em andamento";
  const movement = `preservados ${latest.preservedCount} · removidos ${latest.removedCount} · adicionados ${latest.addedCount}`;
  return {
    policy: `${label} às ${formatScheduleTime(minutes)}`,
    audit: `Última automática: ${latest.status} em ${finished} · ${movement}${
      latest.reason ? ` · ${latest.reason}` : ""
    } · próxima: ${next}`,
  };
}

export default async function DestinationsPage({ searchParams }: DestinationsPageProps) {''',
)

# -----------------------------------------------------------------------------
# Deployment docs: server cron becomes a frequent dispatcher; target owns time.
# -----------------------------------------------------------------------------
DOC = "docs/DEPLOYMENT.md"
replace_once(
    DOC,
    '''## 4. Scheduled generation (server cron)

The daily run is an authenticated HTTP call. Add a crontab entry (adjust the
time to your timezone):

```cron
# Every day at 04:30 — regenerate all allowed users' playlists
30 4 * * * curl -fsS -X POST https://<host>/api/cron/generate \\
  -H "Authorization: Bearer <CRON_SECRET>" >> /home/<user>/logs/sonoriza-cron.log 2>&1
```

`<CRON_SECRET>` must match the value in `.env`. Alternatively, run the engine
directly as a Node process:

```cron
30 4 * * * cd /path/to/sonoriza && npm run generate:run -- --user <userId> >> ... 2>&1
```''',
    '''## 4. Scheduled generation (server cron)

SCHEDULE-01 turns the server cron into a **dispatcher**, not the authority for a
single global generation time. Each target owns its policy (`MANUAL`,
`KEEP_FILLED` or `REBUILD_DAILY`), daily local time and IANA timezone. Run the
dispatcher frequently enough to pick up due slots:

```cron
# Every 5 minutes — dispatch only due automatic targets
*/5 * * * * curl -fsS -X POST https://<host>/api/cron/generate \\
  -H "Authorization: Bearer <CRON_SECRET>" >> /home/<user>/logs/sonoriza-cron.log 2>&1
```

`<CRON_SECRET>` must match the value in `.env`. A unique target/local-date audit
slot makes successful/no-op maintenance idempotent: repeated dispatcher calls do
not run the same daily slot twice. A missed exact minute remains due later on the
same local day. `MANUAL` targets are ignored by this endpoint.

`KEEP_FILLED` reads the current target under a stable Spotify snapshot, preserves
valid content, fills only the deficit and prefers append/remove mutations. It
falls back to a full replacement only when an incremental URI mutation would be
ambiguous. `REBUILD_DAILY` uses the normal generation pipeline and the same
current simulation/fingerprint/quality gate as a manual real run.

The direct `npm run generate:run` command remains a manual operator tool; it is
not a replacement for the SCHEDULE-01 dispatcher because it does not claim daily
per-target schedule slots.''',
)

print("SCHEDULE-01 stage4 patch applied")
