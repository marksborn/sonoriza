from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}\n--- needle ---\n{old}")
    file.write_text(text.replace(old, new, 1))


def append_once(path: str, marker: str, addition: str) -> None:
    file = Path(path)
    text = file.read_text()
    if addition.strip() in text:
        raise SystemExit(f"{path}: addition already present")
    if marker not in text:
        raise SystemExit(f"{path}: marker not found")
    file.write_text(text.replace(marker, marker + addition, 1))


# CALENDAR #127 contract: only already-calendar unbound targets may retain legacy.
replace_once(
    "src/services/target-calendar-selection.ts",
    '''\n/**
 * New CALENDAR targets must choose a calendar explicitly. Existing targets are
''',
    '''\n/**
 * Only a target that was already calendar-driven and unbound before Gate 2 may
 * remain on the legacy global calendar set. This prevents creating new legacy
 * state when a FIXED target is switched to CALENDAR after per-target selection
 * became available.
 */
export function canPreserveLegacyTargetCalendar(input: {
  durationMode: "FIXED" | "CALENDAR";
  calendarSelectionId: string | null | undefined;
} | null): boolean {
  return Boolean(
    input?.durationMode === "CALENDAR" && !input.calendarSelectionId?.trim(),
  );
}

/**
 * New CALENDAR targets must choose a calendar explicitly. Existing targets are
''',
)

replace_once(
    "src/jobs/target-calendar-selection.test.ts",
    '''import {
  requiresExplicitTargetCalendar,
''',
    '''import {
  canPreserveLegacyTargetCalendar,
  requiresExplicitTargetCalendar,
''',
)
append_once(
    "src/jobs/target-calendar-selection.test.ts",
    '''test("existing targets may remain legacy and fixed targets need no calendar", () => {
  assert.equal(
    requiresExplicitTargetCalendar({
      durationMode: "CALENDAR",
      isNewTarget: false,
      calendarSelectionId: null,
    }),
    false,
  );
  assert.equal(
    requiresExplicitTargetCalendar({
      durationMode: "FIXED",
      isNewTarget: true,
      calendarSelectionId: null,
    }),
    false,
  );
});
''',
    '''\ntest("only an already-calendar unbound target is eligible for legacy compatibility", () => {
  assert.equal(
    canPreserveLegacyTargetCalendar({
      durationMode: "CALENDAR",
      calendarSelectionId: null,
    }),
    true,
  );
  assert.equal(
    canPreserveLegacyTargetCalendar({
      durationMode: "FIXED",
      calendarSelectionId: null,
    }),
    false,
  );
  assert.equal(
    canPreserveLegacyTargetCalendar({
      durationMode: "CALENDAR",
      calendarSelectionId: "selection-1",
    }),
    false,
  );
  assert.equal(canPreserveLegacyTargetCalendar(null), false);
});
''',
)

