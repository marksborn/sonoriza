from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, content: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(content)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, got {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def replace_between(path: str, start: str, end: str, replacement: str) -> None:
    text = read(path)
    start_index = text.find(start)
    if start_index < 0:
        raise RuntimeError(f"{path}: start marker not found: {start!r}")
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise RuntimeError(f"{path}: end marker not found: {end!r}")
    write(path, text[:start_index] + replacement + text[end_index:])


# ---------------------------------------------------------------------------
# Prisma schema + migration
# ---------------------------------------------------------------------------

schema = "prisma/schema.prisma"
replace_once(
    schema,
    "  user            User             @relation(fields: [userId], references: [id], onDelete: Cascade)\n  targetPlaylists TargetPlaylist[]\n",
    "  user                    User                     @relation(fields: [userId], references: [id], onDelete: Cascade)\n  targetPlaylistCalendars TargetPlaylistCalendar[]\n",
)
replace_once(
    schema,
    "enum CalendarDurationStrategy {\n  SUMMED\n  PER_EVENT\n}\n",
    "enum CalendarDurationStrategy {\n  SUMMED\n  PER_EVENT\n}\n\nenum TargetCalendarMode {\n  LEGACY_GLOBAL\n  SELECTED\n  ALL_QUERYABLE\n}\n",
)
replace_once(
    schema,
    "  fixedDurationSeconds             Int?\n  calendarSelectionId              String?\n  emptyCalendarBehavior            EmptyCalendarBehavior         @default(CLEAR)\n",
    "  fixedDurationSeconds             Int?\n  calendarMode                     TargetCalendarMode             @default(LEGACY_GLOBAL)\n  emptyCalendarBehavior            EmptyCalendarBehavior         @default(CLEAR)\n",
)
replace_once(
    schema,
    "  user               User                @relation(fields: [userId], references: [id], onDelete: Cascade)\n  calendarSelection  CalendarSelection?  @relation(fields: [calendarSelectionId], references: [id], onDelete: SetNull)\n  generationItems    GenerationItem[]\n  targetScheduleRuns TargetScheduleRun[]\n\n  @@index([userId, priority])\n  @@index([calendarSelectionId])\n}\n",
    "  user               User                     @relation(fields: [userId], references: [id], onDelete: Cascade)\n  calendarSelections TargetPlaylistCalendar[]\n  generationItems    GenerationItem[]\n  targetScheduleRuns TargetScheduleRun[]\n\n  @@index([userId, priority])\n}\n\nmodel TargetPlaylistCalendar {\n  targetPlaylistId    String\n  calendarSelectionId String\n  createdAt           DateTime @default(now())\n\n  targetPlaylist    TargetPlaylist    @relation(fields: [targetPlaylistId], references: [id], onDelete: Cascade)\n  calendarSelection CalendarSelection @relation(fields: [calendarSelectionId], references: [id], onDelete: Cascade)\n\n  @@id([targetPlaylistId, calendarSelectionId])\n  @@index([calendarSelectionId])\n}\n",
)

migration = "prisma/migrations/20260825171000_target_multi_calendar_selection/migration.sql"
if Path(migration).exists():
    raise RuntimeError(f"{migration}: already exists")
write(
    migration,
    '''-- CALENDAR #127 Gate 3
-- Evolve the single TargetPlaylist -> CalendarSelection binding to an explicit
-- multi-calendar scope while preserving every Gate 2 binding and legacy target.

CREATE TYPE "TargetCalendarMode" AS ENUM ('LEGACY_GLOBAL', 'SELECTED', 'ALL_QUERYABLE');

ALTER TABLE "TargetPlaylist"
ADD COLUMN "calendarMode" "TargetCalendarMode" NOT NULL DEFAULT 'LEGACY_GLOBAL';

CREATE TABLE "TargetPlaylistCalendar" (
    "targetPlaylistId" TEXT NOT NULL,
    "calendarSelectionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TargetPlaylistCalendar_pkey" PRIMARY KEY ("targetPlaylistId", "calendarSelectionId")
);

CREATE INDEX "TargetPlaylistCalendar_calendarSelectionId_idx"
ON "TargetPlaylistCalendar"("calendarSelectionId");

ALTER TABLE "TargetPlaylistCalendar"
ADD CONSTRAINT "TargetPlaylistCalendar_targetPlaylistId_fkey"
FOREIGN KEY ("targetPlaylistId") REFERENCES "TargetPlaylist"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TargetPlaylistCalendar"
ADD CONSTRAINT "TargetPlaylistCalendar_calendarSelectionId_fkey"
FOREIGN KEY ("calendarSelectionId") REFERENCES "CalendarSelection"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "TargetPlaylistCalendar" ("targetPlaylistId", "calendarSelectionId")
SELECT "id", "calendarSelectionId"
FROM "TargetPlaylist"
WHERE "calendarSelectionId" IS NOT NULL;

UPDATE "TargetPlaylist"
SET "calendarMode" = 'SELECTED'
WHERE "calendarSelectionId" IS NOT NULL;

ALTER TABLE "TargetPlaylist"
DROP CONSTRAINT "TargetPlaylist_calendarSelectionId_fkey";

DROP INDEX "TargetPlaylist_calendarSelectionId_idx";

ALTER TABLE "TargetPlaylist"
DROP COLUMN "calendarSelectionId";
''',
)

# ---------------------------------------------------------------------------
# Pure calendar-scope contract + tests
# ---------------------------------------------------------------------------

write(
    "src/services/target-calendar-selection.ts",
    '''export type TargetCalendarScopeMode =
  | "SELECTED"
  | "ALL_QUERYABLE"
  | "LEGACY_GLOBAL";

export type TargetCalendarScope = {
  mode: TargetCalendarScopeMode;
  calendarIds: string[];
};

export function normalizeTargetCalendarSelectionIds(
  values: readonly string[],
): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

/**
 * CALENDAR #127 Gate 3 scope resolver.
 *
 * SELECTED uses exactly the calendars linked to this destination.
 * ALL_QUERYABLE dynamically follows every CalendarSelection marked selected.
 * LEGACY_GLOBAL exists only for old calendar-driven targets not migrated yet.
 *
 * The resolver deliberately does not invent a fallback when SELECTED or
 * ALL_QUERYABLE resolve to an empty set; callers must fail closed instead.
 */
export function resolveTargetCalendarScope(input: {
  mode: TargetCalendarScopeMode;
  selectedGoogleCalendarIds: readonly string[];
  queryableCalendarIds: readonly string[];
  legacyDurationCalendarIds: readonly string[];
}): TargetCalendarScope {
  const calendarIds =
    input.mode === "SELECTED"
      ? normalizeTargetCalendarSelectionIds(input.selectedGoogleCalendarIds)
      : input.mode === "ALL_QUERYABLE"
        ? normalizeTargetCalendarSelectionIds(input.queryableCalendarIds)
        : normalizeTargetCalendarSelectionIds(input.legacyDurationCalendarIds);

  return { mode: input.mode, calendarIds };
}

export function targetCalendarScopesEqual(
  left: TargetCalendarScope,
  right: TargetCalendarScope,
): boolean {
  return (
    left.mode === right.mode &&
    left.calendarIds.length === right.calendarIds.length &&
    left.calendarIds.every((id, index) => id === right.calendarIds[index])
  );
}

/**
 * A target may remain LEGACY_GLOBAL only if it was already CALENDAR + legacy
 * before this save. FIXED targets and already-migrated targets cannot create a
 * new legacy fallback.
 */
export function canPreserveLegacyTargetCalendar(input: {
  durationMode: "FIXED" | "CALENDAR";
  calendarMode: TargetCalendarScopeMode;
} | null): boolean {
  return Boolean(
    input?.durationMode === "CALENDAR" && input.calendarMode === "LEGACY_GLOBAL",
  );
}
''',
)

write(
    "src/jobs/target-calendar-selection.test.ts",
    '''import assert from "node:assert/strict";
import test from "node:test";

import {
  canPreserveLegacyTargetCalendar,
  normalizeTargetCalendarSelectionIds,
  resolveTargetCalendarScope,
  targetCalendarScopesEqual,
} from "@/services/target-calendar-selection";

test("selected mode uses one or many explicit calendars and deduplicates identity", () => {
  assert.deepEqual(
    resolveTargetCalendarScope({
      mode: "SELECTED",
      selectedGoogleCalendarIds: ["work", "personal", "work"],
      queryableCalendarIds: ["work", "personal", "travel"],
      legacyDurationCalendarIds: ["legacy"],
    }),
    {
      mode: "SELECTED",
      calendarIds: ["personal", "work"],
    },
  );
});

test("all-queryable mode dynamically follows the complete queryable set", () => {
  assert.deepEqual(
    resolveTargetCalendarScope({
      mode: "ALL_QUERYABLE",
      selectedGoogleCalendarIds: ["work"],
      queryableCalendarIds: ["travel", "personal", "work"],
      legacyDurationCalendarIds: ["legacy"],
    }),
    {
      mode: "ALL_QUERYABLE",
      calendarIds: ["personal", "travel", "work"],
    },
  );
});

test("legacy mode preserves only the old global duration set", () => {
  assert.deepEqual(
    resolveTargetCalendarScope({
      mode: "LEGACY_GLOBAL",
      selectedGoogleCalendarIds: ["work"],
      queryableCalendarIds: ["work", "personal"],
      legacyDurationCalendarIds: ["legacy-b", "legacy-a"],
    }),
    {
      mode: "LEGACY_GLOBAL",
      calendarIds: ["legacy-a", "legacy-b"],
    },
  );
});

test("explicit modes never invent legacy fallback when their set is empty", () => {
  assert.deepEqual(
    resolveTargetCalendarScope({
      mode: "SELECTED",
      selectedGoogleCalendarIds: [],
      queryableCalendarIds: ["queryable"],
      legacyDurationCalendarIds: ["legacy"],
    }),
    { mode: "SELECTED", calendarIds: [] },
  );
  assert.deepEqual(
    resolveTargetCalendarScope({
      mode: "ALL_QUERYABLE",
      selectedGoogleCalendarIds: ["selected"],
      queryableCalendarIds: [],
      legacyDurationCalendarIds: ["legacy"],
    }),
    { mode: "ALL_QUERYABLE", calendarIds: [] },
  );
});

test("only an already calendar-driven legacy target may preserve legacy mode", () => {
  assert.equal(
    canPreserveLegacyTargetCalendar({
      durationMode: "CALENDAR",
      calendarMode: "LEGACY_GLOBAL",
    }),
    true,
  );
  assert.equal(
    canPreserveLegacyTargetCalendar({
      durationMode: "FIXED",
      calendarMode: "LEGACY_GLOBAL",
    }),
    false,
  );
  assert.equal(
    canPreserveLegacyTargetCalendar({
      durationMode: "CALENDAR",
      calendarMode: "SELECTED",
    }),
    false,
  );
  assert.equal(canPreserveLegacyTargetCalendar(null), false);
});

test("scope comparison is deterministic regardless of original selection order", () => {
  const left = resolveTargetCalendarScope({
    mode: "SELECTED",
    selectedGoogleCalendarIds: ["b", "a"],
    queryableCalendarIds: [],
    legacyDurationCalendarIds: [],
  });
  const right = resolveTargetCalendarScope({
    mode: "SELECTED",
    selectedGoogleCalendarIds: normalizeTargetCalendarSelectionIds(["a", "b"]),
    queryableCalendarIds: [],
    legacyDurationCalendarIds: [],
  });
  assert.equal(targetCalendarScopesEqual(left, right), true);
});
''',
)

# ---------------------------------------------------------------------------
# Target form: multi-select / all-queryable / legacy UI
# ---------------------------------------------------------------------------

form = "src/components/TargetPlaylistForm.tsx"
replace_once(
    form,
    'type CalendarDurationStrategy = "SUMMED" | "PER_EVENT";\n',
    'type CalendarDurationStrategy = "SUMMED" | "PER_EVENT";\ntype TargetCalendarMode = "LEGACY_GLOBAL" | "SELECTED" | "ALL_QUERYABLE";\n',
)
replace_once(
    form,
    "  fixedDurationMinutes: number;\n  calendarSelectionId: string | null;\n  allowLegacyCalendar: boolean;\n",
    "  fixedDurationMinutes: number;\n  calendarMode: TargetCalendarMode;\n  calendarSelectionIds: string[];\n  allowLegacyCalendar: boolean;\n",
)
replace_once(
    form,
    "  const [durationMode, setDurationMode] = useState<DurationMode>(initial.durationMode);\n",
    "  const [durationMode, setDurationMode] = useState<DurationMode>(initial.durationMode);\n  const [calendarMode, setCalendarMode] = useState<TargetCalendarMode>(initial.calendarMode);\n  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>(\n    initial.calendarSelectionIds,\n  );\n",
)
replace_once(
    form,
    "              Usa somente o calendário escolhido para esta playlist, exceto destinos legados ainda não migrados.\n",
    "              Cada playlist pode usar uma ou várias agendas, ou acompanhar automaticamente todas as agendas consultáveis.\n",
)
calendar_start = '          <label className={`block max-w-xl ${fieldLabelClass}`}>\n            Calendário desta playlist\n'
calendar_end = '          <fieldset className={sectionClass}>\n            <legend className="px-1 text-sm font-black text-ink-inverse">\n              Como usar a duração dos eventos\n'
calendar_ui = '''          <fieldset className={sectionClass}>
            <legend className="px-1 text-sm font-black text-ink-inverse">
              Calendários desta playlist
            </legend>
            <p className="mt-1 text-xs leading-5 text-muted-inverse/65">
              Escolha uma ou várias agendas, ou faça este destino acompanhar automaticamente todos os calendários marcados para consulta no CONFIG-01.
            </p>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className={optionClass(calendarMode === "SELECTED")}>
                <input
                  type="radio"
                  name="calendarMode"
                  value="SELECTED"
                  checked={calendarMode === "SELECTED"}
                  onChange={() => setCalendarMode("SELECTED")}
                  className="mr-2 accent-accent"
                />
                <span className="font-black text-ink-inverse">Escolher calendários</span>
                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  Use exatamente as agendas marcadas abaixo. Pode ser uma, três, cinco ou qualquer combinação.
                </span>
              </label>

              <label className={optionClass(calendarMode === "ALL_QUERYABLE")}>
                <input
                  type="radio"
                  name="calendarMode"
                  value="ALL_QUERYABLE"
                  checked={calendarMode === "ALL_QUERYABLE"}
                  onChange={() => setCalendarMode("ALL_QUERYABLE")}
                  className="mr-2 accent-accent"
                />
                <span className="font-black text-ink-inverse">Todos os calendários consultáveis</span>
                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  É dinâmico: se uma nova agenda for marcada para consulta depois, ela passa a entrar automaticamente neste destino.
                </span>
              </label>
            </div>

            {calendarMode === "SELECTED" && (
              <div className="mt-4">
                {calendarOptions.length > 0 ? (
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {calendarOptions.map((calendar) => {
                      const checked = selectedCalendarIds.includes(calendar.id);
                      return (
                        <label
                          key={calendar.id}
                          className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 text-sm font-bold transition ${
                            checked ? optionActiveClass : optionIdleClass
                          }`}
                        >
                          <input
                            type="checkbox"
                            name="calendarSelectionIds"
                            value={calendar.id}
                            checked={checked}
                            onChange={(event) =>
                              setSelectedCalendarIds((current) =>
                                event.target.checked
                                  ? [...new Set([...current, calendar.id])]
                                  : current.filter((id) => id !== calendar.id),
                              )
                            }
                            className="h-4 w-4 shrink-0 accent-accent"
                          />
                          <span>{calendar.name}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="status-warning flex items-start gap-2 rounded-xl border p-3 text-xs font-semibold leading-5">
                    <UiIcon name="warning" size={16} className="mt-0.5 shrink-0" />
                    Nenhum calendário está marcado para consulta no CONFIG-01.
                  </p>
                )}
                <p className="mt-2 text-xs leading-5 text-muted-inverse/65">
                  {selectedCalendarIds.length === 0
                    ? "Selecione pelo menos um calendário."
                    : `${selectedCalendarIds.length} calendário${selectedCalendarIds.length === 1 ? "" : "s"} selecionado${selectedCalendarIds.length === 1 ? "" : "s"}.`}
                </p>
              </div>
            )}

            {calendarMode === "ALL_QUERYABLE" && (
              <p className="status-info mt-4 rounded-xl border p-3 text-xs font-semibold leading-5">
                Este destino usará todos os {calendarOptions.length} calendário{calendarOptions.length === 1 ? "" : "s"} atualmente consultável{calendarOptions.length === 1 ? "" : "is"}. A lista acompanha o CONFIG-01 automaticamente.
              </p>
            )}

            {initial.allowLegacyCalendar && (
              <label className={`mt-4 block ${optionClass(calendarMode === "LEGACY_GLOBAL")}`}>
                <input
                  type="radio"
                  name="calendarMode"
                  value="LEGACY_GLOBAL"
                  checked={calendarMode === "LEGACY_GLOBAL"}
                  onChange={() => setCalendarMode("LEGACY_GLOBAL")}
                  className="mr-2 accent-accent"
                />
                <span className="font-black text-ink-inverse">Compatibilidade temporária (legado)</span>
                <span className="mt-1 block text-xs leading-5 text-muted-inverse/65">
                  Mantém o conjunto global antigo somente até este destino ser migrado. Depois de salvar como seleção própria ou “Todos”, esta opção não volta.
                </span>
              </label>
            )}
          </fieldset>

          {initial.allowLegacyCalendar && calendarMode === "LEGACY_GLOBAL" && (
            <div
              className={`${sectionClass} ${
                durationCalendarNames.length > 0 ? "" : "status-warning"
              }`}
            >
              <p className="text-sm font-black text-ink-inverse">
                Calendários globais usados por este destino legado
              </p>
              {durationCalendarNames.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {durationCalendarNames.map((name) => (
                    <span key={name} className="product-badge">
                      {name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-2 flex items-start gap-2 text-xs font-semibold leading-5">
                  <UiIcon name="warning" size={16} className="mt-0.5 shrink-0" />
                  <span>
                    Nenhum calendário global está marcado para duração no CONFIG-01. Migre este destino para uma seleção própria.
                  </span>
                </p>
              )}
            </div>
          )}

'''
replace_between(form, calendar_start, calendar_end, calendar_ui)

# ---------------------------------------------------------------------------
# Destination persistence + presentation
# ---------------------------------------------------------------------------

page = "src/app/dashboard/configuracao/destinos/page.tsx"
replace_once(
    page,
    'import { canPreserveLegacyTargetCalendar } from "@/services/target-calendar-selection";\n',
    'import {\n  canPreserveLegacyTargetCalendar,\n  normalizeTargetCalendarSelectionIds,\n} from "@/services/target-calendar-selection";\n',
)
replace_once(
    page,
    '  const calendarSelectionId = String(\n    formData.get("calendarSelectionId") ?? "",\n  ).trim();\n',
    '  const calendarMode = String(\n    formData.get("calendarMode") ?? "SELECTED",\n  ).trim();\n  const calendarSelectionIds = normalizeTargetCalendarSelectionIds(\n    formData\n      .getAll("calendarSelectionIds")\n      .map((value) => String(value)),\n  );\n',
)
replace_once(
    page,
    '  const existingTarget = id\n    ? await prisma.targetPlaylist.findFirst({ where: { id, userId } })\n    : null;\n',
    '  const existingTarget = id\n    ? await prisma.targetPlaylist.findFirst({\n        where: { id, userId },\n        include: {\n          calendarSelections: {\n            select: { calendarSelectionId: true },\n          },\n        },\n      })\n    : null;\n',
)
replace_between(
    page,
    '  let normalizedCalendarSelectionId: string | null = null;\n',
    '  let spotifyPlaylistId = existingTarget?.spotifyPlaylistId ?? null;\n',
    '''  let normalizedCalendarMode: "LEGACY_GLOBAL" | "SELECTED" | "ALL_QUERYABLE" =
    "LEGACY_GLOBAL";
  let normalizedCalendarSelectionIds: string[] = [];

  if (durationMode === "CALENDAR") {
    if (
      calendarMode !== "LEGACY_GLOBAL" &&
      calendarMode !== "SELECTED" &&
      calendarMode !== "ALL_QUERYABLE"
    ) {
      fail("calendar-selection");
    }

    if (calendarMode === "LEGACY_GLOBAL") {
      if (!canPreserveLegacyTargetCalendar(existingTarget)) {
        fail("calendar-selection");
      }
      const durationCalendarCount = await prisma.calendarSelection.count({
        where: {
          userId,
          selected: true,
          usedForDuration: true,
        },
      });
      if (durationCalendarCount === 0) fail("calendar");
      normalizedCalendarMode = "LEGACY_GLOBAL";
    } else if (calendarMode === "ALL_QUERYABLE") {
      const queryableCalendarCount = await prisma.calendarSelection.count({
        where: { userId, selected: true },
      });
      if (queryableCalendarCount === 0) fail("calendar-selection");
      normalizedCalendarMode = "ALL_QUERYABLE";
    } else {
      if (calendarSelectionIds.length === 0) fail("calendar-selection");
      const availableCalendars = await prisma.calendarSelection.findMany({
        where: {
          id: { in: calendarSelectionIds },
          userId,
          selected: true,
        },
        select: { id: true },
      });
      const availableIds = normalizeTargetCalendarSelectionIds(
        availableCalendars.map((calendar) => calendar.id),
      );
      if (
        availableIds.length !== calendarSelectionIds.length ||
        availableIds.some((calendarId, index) => calendarId !== calendarSelectionIds[index])
      ) {
        fail("calendar-selection");
      }
      normalizedCalendarMode = "SELECTED";
      normalizedCalendarSelectionIds = availableIds;
    }
  }

''',
)
replace_once(
    page,
    '    calendarSelectionId:\n      durationMode === "CALENDAR" ? normalizedCalendarSelectionId : null,\n',
    '    calendarMode:\n      durationMode === "CALENDAR" ? normalizedCalendarMode : "LEGACY_GLOBAL",\n',
)
old_save = '''  if (existingTarget) {
    await prisma.targetPlaylist.update({
      where: { id: existingTarget.id },
      data,
    });
  } else {
    const maxPriority = await prisma.targetPlaylist.aggregate({
      where: { userId },
      _max: { priority: true },
    });

    await prisma.targetPlaylist.create({
      data: {
        userId,
        priority: (maxPriority._max.priority ?? -1) + 1,
        ...data,
      },
    });
  }
'''
new_save = '''  if (existingTarget) {
    await prisma.$transaction(async (tx) => {
      await tx.targetPlaylist.update({
        where: { id: existingTarget.id },
        data,
      });
      await tx.targetPlaylistCalendar.deleteMany({
        where: { targetPlaylistId: existingTarget.id },
      });
      if (
        durationMode === "CALENDAR" &&
        normalizedCalendarMode === "SELECTED" &&
        normalizedCalendarSelectionIds.length > 0
      ) {
        await tx.targetPlaylistCalendar.createMany({
          data: normalizedCalendarSelectionIds.map((calendarSelectionId) => ({
            targetPlaylistId: existingTarget.id,
            calendarSelectionId,
          })),
        });
      }
    });
  } else {
    const maxPriority = await prisma.targetPlaylist.aggregate({
      where: { userId },
      _max: { priority: true },
    });

    await prisma.$transaction(async (tx) => {
      const created = await tx.targetPlaylist.create({
        data: {
          userId,
          priority: (maxPriority._max.priority ?? -1) + 1,
          ...data,
        },
        select: { id: true },
      });
      if (
        durationMode === "CALENDAR" &&
        normalizedCalendarMode === "SELECTED" &&
        normalizedCalendarSelectionIds.length > 0
      ) {
        await tx.targetPlaylistCalendar.createMany({
          data: normalizedCalendarSelectionIds.map((calendarSelectionId) => ({
            targetPlaylistId: created.id,
            calendarSelectionId,
          })),
        });
      }
    });
  }
'''
replace_once(page, old_save, new_save)
replace_once(
    page,
    '''        calendarSelection: {
          select: {
            id: true,
            summary: true,
            googleCalendarId: true,
          },
        },
''',
    '''        calendarSelections: {
          orderBy: { createdAt: "asc" },
          select: {
            calendarSelectionId: true,
            calendarSelection: {
              select: {
                id: true,
                summary: true,
                googleCalendarId: true,
                selected: true,
              },
            },
          },
        },
''',
)
replace_once(
    page,
    '                Calendário escolhido em cada destino\n',
    '                Calendários escolhidos em cada destino\n',
)
replace_once(
    page,
    '                A marcação global “Duração” permanece somente para destinos legados ainda sem calendário próprio.\n',
    '                Cada destino pode usar uma ou várias agendas, ou acompanhar todas as agendas consultáveis. A marcação global “Duração” permanece somente para destinos legados.\n',
)
replace_once(
    page,
    '                  calendarSelectionId: null,\n                  allowLegacyCalendar: false,\n',
    '                  calendarMode: "SELECTED",\n                  calendarSelectionIds: [],\n                  allowLegacyCalendar: false,\n',
)
replace_once(
    page,
    '''                                target.calendarSelection?.summary?.trim() ||
                                (target.calendarSelectionId
                                  ? "seleção indisponível"
                                  : "globais (legado)")
''',
    '''                                target.calendarMode === "ALL_QUERYABLE"
                                  ? "todos os consultáveis"
                                  : target.calendarMode === "SELECTED"
                                    ? target.calendarSelections
                                        .map((entry) =>
                                          entry.calendarSelection.summary?.trim() ||
                                          "Calendário",
                                        )
                                        .join(", ") || "seleção indisponível"
                                    : "globais (legado)"
''',
)
replace_once(
    page,
    '''                            calendarSelectionId: target.calendarSelectionId,
                            allowLegacyCalendar:
                              target.durationMode === "CALENDAR" &&
                              !target.calendarSelectionId,
''',
    '''                            calendarMode:
                              target.durationMode === "CALENDAR"
                                ? target.calendarMode
                                : "SELECTED",
                            calendarSelectionIds: target.calendarSelections.map(
                              (entry) => entry.calendarSelectionId,
                            ),
                            allowLegacyCalendar:
                              target.durationMode === "CALENDAR" &&
                              target.calendarMode === "LEGACY_GLOBAL",
''',
)
replace_once(
    page,
    '        ? "Escolha um calendário disponível para este destino. Destinos novos não usam fallback global silencioso."\n',
    '        ? "Escolha pelo menos um calendário, ou use “Todos os calendários consultáveis”. Destinos novos não usam fallback global silencioso."\n',
)

# ---------------------------------------------------------------------------
# Generator: resolve SELECTED / ALL_QUERYABLE / LEGACY and fail closed
# ---------------------------------------------------------------------------

generator = "src/jobs/generate-playlists-incremental.ts"
replace_once(
    generator,
    'import { resolveTargetCalendarScope } from "@/services/target-calendar-selection";\n',
    'import {\n  resolveTargetCalendarScope,\n  targetCalendarScopesEqual,\n} from "@/services/target-calendar-selection";\n',
)
replace_once(
    generator,
    '''      include: {
        calendarSelection: {
          select: {
            googleCalendarId: true,
            selected: true,
            userId: true,
          },
        },
      },
''',
    '''      include: {
        calendarSelections: {
          select: {
            calendarSelectionId: true,
            calendarSelection: {
              select: {
                googleCalendarId: true,
                selected: true,
                userId: true,
              },
            },
          },
        },
      },
''',
)
replace_once(
    generator,
    '''    const legacyDurationCalendarIds = (
      await prisma.calendarSelection.findMany({
        where: { userId, selected: true, usedForDuration: true },
      })
    ).map((calendar) => calendar.googleCalendarId);
''',
    '''    const queryableCalendars = await prisma.calendarSelection.findMany({
      where: { userId, selected: true },
      select: { googleCalendarId: true, usedForDuration: true },
    });
    const queryableCalendarIds = queryableCalendars.map(
      (calendar) => calendar.googleCalendarId,
    );
    const legacyDurationCalendarIds = queryableCalendars
      .filter((calendar) => calendar.usedForDuration)
      .map((calendar) => calendar.googleCalendarId);
''',
)
replace_between(
    generator,
    '    for (const target of targets) {\n      let targetCalendarIds = legacyDurationCalendarIds;\n',
    '      const resolved = await resolveTargetDuration(\n',
    '''    for (const target of targets) {
      let targetCalendarIds = legacyDurationCalendarIds;
      if (target.durationMode === "CALENDAR") {
        const linkedCalendars = target.calendarSelections.map(
          (entry) => entry.calendarSelection,
        );

        if (target.calendarMode === "SELECTED") {
          if (linkedCalendars.length === 0) {
            throw new Error(
              `Target "${target.name}" has SELECTED calendar mode without calendars`,
            );
          }
          const unavailable = linkedCalendars.find(
            (calendar) => calendar.userId !== userId || !calendar.selected,
          );
          if (unavailable) {
            throw new Error(
              `Target "${target.name}" has an unavailable selected calendar`,
            );
          }
        }

        const calendarScope = resolveTargetCalendarScope({
          mode: target.calendarMode,
          selectedGoogleCalendarIds: linkedCalendars.map(
            (calendar) => calendar.googleCalendarId,
          ),
          queryableCalendarIds,
          legacyDurationCalendarIds,
        });

        if (
          calendarScope.mode !== "LEGACY_GLOBAL" &&
          calendarScope.calendarIds.length === 0
        ) {
          throw new Error(
            `Target "${target.name}" resolved an empty ${calendarScope.mode} calendar scope`,
          );
        }

        calendarScopeByTargetId.set(target.id, calendarScope);
        targetCalendarIds = calendarScope.calendarIds;
        log({
          level: "INFO",
          message: `Calendar scope for "${target.name}": ${calendarScope.mode} → ${calendarScope.calendarIds.length} calendar(s)`,
          data: calendarScope,
        });
      }

''',
)
old_live_select = '''        select: {
          id: true,
          name: true,
          maxTracksPerArtist: true,
          maxTracksPerAlbum: true,
          calendarSelectionId: true,
          calendarSelection: {
            select: {
              googleCalendarId: true,
              selected: true,
              userId: true,
            },
          },
        },
      });
'''
new_live_select = '''        select: {
          id: true,
          name: true,
          durationMode: true,
          calendarMode: true,
          maxTracksPerArtist: true,
          maxTracksPerAlbum: true,
          calendarSelections: {
            select: {
              calendarSelection: {
                select: {
                  googleCalendarId: true,
                  selected: true,
                  userId: true,
                },
              },
            },
          },
        },
      });
      const liveQueryableCalendars = await prisma.calendarSelection.findMany({
        where: { userId, selected: true },
        select: { googleCalendarId: true, usedForDuration: true },
      });
      const liveQueryableCalendarIds = liveQueryableCalendars.map(
        (calendar) => calendar.googleCalendarId,
      );
      const liveLegacyDurationCalendarIds = liveQueryableCalendars
        .filter((calendar) => calendar.usedForDuration)
        .map((calendar) => calendar.googleCalendarId);
'''
replace_once(generator, old_live_select, new_live_select)
replace_between(
    generator,
    '      const targetCalendarConfigurationChanges = targets.flatMap((target) => {\n',
    '      if (targetCalendarConfigurationChanges.length > 0) {\n',
    '''      const targetCalendarConfigurationChanges = targets.flatMap((target) => {
        const live = liveTargetById.get(target.id);
        if (!live) return [];

        if (live.durationMode !== target.durationMode) {
          return [{ targetPlaylistId: target.id, targetName: target.name }];
        }
        if (target.durationMode !== "CALENDAR") return [];

        const originalScope = calendarScopeByTargetId.get(target.id);
        if (!originalScope) {
          return [{ targetPlaylistId: target.id, targetName: target.name }];
        }

        const liveLinkedCalendars = live.calendarSelections.map(
          (entry) => entry.calendarSelection,
        );
        if (
          live.calendarMode === "SELECTED" &&
          (liveLinkedCalendars.length === 0 ||
            liveLinkedCalendars.some(
              (calendar) => calendar.userId !== userId || !calendar.selected,
            ))
        ) {
          return [{ targetPlaylistId: target.id, targetName: target.name }];
        }

        const liveScope = resolveTargetCalendarScope({
          mode: live.calendarMode,
          selectedGoogleCalendarIds: liveLinkedCalendars.map(
            (calendar) => calendar.googleCalendarId,
          ),
          queryableCalendarIds: liveQueryableCalendarIds,
          legacyDurationCalendarIds: liveLegacyDurationCalendarIds,
        });

        if (
          liveScope.mode !== "LEGACY_GLOBAL" &&
          liveScope.calendarIds.length === 0
        ) {
          return [{ targetPlaylistId: target.id, targetName: target.name }];
        }

        return targetCalendarScopesEqual(originalScope, liveScope)
          ? []
          : [{ targetPlaylistId: target.id, targetName: target.name }];
      });

''',
)
replace_once(
    generator,
    '          "A geração foi bloqueada antes de alterar o Spotify porque o calendário de um destino mudou durante o planejamento. Simule novamente antes de publicar.";\n',
    '          "A geração foi bloqueada antes de alterar o Spotify porque o conjunto de calendários de um destino mudou durante o planejamento. Simule novamente antes de publicar.";\n',
)

# ---------------------------------------------------------------------------
# CONFIG-04 readiness / fingerprint
# ---------------------------------------------------------------------------

readiness = "src/services/configuration-readiness.ts"
replace_once(
    readiness,
    '    fixedDurationSeconds: number | null;\n    calendarSelectionId: string | null;\n',
    '    fixedDurationSeconds: number | null;\n    calendarMode: "LEGACY_GLOBAL" | "SELECTED" | "ALL_QUERYABLE";\n    calendarSelectionIds: string[];\n',
)
replace_once(
    readiness,
    '          fixedDurationSeconds: true,\n          calendarSelectionId: true,\n',
    '          fixedDurationSeconds: true,\n          calendarMode: true,\n          calendarSelections: {\n            select: { calendarSelectionId: true },\n          },\n',
)
replace_once(
    readiness,
    '    fixedDurationSeconds: target.fixedDurationSeconds,\n    calendarSelectionId: target.calendarSelectionId,\n',
    '    fixedDurationSeconds: target.fixedDurationSeconds,\n    calendarMode: target.calendarMode,\n    calendarSelectionIds: normalizeCalendarIds(\n      target.calendarSelections.map((entry) => entry.calendarSelectionId),\n    ),\n',
)
replace_once(
    readiness,
    'function scopeIncludes(scope: string | null | undefined, expected: string): boolean {\n  return new Set((scope ?? "").split(/\\s+/).filter(Boolean)).has(expected);\n}\n',
    'function scopeIncludes(scope: string | null | undefined, expected: string): boolean {\n  return new Set((scope ?? "").split(/\\s+/).filter(Boolean)).has(expected);\n}\n\nfunction normalizeCalendarIds(values: readonly string[]): string[] {\n  return [...new Set(values.filter(Boolean))].sort();\n}\n',
)
replace_between(
    readiness,
    '  const legacyCalendarTargets = calendarTargets.filter(\n',
    '  const needsMusic = targets.some((target) =>\n',
    '''  const legacyCalendarTargets = calendarTargets.filter(
    (target) => target.calendarMode === "LEGACY_GLOBAL",
  );
  const allQueryableCalendarTargets = calendarTargets.filter(
    (target) => target.calendarMode === "ALL_QUERYABLE",
  );
  const durationCalendars = calendars.filter((calendar) => calendar.usedForDuration);
  const selectedCalendarSelectionIds = new Set(
    calendarsRaw.map((calendar) => calendar.id),
  );

  if (calendarTargets.length > 0 && !hasGoogle) {
    pushIssue({
      code: "GOOGLE_REQUIRED",
      message: "Conecte o Google para calcular a duração das playlists baseadas no calendário.",
      href: "/dashboard/configuracao/calendarios",
    });
  }

  if (legacyCalendarTargets.length > 0 && durationCalendars.length === 0) {
    pushIssue({
      code: "DURATION_CALENDAR_REQUIRED",
      message: "Há destinos legados sem seleção própria. Habilite ao menos um calendário global para duração ou migre esses destinos.",
      href: "/dashboard/configuracao/calendarios",
    });
  }

  if (allQueryableCalendarTargets.length > 0 && calendars.length === 0) {
    pushIssue({
      code: "QUERYABLE_CALENDAR_REQUIRED",
      message: "Há destinos configurados para usar todos os calendários consultáveis, mas nenhuma agenda está marcada para consulta.",
      href: "/dashboard/configuracao/calendarios",
    });
  }

  for (const target of calendarTargets) {
    if (target.calendarMode !== "SELECTED") continue;
    if (target.calendarSelectionIds.length === 0) {
      pushIssue({
        code: `TARGET_CALENDAR_REQUIRED:${target.id}`,
        message: `Destino "${target.name}": selecione pelo menos um calendário ou use todos os calendários consultáveis.`,
        href: "/dashboard/configuracao/destinos",
      });
      continue;
    }
    const unavailable = target.calendarSelectionIds.filter(
      (calendarSelectionId) => !selectedCalendarSelectionIds.has(calendarSelectionId),
    );
    if (unavailable.length > 0) {
      pushIssue({
        code: `TARGET_CALENDAR_UNAVAILABLE:${target.id}`,
        message: `Destino "${target.name}": um ou mais calendários escolhidos não estão mais habilitados para consulta. Revise a seleção.`,
        href: "/dashboard/configuracao/destinos",
      });
    }
  }

''',
)
replace_once(
    readiness,
    '    durationCalendars: durationCalendars.map((calendar) => calendar.id).sort(),\n',
    '    legacyDurationCalendars:\n      legacyCalendarTargets.length > 0\n        ? durationCalendars.map((calendar) => calendar.id).sort()\n        : [],\n    allQueryableCalendars:\n      allQueryableCalendarTargets.length > 0\n        ? calendars.map((calendar) => calendar.id).sort()\n        : [],\n',
)
replace_once(
    readiness,
    '      fixedDurationSeconds: target.fixedDurationSeconds,\n      calendarSelectionId: target.calendarSelectionId,\n',
    '      fixedDurationSeconds: target.fixedDurationSeconds,\n      calendarMode:\n        target.durationMode === "CALENDAR" ? target.calendarMode : null,\n      calendarSelectionIds:\n        target.durationMode === "CALENDAR" && target.calendarMode === "SELECTED"\n          ? target.calendarSelectionIds\n          : null,\n',
)

# ---------------------------------------------------------------------------
# CONFIG-01 wording
# ---------------------------------------------------------------------------

calendar_page = "src/app/dashboard/configuracao/calendarios/page.tsx"
replace_once(
    calendar_page,
    '                        Duração\n',
    '                        Duração legado\n',
)
replace_once(
    calendar_page,
    '                “Consultar” define as agendas disponíveis para cada destino. “Duração legado” só alimenta playlists antigas que ainda não foram migradas para um calendário próprio.\n',
    '                “Consultar” define as agendas disponíveis para seleção por destino e para o modo “Todos os calendários consultáveis”. “Duração legado” só alimenta playlists antigas ainda não migradas.\n',
)

print("CALENDAR #127 Gate 3 transformations applied")