# Target form: explicit calendar selector, legacy option only for eligible targets.
replace_once(
    "src/components/TargetPlaylistForm.tsx",
    '''export type SpotifyDestinationOption = {
  id: string;
  name: string;
};

export type TargetPlaylistFormInitial = {
''',
    '''export type SpotifyDestinationOption = {
  id: string;
  name: string;
};

export type CalendarOption = {
  id: string;
  googleCalendarId: string;
  name: string;
};

export type TargetPlaylistFormInitial = {
''',
)
replace_once(
    "src/components/TargetPlaylistForm.tsx",
    '''  durationMode: DurationMode;
  fixedDurationMinutes: number;
  emptyCalendarBehavior: EmptyCalendarBehavior;
''',
    '''  durationMode: DurationMode;
  fixedDurationMinutes: number;
  calendarSelectionId: string | null;
  allowLegacyCalendar: boolean;
  emptyCalendarBehavior: EmptyCalendarBehavior;
''',
)
replace_once(
    "src/components/TargetPlaylistForm.tsx",
    '''  spotifyOptions: SpotifyDestinationOption[];
  durationCalendarNames: string[];
  saveAction: (formData: FormData) => void | Promise<void>;
''',
    '''  spotifyOptions: SpotifyDestinationOption[];
  durationCalendarNames: string[];
  calendarOptions: CalendarOption[];
  saveAction: (formData: FormData) => void | Promise<void>;
''',
)
replace_once(
    "src/components/TargetPlaylistForm.tsx",
    '''  spotifyOptions,
  durationCalendarNames,
  saveAction,
''',
    '''  spotifyOptions,
  durationCalendarNames,
  calendarOptions,
  saveAction,
''',
)
replace_once(
    "src/components/TargetPlaylistForm.tsx",
    '''              Soma a duração dos eventos elegíveis dos calendários habilitados no CONFIG-01.
''',
    '''              Usa somente o calendário escolhido para esta playlist, exceto destinos legados ainda não migrados.
''',
)
replace_once(
    "src/components/TargetPlaylistForm.tsx",
    '''          <div
            className={`${sectionClass} ${
              durationCalendarNames.length > 0 ? "" : "status-warning"
            }`}
          >
            <p className="text-sm font-black text-ink-inverse">Calendários usados na duração</p>
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
                  Nenhum calendário está habilitado para duração. Configure isso no CONFIG-01 antes de salvar este modo.
                </span>
              </p>
            )}
          </div>
''',
    '''          <label className={`block max-w-xl ${fieldLabelClass}`}>
            Calendário desta playlist
            <select
              className={inputClass}
              name="calendarSelectionId"
              required={!initial.allowLegacyCalendar}
              defaultValue={initial.calendarSelectionId ?? ""}
            >
              <option value="">
                {initial.allowLegacyCalendar
                  ? "Compatibilidade: manter calendários globais atuais"
                  : "Escolha um calendário"}
              </option>
              {calendarOptions.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>
                  {calendar.name}
                </option>
              ))}
            </select>
            <span className={helperClass}>
              Cada destino baseado no calendário passa a consultar somente esta agenda. O ID técnico do Google continua oculto da configuração.
            </span>
          </label>

          {initial.allowLegacyCalendar && !initial.calendarSelectionId && (
            <div
              className={`${sectionClass} ${
                durationCalendarNames.length > 0 ? "" : "status-warning"
              }`}
            >
              <p className="text-sm font-black text-ink-inverse">
                Compatibilidade temporária com calendários globais
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
                    Este destino ainda está em modo legado, mas nenhum calendário global está marcado para duração no CONFIG-01. Escolha um calendário próprio para migrá-lo.
                  </span>
                </p>
              )}
              <p className="mt-2 text-xs leading-5 text-muted-inverse/65">
                Ao escolher um calendário acima e salvar, este destino sai definitivamente do modo legado.
              </p>
            </div>
          )}
''',
)

# Destinations server/UI.
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''import {
  TargetPlaylistForm,
  type SpotifyDestinationOption,
''',
    '''import {
  TargetPlaylistForm,
  type CalendarOption,
  type SpotifyDestinationOption,
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''} from "@/services/playlist-planner";
import {
  SpotifyClient,
''',
    '''} from "@/services/playlist-planner";
import { canPreserveLegacyTargetCalendar } from "@/services/target-calendar-selection";
import {
  SpotifyClient,
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''  const calendarDurationStrategy = String(
    formData.get("calendarDurationStrategy") ?? "SUMMED",
  ).trim();
  const podcastEpisodeMaxDurationMode = String(
''',
    '''  const calendarDurationStrategy = String(
    formData.get("calendarDurationStrategy") ?? "SUMMED",
  ).trim();
  const calendarSelectionId = String(
    formData.get("calendarSelectionId") ?? "",
  ).trim();
  const podcastEpisodeMaxDurationMode = String(
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''  if (durationMode === "CALENDAR") {
    const durationCalendarCount = await prisma.calendarSelection.count({
      where: {
        userId,
        selected: true,
        usedForDuration: true,
      },
    });
    if (durationCalendarCount === 0) fail("calendar");
  }

  const existingTarget = id
    ? await prisma.targetPlaylist.findFirst({ where: { id, userId } })
    : null;

  if (id && !existingTarget) fail("invalid");
''',
    '''  const existingTarget = id
    ? await prisma.targetPlaylist.findFirst({ where: { id, userId } })
    : null;

  if (id && !existingTarget) fail("invalid");

  let normalizedCalendarSelectionId: string | null = null;
  if (durationMode === "CALENDAR") {
    const allowLegacyCalendar = canPreserveLegacyTargetCalendar(existingTarget);

    if (!calendarSelectionId) {
      if (!allowLegacyCalendar) fail("calendar-selection");

      const durationCalendarCount = await prisma.calendarSelection.count({
        where: {
          userId,
          selected: true,
          usedForDuration: true,
        },
      });
      if (durationCalendarCount === 0) fail("calendar");
    } else {
      const calendarSelection = await prisma.calendarSelection.findFirst({
        where: {
          id: calendarSelectionId,
          userId,
          selected: true,
        },
        select: { id: true },
      });
      if (!calendarSelection) fail("calendar-selection");
      normalizedCalendarSelectionId = calendarSelection.id;
    }
  }
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''    fixedDurationSeconds:
      durationMode === "FIXED" ? fixedDurationMinutes! * 60 : null,
    emptyCalendarBehavior:
''',
    '''    fixedDurationSeconds:
      durationMode === "FIXED" ? fixedDurationMinutes! * 60 : null,
    calendarSelectionId:
      durationMode === "CALENDAR" ? normalizedCalendarSelectionId : null,
    emptyCalendarBehavior:
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''        targetScheduleRuns: {
          orderBy: { startedAt: "desc" },
          take: 1,
        },
      },
''',
    '''        targetScheduleRuns: {
          orderBy: { startedAt: "desc" },
          take: 1,
        },
        calendarSelection: {
          select: {
            id: true,
            summary: true,
            googleCalendarId: true,
          },
        },
      },
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''    prisma.calendarSelection.findMany({
      where: { userId, selected: true, usedForDuration: true },
      orderBy: { summary: "asc" },
      select: { googleCalendarId: true, summary: true },
    }),
''',
    '''    prisma.calendarSelection.findMany({
      where: { userId, selected: true },
      orderBy: [{ usedForDuration: "desc" }, { summary: "asc" }],
      select: {
        id: true,
        googleCalendarId: true,
        summary: true,
        usedForDuration: true,
      },
    }),
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''  const durationCalendarNames = durationCalendars.map(
    (calendar) => calendar.summary?.trim() || "Calendário",
  );
''',
    '''  const durationCalendarNames = durationCalendars
    .filter((calendar) => calendar.usedForDuration)
    .map((calendar) => calendar.summary?.trim() || "Calendário");
  const calendarOptions: CalendarOption[] = durationCalendars.map((calendar) => ({
    id: calendar.id,
    googleCalendarId: calendar.googleCalendarId,
    name: calendar.summary?.trim() || "Calendário",
  }));
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''    params.error === "calendar"
      ? "Para usar duração baseada no calendário, habilite ao menos um calendário para duração no CONFIG-01."
      : params.error === "marker"
''',
    '''    params.error === "calendar"
      ? "Este destino ainda usa compatibilidade global. Habilite ao menos um calendário para duração no CONFIG-01 ou escolha um calendário próprio."
      : params.error === "calendar-selection"
        ? "Escolha um calendário disponível para este destino. Destinos novos não usam fallback global silencioso."
        : params.error === "marker"
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''              <h2 className="mt-1 text-xl font-black text-ink-inverse">
                Calendários que podem entrar no cálculo
              </h2>
              {durationCalendarNames.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {durationCalendarNames.map((name) => (
                    <span key={name} className="product-badge">
                      <UiIcon name="calendar" size={15} />
                      {name}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="status-warning mt-3 flex max-w-3xl items-start gap-3 rounded-2xl border px-4 py-3 text-sm leading-6">
                  <UiIcon name="warning" size={18} className="mt-0.5 shrink-0" />
                  <span>
                    Nenhum calendário está habilitado para duração. Destinos baseados no calendário só poderão ser salvos depois dessa definição.
                  </span>
                </div>
              )}
''',
    '''              <h2 className="mt-1 text-xl font-black text-ink-inverse">
                Calendário escolhido em cada destino
              </h2>
              {calendarOptions.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {calendarOptions.map((calendar) => (
                    <span key={calendar.id} className="product-badge">
                      <UiIcon name="calendar" size={15} />
                      {calendar.name}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="status-warning mt-3 flex max-w-3xl items-start gap-3 rounded-2xl border px-4 py-3 text-sm leading-6">
                  <UiIcon name="warning" size={18} className="mt-0.5 shrink-0" />
                  <span>
                    Nenhum calendário está habilitado para consulta. Ative pelo menos um calendário no CONFIG-01 antes de criar um destino baseado em calendário.
                  </span>
                </div>
              )}
              <p className="mt-3 max-w-3xl text-xs leading-5 text-muted-inverse/65">
                A marcação global “Duração” permanece somente para destinos legados ainda sem calendário próprio.
              </p>
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''                spotifyOptions={spotifyOptions()}
                durationCalendarNames={durationCalendarNames}
                initial={{
''',
    '''                spotifyOptions={spotifyOptions()}
                durationCalendarNames={durationCalendarNames}
                calendarOptions={calendarOptions}
                initial={{
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''                  durationMode: "FIXED",
                  fixedDurationMinutes: 45,
                  emptyCalendarBehavior: "KEEP",
''',
    '''                  durationMode: "FIXED",
                  fixedDurationMinutes: 45,
                  calendarSelectionId: null,
                  allowLegacyCalendar: false,
                  emptyCalendarBehavior: "KEEP",
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''                          {target.durationMode === "CALENDAR"
                            ? ` · eventos: ${
''',
    '''                          {target.durationMode === "CALENDAR"
                            ? ` · calendário: ${
                                target.calendarSelection?.summary?.trim() ||
                                (target.calendarSelectionId
                                  ? "seleção indisponível"
                                  : "globais (legado)")
                              } · eventos: ${
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''                          spotifyOptions={spotifyOptions(target.spotifyPlaylistId)}
                          durationCalendarNames={durationCalendarNames}
                          initial={{
''',
    '''                          spotifyOptions={spotifyOptions(target.spotifyPlaylistId)}
                          durationCalendarNames={durationCalendarNames}
                          calendarOptions={calendarOptions}
                          initial={{
''',
)
replace_once(
    "src/app/dashboard/configuracao/destinos/page.tsx",
    '''                            fixedDurationMinutes: Math.max(
                              1,
                              Math.round((target.fixedDurationSeconds ?? 45 * 60) / 60),
                            ),
                            emptyCalendarBehavior: target.emptyCalendarBehavior,
''',
    '''                            fixedDurationMinutes: Math.max(
                              1,
                              Math.round((target.fixedDurationSeconds ?? 45 * 60) / 60),
                            ),
                            calendarSelectionId: target.calendarSelectionId,
                            allowLegacyCalendar:
                              target.durationMode === "CALENDAR" &&
                              !target.calendarSelectionId,
                            emptyCalendarBehavior: target.emptyCalendarBehavior,
''',
)

# Configuration readiness/fingerprint.
replace_once(
    "src/services/configuration-readiness.ts",
    '''    durationMode: "FIXED" | "CALENDAR";
    fixedDurationSeconds: number | null;
    emptyCalendarBehavior: "CLEAR" | "KEEP" | "SKIP";
''',
    '''    durationMode: "FIXED" | "CALENDAR";
    fixedDurationSeconds: number | null;
    calendarSelectionId: string | null;
    emptyCalendarBehavior: "CLEAR" | "KEEP" | "SKIP";
''',
)
replace_once(
    "src/services/configuration-readiness.ts",
    '''        select: {
          googleCalendarId: true,
          summary: true,
''',
    '''        select: {
          id: true,
          googleCalendarId: true,
          summary: true,
''',
)
replace_once(
    "src/services/configuration-readiness.ts",
    '''          durationMode: true,
          fixedDurationSeconds: true,
          emptyCalendarBehavior: true,
''',
    '''          durationMode: true,
          fixedDurationSeconds: true,
          calendarSelectionId: true,
          emptyCalendarBehavior: true,
''',
)
replace_once(
    "src/services/configuration-readiness.ts",
    '''    durationMode: target.durationMode,
    fixedDurationSeconds: target.fixedDurationSeconds,
    emptyCalendarBehavior: target.emptyCalendarBehavior,
''',
    '''    durationMode: target.durationMode,
    fixedDurationSeconds: target.fixedDurationSeconds,
    calendarSelectionId: target.calendarSelectionId,
    emptyCalendarBehavior: target.emptyCalendarBehavior,
''',
)
replace_once(
    "src/services/configuration-readiness.ts",
    '''  const calendarTargets = targets.filter(
    (target) => target.durationMode === "CALENDAR",
  );
  const durationCalendars = calendars.filter((calendar) => calendar.usedForDuration);

''',
    '''  const calendarTargets = targets.filter(
    (target) => target.durationMode === "CALENDAR",
  );
  const legacyCalendarTargets = calendarTargets.filter(
    (target) => !target.calendarSelectionId,
  );
  const durationCalendars = calendars.filter((calendar) => calendar.usedForDuration);
  const selectedCalendarSelectionIds = new Set(
    calendarsRaw.map((calendar) => calendar.id),
  );

''',
)
replace_once(
    "src/services/configuration-readiness.ts",
    '''  if (calendarTargets.length > 0 && durationCalendars.length === 0) {
    pushIssue({
      code: "DURATION_CALENDAR_REQUIRED",
      message: "Habilite pelo menos um calendário para entrar no cálculo de duração.",
      href: "/dashboard/configuracao/calendarios",
    });
  }

''',
    '''  if (legacyCalendarTargets.length > 0 && durationCalendars.length === 0) {
    pushIssue({
      code: "DURATION_CALENDAR_REQUIRED",
      message: "Há destinos legados sem calendário próprio. Habilite ao menos um calendário global para duração ou migre esses destinos para uma agenda explícita.",
      href: "/dashboard/configuracao/calendarios",
    });
  }

  for (const target of calendarTargets) {
    if (
      target.calendarSelectionId &&
      !selectedCalendarSelectionIds.has(target.calendarSelectionId)
    ) {
      pushIssue({
        code: `TARGET_CALENDAR_UNAVAILABLE:${target.id}`,
        message: `Destino "${target.name}": o calendário escolhido não está mais habilitado para consulta. Escolha outro calendário ou reative-o no CONFIG-01.`,
        href: "/dashboard/configuracao/destinos",
      });
    }
  }

''',
)
# The target mapping snippet appears twice (assessment + fingerprint); update the remaining fingerprint occurrence.
replace_once(
    "src/services/configuration-readiness.ts",
    '''      durationMode: target.durationMode,
      fixedDurationSeconds: target.fixedDurationSeconds,
      emptyCalendarBehavior: target.emptyCalendarBehavior,
''',
    '''      durationMode: target.durationMode,
      fixedDurationSeconds: target.fixedDurationSeconds,
      calendarSelectionId: target.calendarSelectionId,
      emptyCalendarBehavior: target.emptyCalendarBehavior,
''',
)

# Runtime: explicit target calendar scope + audit + pre-write revalidation.
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''import { calendarDurationPlanningBlocks } from "@/services/calendar-duration-strategy";
import {
''',
    '''import { calendarDurationPlanningBlocks } from "@/services/calendar-duration-strategy";
import { resolveTargetCalendarScope } from "@/services/target-calendar-selection";
import {
''',
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''      },
      orderBy: { priority: "asc" },
    });
''',
    '''      },
      orderBy: { priority: "asc" },
      include: {
        calendarSelection: {
          select: {
            googleCalendarId: true,
            selected: true,
            userId: true,
          },
        },
      },
    });
''',
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''    const durationCalendarIds = (
      await prisma.calendarSelection.findMany({
        where: { userId, selected: true, usedForDuration: true },
      })
    ).map((calendar) => calendar.googleCalendarId);

    const runTargets: RunTarget[] = [];
    const skipped: TargetPlaylist[] = [];
    const resolvedDurationByTargetId = new Map<string, ResolvedTargetDuration>();

    for (const target of targets) {
      const resolved = await resolveTargetDuration(
        userId,
        target,
        durationCalendarIds,
        date,
        log,
      );
''',
    '''    const legacyDurationCalendarIds = (
      await prisma.calendarSelection.findMany({
        where: { userId, selected: true, usedForDuration: true },
      })
    ).map((calendar) => calendar.googleCalendarId);

    const runTargets: RunTarget[] = [];
    const skipped: TargetPlaylist[] = [];
    const resolvedDurationByTargetId = new Map<string, ResolvedTargetDuration>();
    const calendarScopeByTargetId = new Map<
      string,
      ReturnType<typeof resolveTargetCalendarScope>
    >();

    for (const target of targets) {
      let targetCalendarIds = legacyDurationCalendarIds;
      if (target.durationMode === "CALENDAR") {
        if (
          target.calendarSelectionId &&
          (!target.calendarSelection ||
            target.calendarSelection.userId !== userId ||
            !target.calendarSelection.selected)
        ) {
          throw new Error(
            `Target "${target.name}" has an unavailable explicit calendar selection`,
          );
        }

        const calendarScope = resolveTargetCalendarScope(
          target.calendarSelection?.googleCalendarId,
          legacyDurationCalendarIds,
        );
        calendarScopeByTargetId.set(target.id, calendarScope);
        targetCalendarIds = calendarScope.calendarIds;
        log({
          level: "INFO",
          message: `Calendar scope for "${target.name}": ${calendarScope.mode} → ${calendarScope.calendarIds.length} calendar(s)`,
          data: calendarScope,
        });
      }

      const resolved = await resolveTargetDuration(
        userId,
        target,
        targetCalendarIds,
        date,
        log,
      );
''',
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''    }

    const sources = (await prisma.sourcePlaylist.findMany({
''',
    '''    }

    summary.calendarScopes = Object.fromEntries(
      [...calendarScopeByTargetId.entries()].map(([targetId, scope]) => [
        targetId,
        scope,
      ]),
    );

    const sources = (await prisma.sourcePlaylist.findMany({
''',
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''          name: true,
          maxTracksPerArtist: true,
          maxTracksPerAlbum: true,
        },
      });
      const originalTargetById = new Map(targets.map((target) => [target.id, target]));
      const liveTargetById = new Map(liveTargets.map((target) => [target.id, target]));
      const musicDiversityConfigurationChanges: Array<{
''',
    '''          name: true,
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
      const originalTargetById = new Map(targets.map((target) => [target.id, target]));
      const liveTargetById = new Map(liveTargets.map((target) => [target.id, target]));

      const targetCalendarConfigurationChanges = targets.flatMap((target) => {
        const live = liveTargetById.get(target.id);
        if (!live) return [];
        const changed =
          live.calendarSelectionId !== target.calendarSelectionId ||
          live.calendarSelection?.googleCalendarId !==
            target.calendarSelection?.googleCalendarId ||
          live.calendarSelection?.selected !== target.calendarSelection?.selected ||
          live.calendarSelection?.userId !== target.calendarSelection?.userId;
        return changed
          ? [{ targetPlaylistId: target.id, targetName: target.name }]
          : [];
      });

      if (targetCalendarConfigurationChanges.length > 0) {
        summary.targetCalendarConfigurationChanges = targetCalendarConfigurationChanges;
        const error =
          "A geração foi bloqueada antes de alterar o Spotify porque o calendário de um destino mudou durante o planejamento. Simule novamente antes de publicar.";
        log({ level: "ERROR", message: error, data: targetCalendarConfigurationChanges });
        await finalizeRun(run.id, "FAILED", logs, summary, error);
        return { runId: run.id, status: "FAILED" };
      }

      const musicDiversityConfigurationChanges: Array<{
''',
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''      const musicOrderEvidence = musicOrderEvidenceByTargetId.get(target.id) ?? null;

      const targetSummary: Record<string, unknown> = {
''',
    '''      const musicOrderEvidence = musicOrderEvidenceByTargetId.get(target.id) ?? null;
      const calendarScope = calendarScopeByTargetId.get(target.id) ?? null;

      const targetSummary: Record<string, unknown> = {
''',
)
replace_once(
    "src/jobs/generate-playlists-incremental.ts",
    '''        targetDurationMs: resolvedDuration?.durationMs ?? 0,
        calendarDurationStrategy: target.calendarDurationStrategy,
        sequencePattern: parseSequencePattern(target.sequencePattern),
''',
    '''        targetDurationMs: resolvedDuration?.durationMs ?? 0,
        calendarDurationStrategy: target.calendarDurationStrategy,
        calendarScopeMode: calendarScope?.mode ?? null,
        calendarIds: calendarScope?.calendarIds ?? [],
        sequencePattern: parseSequencePattern(target.sequencePattern),
''',
)

# CONFIG-01 wording: global duration becomes legacy-only; selected calendars feed per-target UI.
replace_once(
    "src/app/dashboard/configuracao/calendarios/page.tsx",
    '''              Escolha quais calendários o Sonoriza consulta e quais deles podem contribuir com eventos para calcular a duração das playlists.
''',
    '''              Escolha quais calendários o Sonoriza pode consultar. A coluna de duração global permanece apenas para destinos legados ainda sem calendário próprio.
''',
)
replace_once(
    "src/app/dashboard/configuracao/calendarios/page.tsx",
    '''                <span className="text-center">Duração</span>
''',
    '''                <span className="text-center">Duração legado</span>
''',
)
replace_once(
    "src/app/dashboard/configuracao/calendarios/page.tsx",
    '''                Um calendário habilitado para duração só será considerado quando também estiver marcado para consulta. Essa regra é garantida novamente no servidor ao salvar.
''',
    '''                “Consultar” define as agendas disponíveis para cada destino. “Duração legado” só alimenta playlists antigas que ainda não foram migradas para um calendário próprio.
''',
)

print("CALENDAR #127 Gate 2 source transformations applied successfully")
