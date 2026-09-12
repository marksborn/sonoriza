import {
  MusicRepeatWindowUnit,
  SourceKind,
  SpotifySourceType,
} from "@prisma/client";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth, signIn } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getActiveSpotifyBackoff,
  retryAfterSecondsRemaining,
} from "@/services/spotify/backoff";
import {
  SpotifyClient,
  type SpotifyPlaylistPage,
} from "@/services/spotify";
import {
  saveSpotifySourceForUser,
  SpotifySourceConfigurationError,
} from "@/services/source-configuration";
import {
  createBasicOnboardingTarget,
  ONBOARDING_CREATE_NEW_DESTINATION,
  OnboardingTargetError,
  type OnboardingCompositionPreset,
} from "@/services/onboarding/basic-target";
import {
  onboardingDiscoveryPresetData,
  type OnboardingDiscoveryPreset,
} from "@/services/onboarding/basic-behavior";
import {
  configureOnboardingTargetCalendar,
  listOnboardingCalendarOptions,
  OnboardingCalendarError,
} from "@/services/onboarding/basic-calendar";
import {
  saveMusicPlaybackPolicyForUser,
} from "@/services/music-playback-policy";
import {
  SPOTIFY_HISTORY_INSTRUCTIONS,
} from "@/services/onboarding/history-instructions";
import {
  ONBOARDING_STEPS,
  ONBOARDING_VERSION,
  previousOnboardingStep,
  type OnboardingStepValue,
} from "@/services/onboarding/state";
import {
  appendPersistedStep,
  onboardingProgressPosition,
  readPersistedStepList,
} from "@/services/onboarding/shell";

const ONBOARDING_PATH = "/onboarding";
const SOURCE_PAGE_SIZE = 12;
const DESTINATION_PAGE_SIZE = 12;

const STEP_LABELS: Record<OnboardingStepValue, string> = {
  WELCOME: "Bem-vindo",
  SPOTIFY: "Spotify",
  SPOTIFY_HISTORY: "Histórico do Spotify",
  SOURCES: "Fontes",
  DESTINATION: "Primeiro destino",
  MUSIC_BEHAVIOR: "Preferências",
  CALENDAR: "Calendário",
  REVIEW: "Revisão",
  SIMULATION: "Simulação",
  ACTIVATION: "Ativação",
};

async function requireUserId() {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  return session.user.id;
}

async function ensureProgress(userId: string) {
  return prisma.onboardingProgress.upsert({
    where: { userId },
    create: {
      userId,
      version: ONBOARDING_VERSION,
      status: "NOT_STARTED",
      currentStep: "WELCOME",
    },
    update: {},
  });
}

async function moveToStep(input: {
  userId: string;
  from: OnboardingStepValue;
  to: OnboardingStepValue;
  markCompleted?: boolean;
  markSkipped?: boolean;
}) {
  const progress = await ensureProgress(input.userId);

  await prisma.onboardingProgress.update({
    where: { userId: input.userId },
    data: {
      version: ONBOARDING_VERSION,
      status: "IN_PROGRESS",
      currentStep: input.to,
      startedAt: progress.startedAt ?? new Date(),
      completedSteps: input.markCompleted
        ? appendPersistedStep(
            progress.completedSteps,
            input.from,
          )
        : readPersistedStepList(
            progress.completedSteps,
          ),
      skippedSteps: input.markSkipped
        ? appendPersistedStep(
            progress.skippedSteps,
            input.from,
          )
        : readPersistedStepList(
            progress.skippedSteps,
          ),
    },
  });
}

async function continueWelcome() {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.status === "COMPLETED") {
    redirect("/dashboard");
  }

  if (progress.status === "SKIPPED") {
    await prisma.onboardingProgress.update({
      where: { userId },
      data: {
        version: ONBOARDING_VERSION,
        status: "IN_PROGRESS",
        currentStep: "WELCOME",
        startedAt: new Date(),
        skippedAt: null,
      },
    });

    redirect(ONBOARDING_PATH);
  }

  if (progress.currentStep !== "WELCOME") {
    redirect(ONBOARDING_PATH);
  }

  await moveToStep({
    userId,
    from: "WELCOME",
    to: "SPOTIFY",
    markCompleted: true,
  });

  revalidatePath(ONBOARDING_PATH);
  redirect(ONBOARDING_PATH);
}

async function connectSpotify() {
  "use server";

  await requireUserId();

  await signIn("spotify", {
    redirectTo: ONBOARDING_PATH,
  });
}

async function confirmSpotify() {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.currentStep !== "SPOTIFY") {
    redirect(ONBOARDING_PATH);
  }

  const spotifyAccount = await prisma.account.findFirst({
    where: {
      userId,
      provider: "spotify",
    },
    select: { id: true },
  });

  if (!spotifyAccount) {
    redirect("/onboarding?error=spotify-not-connected");
  }

  await moveToStep({
    userId,
    from: "SPOTIFY",
    to: "SPOTIFY_HISTORY",
    markCompleted: true,
  });

  revalidatePath(ONBOARDING_PATH);
  redirect(ONBOARDING_PATH);
}

async function markHistoryRequested() {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.currentStep !== "SPOTIFY_HISTORY") {
    redirect(ONBOARDING_PATH);
  }

  await prisma.onboardingProgress.update({
    where: { userId },
    data: {
      historyStatus: "REQUESTED",
      historyRequestedAt: new Date(),
    },
  });

  await moveToStep({
    userId,
    from: "SPOTIFY_HISTORY",
    to: "SOURCES",
    markCompleted: true,
  });

  revalidatePath(ONBOARDING_PATH);
  redirect(ONBOARDING_PATH);
}

async function historyLater() {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.currentStep !== "SPOTIFY_HISTORY") {
    redirect(ONBOARDING_PATH);
  }

  await moveToStep({
    userId,
    from: "SPOTIFY_HISTORY",
    to: "SOURCES",
    markSkipped: true,
  });

  revalidatePath(ONBOARDING_PATH);
  redirect(ONBOARDING_PATH);
}

async function useConfiguredSources() {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.currentStep !== "SOURCES") {
    redirect(ONBOARDING_PATH);
  }

  const enabledSourceCount = await prisma.sourcePlaylist.count({
    where: {
      userId,
      enabled: true,
    },
  });

  if (enabledSourceCount < 1) {
    redirect("/onboarding?error=no-source");
  }

  await moveToStep({
    userId,
    from: "SOURCES",
    to: "DESTINATION",
    markCompleted: true,
  });

  revalidatePath(ONBOARDING_PATH);
  redirect(ONBOARDING_PATH);
}

async function saveFirstPlaylistSource(formData: FormData) {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.currentStep !== "SOURCES") {
    redirect(ONBOARDING_PATH);
  }

  const spotifyId = String(
    formData.get("spotifyId") ?? "",
  ).trim();

  try {
    await saveSpotifySourceForUser({
      userId,
      spotifyId,
      spotifyType: SpotifySourceType.PLAYLIST,
      kind: SourceKind.MUSIC,
    });
  } catch (error) {
    const code =
      error instanceof SpotifySourceConfigurationError
        ? error.code
        : "spotify";

    redirect(`/onboarding?error=${code}`);
  }

  await moveToStep({
    userId,
    from: "SOURCES",
    to: "DESTINATION",
    markCompleted: true,
  });

  revalidatePath(ONBOARDING_PATH);
  revalidatePath("/dashboard/configuracao/fontes");
  redirect(ONBOARDING_PATH);
}

async function useExistingDestination() {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.currentStep !== "DESTINATION") {
    redirect(ONBOARDING_PATH);
  }

  const target = await prisma.targetPlaylist.findFirst({
    where: { userId },
    orderBy: [
      { priority: "asc" },
      { createdAt: "asc" },
    ],
    select: { id: true },
  });

  if (!target) {
    redirect("/onboarding?error=no-target");
  }

  await moveToStep({
    userId,
    from: "DESTINATION",
    to: "MUSIC_BEHAVIOR",
    markCompleted: true,
  });

  revalidatePath(ONBOARDING_PATH);
  redirect(ONBOARDING_PATH);
}

async function saveFirstDestination(
  formData: FormData,
) {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.currentStep !== "DESTINATION") {
    redirect(ONBOARDING_PATH);
  }

  const existingTargetCount =
    await prisma.targetPlaylist.count({
      where: { userId },
    });

  if (existingTargetCount > 0) {
    redirect("/onboarding?error=target-exists");
  }

  const name = String(
    formData.get("name") ?? "",
  ).trim();

  const destination = String(
    formData.get("destination") ?? "",
  ).trim();

  const durationMinutes = Number(
    String(formData.get("durationMinutes") ?? ""),
  );

  const composition = String(
    formData.get("composition") ?? "",
  ) as OnboardingCompositionPreset;

  const destinationOffsetRaw = Number(
    String(formData.get("destinationOffset") ?? "0"),
  );

  const destinationOffset =
    Number.isInteger(destinationOffsetRaw) &&
    destinationOffsetRaw >= 0
      ? destinationOffsetRaw
      : 0;

  try {
    await createBasicOnboardingTarget({
      userId,
      name,
      destination,
      destinationOffset,
      durationMinutes,
      composition,
    });
  } catch (error) {
    const code =
      error instanceof OnboardingTargetError
        ? error.code
        : "spotify";

    redirect(`/onboarding?error=${code}`);
  }

  await moveToStep({
    userId,
    from: "DESTINATION",
    to: "MUSIC_BEHAVIOR",
    markCompleted: true,
  });

  revalidatePath(ONBOARDING_PATH);
  revalidatePath(
    "/dashboard/configuracao/destinos",
  );

  redirect(ONBOARDING_PATH);
}

async function saveBasicBehavior(
  formData: FormData,
) {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.currentStep !== "MUSIC_BEHAVIOR") {
    redirect(ONBOARDING_PATH);
  }

  const target = await prisma.targetPlaylist.findFirst({
    where: { userId },
    orderBy: [
      { priority: "asc" },
      { createdAt: "asc" },
    ],
    select: { id: true },
  });

  if (!target) {
    redirect("/onboarding?error=no-target");
  }

  const repeatMode = String(
    formData.get("repeatMode") ?? "",
  );

  if (
    repeatMode !== "AVOID_RECENT" &&
    repeatMode !== "ALLOW_RECENT"
  ) {
    redirect("/onboarding?error=behavior");
  }

  const discoveryPreset = String(
    formData.get("discoveryPreset") ?? "",
  ) as OnboardingDiscoveryPreset;

  if (
    discoveryPreset !== "FAMILIAR" &&
    discoveryPreset !== "BALANCED" &&
    discoveryPreset !== "EXPLORATORY"
  ) {
    redirect("/onboarding?error=behavior");
  }

  try {
    await saveMusicPlaybackPolicyForUser(
      userId,
      {
        enabled: repeatMode === "AVOID_RECENT",
        windowValue: 30,
        windowUnit: MusicRepeatWindowUnit.DAYS,
      },
    );
  } catch {
    redirect("/onboarding?error=behavior");
  }

  const discoveryData =
    onboardingDiscoveryPresetData(
      discoveryPreset,
    );

  const updated =
    await prisma.targetPlaylist.updateMany({
      where: {
        id: target.id,
        userId,
      },
      data: discoveryData,
    });

  if (updated.count !== 1) {
    redirect("/onboarding?error=behavior");
  }

  await moveToStep({
    userId,
    from: "MUSIC_BEHAVIOR",
    to: "CALENDAR",
    markCompleted: true,
  });

  revalidatePath(ONBOARDING_PATH);
  revalidatePath(
    "/dashboard/configuracao/musica",
  );
  revalidatePath(
    "/dashboard/configuracao/destinos",
  );

  redirect(ONBOARDING_PATH);
}


async function connectGoogleCalendar() {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.currentStep !== "CALENDAR") {
    redirect(ONBOARDING_PATH);
  }

  await signIn("google", {
    redirectTo: ONBOARDING_PATH,
  });
}

async function skipCalendarStep() {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.currentStep !== "CALENDAR") {
    redirect(ONBOARDING_PATH);
  }

  const target =
    await prisma.targetPlaylist.findFirst({
      where: { userId },
      orderBy: [
        { priority: "asc" },
        { createdAt: "asc" },
      ],
      select: { id: true },
    });

  if (!target) {
    redirect("/onboarding?error=no-target");
  }

  await moveToStep({
    userId,
    from: "CALENDAR",
    to: "REVIEW",
    markSkipped: true,
  });

  revalidatePath(ONBOARDING_PATH);
  redirect(ONBOARDING_PATH);
}

async function saveCalendarStep(
  formData: FormData,
) {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  if (progress.currentStep !== "CALENDAR") {
    redirect(ONBOARDING_PATH);
  }

  const target =
    await prisma.targetPlaylist.findFirst({
      where: { userId },
      orderBy: [
        { priority: "asc" },
        { createdAt: "asc" },
      ],
      select: { id: true },
    });

  if (!target) {
    redirect("/onboarding?error=no-target");
  }

  const googleCalendarIds = formData
    .getAll("googleCalendarId")
    .filter(
      (value): value is string =>
        typeof value === "string",
    );

  try {
    await configureOnboardingTargetCalendar({
      userId,
      targetId: target.id,
      googleCalendarIds,
    });
  } catch (error) {
    const code =
      error instanceof OnboardingCalendarError
        ? error.code
        : "google";

    redirect(`/onboarding?error=${code}`);
  }

  await moveToStep({
    userId,
    from: "CALENDAR",
    to: "REVIEW",
    markCompleted: true,
  });

  revalidatePath(ONBOARDING_PATH);
  revalidatePath(
    "/dashboard/configuracao/calendarios",
  );
  revalidatePath(
    "/dashboard/configuracao/destinos",
  );

  redirect(ONBOARDING_PATH);
}

async function goBack() {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  const currentStep =
    progress.currentStep as OnboardingStepValue;

  if (
    ![
      "SPOTIFY",
      "SPOTIFY_HISTORY",
      "SOURCES",
      "DESTINATION",
      "MUSIC_BEHAVIOR",
      "CALENDAR",
      "REVIEW",
    ].includes(currentStep)
  ) {
    redirect(ONBOARDING_PATH);
  }

  const previousStep =
    previousOnboardingStep(currentStep);

  if (!previousStep) {
    redirect(ONBOARDING_PATH);
  }

  await prisma.onboardingProgress.update({
    where: { userId },
    data: {
      status: "IN_PROGRESS",
      currentStep: previousStep,
    },
  });

  revalidatePath(ONBOARDING_PATH);
  redirect(ONBOARDING_PATH);
}

async function skipOnboarding() {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);

  await prisma.onboardingProgress.update({
    where: { userId },
    data: {
      status: "SKIPPED",
      skippedAt: new Date(),
      skippedSteps: appendPersistedStep(
        progress.skippedSteps,
        progress.currentStep as OnboardingStepValue,
      ),
    },
  });

  revalidatePath(ONBOARDING_PATH);
  redirect(ONBOARDING_PATH);
}

async function restartOnboarding() {
  "use server";

  const userId = await requireUserId();
  await ensureProgress(userId);

  await prisma.onboardingProgress.update({
    where: { userId },
    data: {
      version: ONBOARDING_VERSION,
      status: "IN_PROGRESS",
      currentStep: "WELCOME",
      completedSteps: [],
      skippedSteps: [],
      startedAt: new Date(),
      readyForSimulationAt: null,
      completedAt: null,
      skippedAt: null,
    },
  });

  revalidatePath(ONBOARDING_PATH);
  redirect(ONBOARDING_PATH);
}

function ProgressDots({
  currentStep,
}: {
  currentStep: OnboardingStepValue;
}) {
  const activeIndex =
    ONBOARDING_STEPS.indexOf(currentStep);

  return (
    <div
      className="flex items-center gap-1.5"
      aria-label={`Progresso do onboarding: etapa ${
        activeIndex + 1
      } de ${ONBOARDING_STEPS.length}`}
    >
      {ONBOARDING_STEPS.map((step, index) => (
        <span
          key={step}
          className={[
            "h-2 flex-1 rounded-full",
            index <= activeIndex
              ? "bg-white"
              : "bg-white/15",
          ].join(" ")}
        />
      ))}
    </div>
  );
}

type OnboardingPageProps = {
  searchParams: Promise<{
    error?: string;
    sourceOffset?: string;
    destinationOffset?: string;
  }>;
};

export default async function OnboardingPage({
  searchParams,
}: OnboardingPageProps) {
  const userId = await requireUserId();
  const params = await searchParams;

  const progress =
    await prisma.onboardingProgress.findUnique({
      where: { userId },
    });

  const status =
    progress?.status ?? "NOT_STARTED";

  const currentStep =
    (progress?.currentStep as
      | OnboardingStepValue
      | undefined) ?? "WELCOME";

  const position =
    onboardingProgressPosition(currentStep);

  const completedSteps =
    readPersistedStepList(progress?.completedSteps);

  const spotifyAccount =
    currentStep === "SPOTIFY" ||
    currentStep === "SPOTIFY_HISTORY" ||
    currentStep === "SOURCES" ||
    currentStep === "DESTINATION"
      ? await prisma.account.findFirst({
          where: {
            userId,
            provider: "spotify",
          },
          select: {
            id: true,
            scope: true,
          },
        })
      : null;

  const configuredSources =
    currentStep === "SOURCES"
      ? await prisma.sourcePlaylist.findMany({
          where: { userId },
          orderBy: [
            { enabled: "desc" },
            { name: "asc" },
          ],
          select: {
            id: true,
            name: true,
            enabled: true,
            kind: true,
            spotifyType: true,
          },
        })
      : [];

  const firstTarget =
    currentStep === "DESTINATION" ||
    currentStep === "MUSIC_BEHAVIOR" ||
    currentStep === "CALENDAR" ||
    currentStep === "REVIEW"
      ? await prisma.targetPlaylist.findFirst({
          where: { userId },
          orderBy: [
            { priority: "asc" },
            { createdAt: "asc" },
          ],
          select: {
            id: true,
            name: true,
            spotifyPlaylistId: true,
            enabled: true,
            durationMode: true,
            fixedDurationSeconds: true,
            calendarMode: true,
            calendarSelections: {
              orderBy: {
                createdAt: "asc",
              },
              select: {
                calendarSelection: {
                  select: {
                    googleCalendarId: true,
                    summary: true,
                  },
                },
              },
            },
            podcastPercent: true,
            discoveryIntensity: true,
          },
        })
      : null;


  const googleAccount =
    currentStep === "CALENDAR"
      ? await prisma.account.findFirst({
          where: {
            userId,
            provider: "google",
          },
          select: { id: true },
        })
      : null;

  let onboardingCalendars: Awaited<
    ReturnType<
      typeof listOnboardingCalendarOptions
    >
  > = [];

  let calendarLoadError = false;

  if (
    currentStep === "CALENDAR" &&
    googleAccount
  ) {
    try {
      onboardingCalendars =
        await listOnboardingCalendarOptions(
          userId,
        );
    } catch {
      calendarLoadError = true;
    }
  }

  const configuredCalendarIds = new Set(
    firstTarget?.calendarSelections.map(
      (entry) =>
        entry.calendarSelection.googleCalendarId,
    ) ?? [],
  );

  const shouldDefaultPrimaryCalendar =
    configuredCalendarIds.size === 0;

  const musicPlaybackPolicy =
    currentStep === "MUSIC_BEHAVIOR"
      ? await prisma.musicPlaybackPolicy.findUnique({
          where: { userId },
          select: {
            enabled: true,
            windowValue: true,
            windowUnit: true,
          },
        })
      : null;

  let playlistPage: SpotifyPlaylistPage | null = null;
  let spotifyRateLimitMessage: string | null = null;
  let spotifyLoadError = false;

  let destinationPage: SpotifyPlaylistPage | null = null;
  let destinationRateLimitMessage: string | null = null;
  let destinationLoadError = false;

  if (
    currentStep === "SOURCES" &&
    spotifyAccount
  ) {
    const requestedOffset = Number(
      params.sourceOffset ?? "0",
    );

    const sourceOffset =
      Number.isInteger(requestedOffset) &&
      requestedOffset >= 0
        ? requestedOffset
        : 0;

    const backoff =
      await getActiveSpotifyBackoff();

    if (backoff) {
      spotifyRateLimitMessage =
        `Spotify temporariamente limitado. Tente novamente em aproximadamente ${
          retryAfterSecondsRemaining(backoff)
        } segundos.`;
    } else {
      try {
        const client =
          await SpotifyClient.forUser(userId);

        playlistPage =
          await client.listCurrentUserPlaylistsPage(
            sourceOffset,
            SOURCE_PAGE_SIZE,
          );

        playlistPage.items.sort(
          (left, right) =>
            left.name.localeCompare(
              right.name,
              "pt-BR",
            ),
        );
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "kind" in error &&
          (
            error.kind === "RATE_LIMITED" ||
            error.kind === "QUOTA_EXCEEDED"
          )
        ) {
          spotifyRateLimitMessage =
            "O Spotify limitou temporariamente as consultas. Seu progresso foi preservado.";
        } else {
          spotifyLoadError = true;
        }
      }
    }
  }

  if (
    currentStep === "DESTINATION" &&
    spotifyAccount &&
    !firstTarget
  ) {
    const requestedOffset = Number(
      params.destinationOffset ?? "0",
    );

    const destinationOffset =
      Number.isInteger(requestedOffset) &&
      requestedOffset >= 0
        ? requestedOffset
        : 0;

    const backoff =
      await getActiveSpotifyBackoff();

    if (backoff) {
      destinationRateLimitMessage =
        `Spotify temporariamente limitado. Tente novamente em aproximadamente ${
          retryAfterSecondsRemaining(backoff)
        } segundos.`;
    } else {
      try {
        const client =
          await SpotifyClient.forUser(userId);

        const [spotifyUserId, page] =
          await Promise.all([
            client.getCurrentUserId(),
            client.listCurrentUserPlaylistsPage(
              destinationOffset,
              DESTINATION_PAGE_SIZE,
            ),
          ]);

        const [sourceRows, targetRows] =
          await Promise.all([
            prisma.sourcePlaylist.findMany({
              where: {
                userId,
                spotifyType:
                  SpotifySourceType.PLAYLIST,
              },
              select: { spotifyId: true },
            }),
            prisma.targetPlaylist.findMany({
              where: { userId },
              select: {
                spotifyPlaylistId: true,
              },
            }),
          ]);

        const blockedIds = new Set([
          ...sourceRows.map(
            (row) => row.spotifyId,
          ),
          ...targetRows.flatMap((row) =>
            row.spotifyPlaylistId
              ? [row.spotifyPlaylistId]
              : [],
          ),
        ]);

        destinationPage = {
          ...page,
          items: page.items
            .filter(
              (playlist) =>
                playlist.ownerId ===
                  spotifyUserId &&
                !blockedIds.has(playlist.id),
            )
            .sort((left, right) =>
              left.name.localeCompare(
                right.name,
                "pt-BR",
              ),
            ),
        };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "kind" in error &&
          (
            error.kind === "RATE_LIMITED" ||
            error.kind === "QUOTA_EXCEEDED"
          )
        ) {
          destinationRateLimitMessage =
            "O Spotify limitou temporariamente as consultas. Seu progresso foi preservado.";
        } else {
          destinationLoadError = true;
        }
      }
    }
  }

  if (status === "COMPLETED") {
    return (
      <main className="min-h-dvh bg-canvas-dark px-5 py-10 text-white">
        <div className="mx-auto max-w-2xl rounded-3xl border border-white/10 bg-white/5 p-8">
          <p className="text-sm font-medium text-white/60">
            Configuração concluída
          </p>
          <h1 className="mt-2 text-3xl font-semibold">
            Seu Sonoriza está pronto.
          </h1>
          <Link
            href="/dashboard"
            className="mt-8 inline-flex rounded-xl bg-white px-5 py-3 font-medium text-black"
          >
            Ir para o Sonoriza
          </Link>
        </div>
      </main>
    );
  }

  if (status === "SKIPPED") {
    return (
      <main className="min-h-dvh bg-canvas-dark px-5 py-10 text-white">
        <div className="mx-auto max-w-2xl rounded-3xl border border-white/10 bg-white/5 p-8">
          <p className="text-sm font-medium text-white/60">
            Onboarding pausado
          </p>
          <h1 className="mt-2 text-3xl font-semibold">
            Você escolheu configurar sozinho.
          </h1>
          <p className="mt-4 text-white/70">
            Nada foi apagado. Você pode voltar ao
            assistente quando quiser.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <form action={restartOnboarding}>
              <button
                type="submit"
                className="rounded-xl bg-white px-5 py-3 font-medium text-black"
              >
                Reiniciar onboarding
              </button>
            </form>

            <Link
              href="/dashboard"
              className="rounded-xl border border-white/15 px-5 py-3 font-medium text-white"
            >
              Ir para o dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-canvas-dark px-4 py-6 text-white sm:px-6 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <header className="mb-8">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-white/55">
                Configuração inicial
              </p>
              <p className="mt-1 text-sm text-white/75">
                Etapa {position.current} de{" "}
                {position.total}
              </p>
            </div>

            <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/55">
              v{ONBOARDING_VERSION}
            </span>
          </div>

          <div className="mt-4">
            <ProgressDots
              currentStep={currentStep}
            />
          </div>
        </header>

        {params.error ? (
          <div className="mb-5 rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
            {params.error === "rate-limit"
              ? "O Spotify limitou temporariamente as consultas. Seu progresso foi preservado."
              : params.error ===
                  "spotify-not-connected"
                ? "Conecte sua conta Spotify para continuar."
                : params.error === "no-source"
                  ? "Escolha pelo menos uma fonte antes de continuar."
                  : params.error === "invalid"
                    ? "Essa fonte não pôde ser validada na conta Spotify conectada."
                    : params.error === "scope"
                      ? "A conta precisa ser reconectada para liberar as permissões necessárias."
                      : params.error === "no-target"
                        ? "Crie ou confirme um destino antes de continuar."
                        : params.error === "target-exists"
                          ? "Já existe um destino configurado. Use o destino existente para continuar."
                          : params.error === "source-conflict"
                            ? "Essa playlist já é usada como fonte e não pode ser o destino."
                            : params.error === "target-conflict"
                              ? "Essa playlist já está vinculada a outro destino."
                              : params.error === "unavailable"
                                ? "Essa playlist não está disponível como destino nesta página."
                                : params.error === "behavior"
                                  ? "Revise suas escolhas de repetição e descoberta."
                                  : params.error ===
                                      "google-not-connected"
                                    ? "Conecte sua conta Google para escolher calendários."
                                    : params.error ===
                                        "calendar-selection"
                                      ? "Escolha pelo menos um calendário disponível."
                                      : params.error === "google"
                                        ? "Não foi possível consultar o Google Agenda agora. Seu progresso foi preservado."
                                        : "Não foi possível consultar o Spotify agora."}
          </div>
        ) : null}

        <section className="rounded-3xl border border-white/10 bg-white/[0.045] p-6 shadow-2xl sm:p-8">
          <p className="text-sm font-medium text-white/50">
            {STEP_LABELS[currentStep]}
          </p>

          {currentStep === "WELCOME" ? (
            <>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Bem-vindo ao Sonoriza
              </h1>

              <p className="mt-5 max-w-2xl text-base leading-7 text-white/70">
                O Sonoriza monta playlists
                automaticamente usando as fontes que
                você escolher, o tempo disponível e
                suas preferências.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <form action={continueWelcome}>
                  <button
                    type="submit"
                    className="rounded-xl bg-white px-6 py-3 font-semibold text-black"
                  >
                    {status === "NOT_STARTED"
                      ? "Começar"
                      : "Continuar configuração"}
                  </button>
                </form>

                <form action={skipOnboarding}>
                  <button
                    type="submit"
                    className="rounded-xl border border-white/15 px-6 py-3 font-medium text-white"
                  >
                    Já sei configurar sozinho
                  </button>
                </form>
              </div>
            </>
          ) : currentStep === "SPOTIFY" ? (
            <>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Conecte seu Spotify
              </h1>

              <p className="mt-5 max-w-2xl text-base leading-7 text-white/70">
                O Sonoriza usa sua conta para enxergar
                as playlists que você pode escolher
                como fonte. Nada será reproduzido ou
                alterado só por conectar a conta.
              </p>

              {spotifyAccount ? (
                <div className="mt-6 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-100">
                  Spotify já conectado. Não é
                  necessário autorizar novamente.
                </div>
              ) : (
                <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm leading-6 text-white/60">
                  Você será enviado ao Spotify para
                  autorizar o acesso e voltará
                  diretamente para esta configuração.
                </div>
              )}

              <div className="mt-8 flex flex-wrap gap-3">
                <form action={goBack}>
                  <button
                    type="submit"
                    className="rounded-xl border border-white/15 px-6 py-3 font-medium text-white"
                  >
                    Voltar
                  </button>
                </form>

                {spotifyAccount ? (
                  <form action={confirmSpotify}>
                    <button
                      type="submit"
                      className="rounded-xl bg-white px-6 py-3 font-semibold text-black"
                    >
                      Continuar
                    </button>
                  </form>
                ) : (
                  <form action={connectSpotify}>
                    <button
                      type="submit"
                      className="rounded-xl bg-white px-6 py-3 font-semibold text-black"
                    >
                      Conectar Spotify
                    </button>
                  </form>
                )}
              </div>
            </>
          ) : currentStep ===
            "SPOTIFY_HISTORY" ? (
            <>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Traga seu histórico do Spotify
              </h1>

              <p className="mt-5 text-base leading-7 text-white/70">
                O histórico estendido ajuda o Sonoriza
                a entender o que você realmente ouviu
                ao longo dos anos. Isso melhora
                estatísticas, redescobertas e
                recomendações.
              </p>

              <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-5">
                <p className="font-semibold">
                  No Spotify:
                </p>

                <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-white/70">
                  <li>
                    Abra a área de privacidade da sua
                    conta.
                  </li>
                  <li>
                    Procure a opção para baixar seus
                    dados.
                  </li>
                  <li>
                    Solicite especificamente{" "}
                    <strong className="text-white">
                      {
                        SPOTIFY_HISTORY_INSTRUCTIONS.packageName
                      }
                    </strong>
                    .
                  </li>
                  <li>
                    O Spotify pode levar alguns dias
                    para preparar o pacote.
                  </li>
                </ol>

                <div className="mt-4 flex flex-wrap gap-3 text-sm">
                  <a
                    href={
                      SPOTIFY_HISTORY_INSTRUCTIONS.accountPrivacyUrl
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                  >
                    Abrir privacidade da conta
                  </a>

                  <a
                    href={
                      SPOTIFY_HISTORY_INSTRUCTIONS.understandingDataUrl
                    }
                    target="_blank"
                    rel="noreferrer"
                    className="underline underline-offset-4"
                  >
                    Entender os dados
                  </a>
                </div>

                <p className="mt-4 text-xs text-white/40">
                  Instruções revisadas em{" "}
                  {
                    SPOTIFY_HISTORY_INSTRUCTIONS.reviewedAt
                  }{" "}
                  — versão{" "}
                  {
                    SPOTIFY_HISTORY_INSTRUCTIONS.version
                  }.
                </p>
              </div>

              <p className="mt-5 text-sm leading-6 text-white/60">
                Você pode continuar agora. Quando os
                arquivos chegarem, o onboarding poderá
                retomar diretamente a importação em um
                gate posterior.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <form action={goBack}>
                  <button
                    type="submit"
                    className="rounded-xl border border-white/15 px-5 py-3 font-medium text-white"
                  >
                    Voltar
                  </button>
                </form>

                <form action={markHistoryRequested}>
                  <button
                    type="submit"
                    className="rounded-xl bg-white px-5 py-3 font-semibold text-black"
                  >
                    Solicitei — continuar
                  </button>
                </form>

                <form action={historyLater}>
                  <button
                    type="submit"
                    className="rounded-xl px-5 py-3 text-sm font-medium text-white/60 hover:text-white"
                  >
                    Fazer isso depois
                  </button>
                </form>
              </div>
            </>
          ) : currentStep === "SOURCES" ? (
            <>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                De onde escolher músicas?
              </h1>

              <p className="mt-5 text-base leading-7 text-white/70">
                Escolha uma primeira fonte. Depois você
                poderá adicionar quantas quiser nas
                configurações normais.
              </p>

              {configuredSources.some(
                (source) => source.enabled,
              ) ? (
                <div className="mt-6 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-5">
                  <p className="font-semibold text-emerald-100">
                    Você já tem fonte configurada
                  </p>

                  <ul className="mt-3 space-y-2 text-sm text-emerald-100/75">
                    {configuredSources
                      .filter(
                        (source) => source.enabled,
                      )
                      .slice(0, 5)
                      .map((source) => (
                        <li key={source.id}>
                          •{" "}
                          {source.name ??
                            "Fonte configurada"}
                        </li>
                      ))}
                  </ul>

                  <form
                    action={useConfiguredSources}
                    className="mt-5"
                  >
                    <button
                      type="submit"
                      className="rounded-xl bg-white px-5 py-3 font-semibold text-black"
                    >
                      Usar fontes já configuradas
                    </button>
                  </form>
                </div>
              ) : null}

              {!spotifyAccount ? (
                <div className="mt-6 rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
                  A conexão Spotify não está mais
                  disponível. Volte uma etapa e
                  reconecte.
                </div>
              ) : spotifyRateLimitMessage ? (
                <div className="mt-6 rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
                  {spotifyRateLimitMessage}
                </div>
              ) : spotifyLoadError ? (
                <div className="mt-6 rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
                  Não foi possível carregar as
                  playlists agora. Seu progresso foi
                  preservado.
                </div>
              ) : playlistPage ? (
                <>
                  <div className="mt-6 grid gap-3">
                    {playlistPage.items.map(
                      (playlist) => (
                        <form
                          key={playlist.id}
                          action={
                            saveFirstPlaylistSource
                          }
                          className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/15 p-4"
                        >
                          <input
                            type="hidden"
                            name="spotifyId"
                            value={playlist.id}
                          />

                          <div className="min-w-0">
                            <p className="truncate font-semibold">
                              {playlist.name}
                            </p>
                            <p className="mt-1 truncate text-xs text-white/45">
                              {playlist.ownerName
                                ? `por ${playlist.ownerName}`
                                : "Playlist do Spotify"}
                            </p>
                          </div>

                          <button
                            type="submit"
                            className="shrink-0 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black"
                          >
                            Usar
                          </button>
                        </form>
                      ),
                    )}
                  </div>

                  {playlistPage.items.length ===
                  0 ? (
                    <p className="mt-6 text-sm text-white/60">
                      Nenhuma playlist apareceu nesta
                      página.
                    </p>
                  ) : null}

                  <div className="mt-5 flex items-center justify-between gap-3">
                    {playlistPage.previousOffset !==
                    null ? (
                      <Link
                        href={`/onboarding?sourceOffset=${playlistPage.previousOffset}`}
                        className="rounded-xl border border-white/15 px-4 py-2 text-sm"
                      >
                        Anteriores
                      </Link>
                    ) : (
                      <span />
                    )}

                    {playlistPage.nextOffset !== null ? (
                      <Link
                        href={`/onboarding?sourceOffset=${playlistPage.nextOffset}`}
                        className="rounded-xl border border-white/15 px-4 py-2 text-sm"
                      >
                        Ver mais
                      </Link>
                    ) : null}
                  </div>
                </>
              ) : null}

              <div className="mt-8 flex gap-3">
                <form action={goBack}>
                  <button
                    type="submit"
                    className="rounded-xl border border-white/15 px-5 py-3 font-medium text-white"
                  >
                    Voltar
                  </button>
                </form>
              </div>
            </>
          ) : currentStep === "DESTINATION" ? (
            <>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Para onde o Sonoriza vai montar?
              </h1>

              <p className="mt-5 text-base leading-7 text-white/70">
                Este é seu primeiro destino. Você pode
                criar uma playlist nova ou usar uma
                playlist própria já existente.
              </p>

              {firstTarget ? (
                <div className="mt-6 rounded-2xl border border-emerald-400/20 bg-emerald-400/10 p-5">
                  <p className="font-semibold text-emerald-100">
                    Você já tem um destino configurado
                  </p>
                  <p className="mt-2 text-sm text-emerald-100/75">
                    {firstTarget.name}
                    {firstTarget.enabled
                      ? " · atualmente ativo"
                      : " · ainda desativado"}
                  </p>

                  <form
                    action={useExistingDestination}
                    className="mt-5"
                  >
                    <button
                      type="submit"
                      className="rounded-xl bg-white px-5 py-3 font-semibold text-black"
                    >
                      Usar este destino
                    </button>
                  </form>
                </div>
              ) : !spotifyAccount ? (
                <div className="mt-6 rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
                  A conexão Spotify não está disponível.
                  Volte para a etapa Spotify.
                </div>
              ) : (
                <form
                  action={saveFirstDestination}
                  className="mt-6 space-y-5"
                >
                  <label className="block">
                    <span className="text-sm font-semibold">
                      Nome
                    </span>
                    <input
                      name="name"
                      required
                      maxLength={100}
                      defaultValue="Minha playlist"
                      className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 outline-none"
                    />
                  </label>

                  <label className="block">
                    <span className="text-sm font-semibold">
                      Playlist no Spotify
                    </span>

                    <select
                      name="destination"
                      defaultValue={
                        ONBOARDING_CREATE_NEW_DESTINATION
                      }
                      className="mt-2 w-full rounded-xl border border-white/10 bg-black/20 px-4 py-3 outline-none"
                    >
                      <option
                        value={
                          ONBOARDING_CREATE_NEW_DESTINATION
                        }
                      >
                        Criar uma nova playlist
                      </option>

                      {destinationPage?.items.map(
                        (playlist) => (
                          <option
                            key={playlist.id}
                            value={playlist.id}
                          >
                            Usar existente:{" "}
                            {playlist.name}
                          </option>
                        ),
                      )}
                    </select>

                    <input
                      type="hidden"
                      name="destinationOffset"
                      value={
                        destinationPage?.offset ?? 0
                      }
                    />
                  </label>

                  {destinationRateLimitMessage ? (
                    <div className="rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
                      {destinationRateLimitMessage}
                    </div>
                  ) : destinationLoadError ? (
                    <div className="rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
                      Não foi possível carregar suas
                      playlists agora. Você ainda pode
                      escolher criar uma nova.
                    </div>
                  ) : null}

                  {destinationPage ? (
                    <div className="flex items-center justify-between gap-3 text-sm">
                      {destinationPage.previousOffset !==
                      null ? (
                        <Link
                          href={`/onboarding?destinationOffset=${destinationPage.previousOffset}`}
                          className="rounded-xl border border-white/15 px-4 py-2"
                        >
                          Playlists anteriores
                        </Link>
                      ) : (
                        <span />
                      )}

                      {destinationPage.nextOffset !==
                      null ? (
                        <Link
                          href={`/onboarding?destinationOffset=${destinationPage.nextOffset}`}
                          className="rounded-xl border border-white/15 px-4 py-2"
                        >
                          Ver mais playlists
                        </Link>
                      ) : null}
                    </div>
                  ) : null}

                  <fieldset>
                    <legend className="text-sm font-semibold">
                      Quanto conteúdo preparar?
                    </legend>

                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[30, 45, 60, 90].map(
                        (minutes) => (
                          <label
                            key={minutes}
                            className="rounded-xl border border-white/10 bg-black/15 p-3"
                          >
                            <input
                              type="radio"
                              name="durationMinutes"
                              value={minutes}
                              defaultChecked={
                                minutes === 45
                              }
                              className="mr-2"
                            />
                            {minutes} min
                          </label>
                        ),
                      )}
                    </div>
                  </fieldset>

                  <fieldset>
                    <legend className="text-sm font-semibold">
                      O que entra nesta playlist?
                    </legend>

                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <label className="rounded-xl border border-white/10 bg-black/15 p-4">
                        <input
                          type="radio"
                          name="composition"
                          value="MUSIC"
                          defaultChecked
                          className="mr-2"
                        />
                        Só música
                      </label>

                      <label className="rounded-xl border border-white/10 bg-black/15 p-4">
                        <input
                          type="radio"
                          name="composition"
                          value="MIXED"
                          className="mr-2"
                        />
                        Música + podcasts
                      </label>

                      <label className="rounded-xl border border-white/10 bg-black/15 p-4">
                        <input
                          type="radio"
                          name="composition"
                          value="PODCAST"
                          className="mr-2"
                        />
                        Só podcasts
                      </label>
                    </div>
                  </fieldset>

                  <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm leading-6 text-white/60">
                    O destino será criado desativado.
                    Nada será gerado nem escrito nele
                    até a ativação explícita depois da
                    simulação.
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <button
                      type="submit"
                      disabled={Boolean(
                        destinationRateLimitMessage,
                      )}
                      className="rounded-xl bg-white px-5 py-3 font-semibold text-black disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {destinationRateLimitMessage
                        ? "Aguardar liberação do Spotify"
                        : "Criar destino e continuar"}
                    </button>
                  </div>
                </form>
              )}

              <form action={goBack} className="mt-8">
                <button
                  type="submit"
                  className="rounded-xl border border-white/15 px-5 py-3 font-medium text-white"
                >
                  Voltar para fontes
                </button>
              </form>
            </>
          ) : currentStep === "MUSIC_BEHAVIOR" ? (
            <>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Como você quer ouvir?
              </h1>

              <p className="mt-5 text-base leading-7 text-white/70">
                Duas escolhas simples agora. Os
                controles detalhados continuam
                disponíveis nas configurações depois.
              </p>

              <form
                action={saveBasicBehavior}
                className="mt-6 space-y-6"
              >
                <fieldset>
                  <legend className="font-semibold">
                    Evitar músicas que você ouviu
                    recentemente?
                  </legend>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <label className="rounded-xl border border-white/10 bg-black/15 p-4">
                      <input
                        type="radio"
                        name="repeatMode"
                        value="AVOID_RECENT"
                        defaultChecked={
                          musicPlaybackPolicy?.enabled ??
                          true
                        }
                        className="mr-2"
                      />
                      Sim, evitar por 30 dias
                    </label>

                    <label className="rounded-xl border border-white/10 bg-black/15 p-4">
                      <input
                        type="radio"
                        name="repeatMode"
                        value="ALLOW_RECENT"
                        defaultChecked={
                          musicPlaybackPolicy?.enabled ===
                          false
                        }
                        className="mr-2"
                      />
                      Não agora
                    </label>
                  </div>
                </fieldset>

                <fieldset>
                  <legend className="font-semibold">
                    Quanto explorar músicas diferentes?
                  </legend>

                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <label className="rounded-xl border border-white/10 bg-black/15 p-4">
                      <input
                        type="radio"
                        name="discoveryPreset"
                        value="FAMILIAR"
                        className="mr-2"
                      />
                      <span className="font-semibold">
                        Mais familiar
                      </span>
                      <span className="mt-1 block text-xs text-white/50">
                        Prioriza familiaridade e
                        redescoberta.
                      </span>
                    </label>

                    <label className="rounded-xl border border-white/10 bg-black/15 p-4">
                      <input
                        type="radio"
                        name="discoveryPreset"
                        value="BALANCED"
                        defaultChecked
                        className="mr-2"
                      />
                      <span className="font-semibold">
                        Equilibrado
                      </span>
                      <span className="mt-1 block text-xs text-white/50">
                        Mistura familiaridade,
                        redescoberta e descoberta.
                      </span>
                    </label>

                    <label className="rounded-xl border border-white/10 bg-black/15 p-4">
                      <input
                        type="radio"
                        name="discoveryPreset"
                        value="EXPLORATORY"
                        className="mr-2"
                      />
                      <span className="font-semibold">
                        Quero descobrir mais
                      </span>
                      <span className="mt-1 block text-xs text-white/50">
                        Aumenta a intensidade de
                        exploração.
                      </span>
                    </label>
                  </div>
                </fieldset>

                <div className="flex flex-wrap gap-3">
                  <button
                    type="submit"
                    className="rounded-xl bg-white px-5 py-3 font-semibold text-black"
                  >
                    Salvar preferências
                  </button>
                </div>
              </form>

              <form action={goBack} className="mt-5">
                <button
                  type="submit"
                  className="rounded-xl border border-white/15 px-5 py-3 font-medium text-white"
                >
                  Voltar para destino
                </button>
              </form>
            </>
          ) : currentStep === "CALENDAR" ? (
            <>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Quer usar o Google Agenda?
              </h1>

              <p className="mt-5 text-base leading-7 text-white/70">
                Essa etapa é opcional. O calendário
                pode definir automaticamente o tamanho
                da playlist conforme seus compromissos.
                Você poderá mudar isso depois.
              </p>

              {firstTarget ? (
                <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-white/45">
                    Destino
                  </p>

                  <p className="mt-1 font-semibold">
                    {firstTarget.name}
                  </p>

                  <p className="mt-2 text-sm leading-6 text-white/55">
                    Nenhuma música será gerada ou
                    escrita nesta etapa.
                  </p>
                </div>
              ) : null}

              {!googleAccount ? (
                <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-5">
                  <p className="font-semibold">
                    Google Agenda ainda não conectado
                  </p>

                  <p className="mt-2 text-sm leading-6 text-white/60">
                    O Sonoriza solicitará somente
                    acesso de leitura ao calendário.
                  </p>

                  <form
                    action={connectGoogleCalendar}
                    className="mt-4"
                  >
                    <button
                      type="submit"
                      className="rounded-xl bg-white px-5 py-3 font-semibold text-black"
                    >
                      Conectar Google Agenda
                    </button>
                  </form>
                </div>
              ) : null}

              {googleAccount &&
              calendarLoadError ? (
                <div className="mt-6 rounded-2xl border border-amber-400/25 bg-amber-400/10 p-5 text-amber-100">
                  <p className="font-semibold">
                    Não foi possível consultar seus
                    calendários agora.
                  </p>

                  <p className="mt-2 text-sm leading-6 opacity-80">
                    Seu progresso foi preservado. A
                    autorização pode ter expirado.
                  </p>

                  <form
                    action={connectGoogleCalendar}
                    className="mt-4"
                  >
                    <button
                      type="submit"
                      className="rounded-xl border border-amber-200/30 px-5 py-3 font-semibold"
                    >
                      Reconectar Google Agenda
                    </button>
                  </form>
                </div>
              ) : null}

              {googleAccount &&
              !calendarLoadError &&
              onboardingCalendars.length > 0 ? (
                <form
                  action={saveCalendarStep}
                  className="mt-6"
                >
                  <fieldset>
                    <legend className="font-semibold">
                      Quais calendários devem definir
                      a duração?
                    </legend>

                    <p className="mt-2 text-sm leading-6 text-white/55">
                      Em uma configuração nova, o
                      calendário principal já aparece
                      selecionado como recomendação.
                    </p>

                    <div className="mt-4 space-y-3">
                      {onboardingCalendars.map(
                        (calendar) => (
                          <label
                            key={calendar.id}
                            className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-black/15 p-4"
                          >
                            <input
                              type="checkbox"
                              name="googleCalendarId"
                              value={calendar.id}
                              defaultChecked={
                                configuredCalendarIds.has(
                                  calendar.id,
                                ) ||
                                (shouldDefaultPrimaryCalendar &&
                                  Boolean(
                                    calendar.primary,
                                  ))
                              }
                              className="mt-1 h-4 w-4"
                            />

                            <span className="min-w-0">
                              <span className="font-semibold">
                                {calendar.summary}
                              </span>

                              {calendar.primary ? (
                                <span className="ml-2 rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-white/45">
                                  Principal
                                </span>
                              ) : null}
                            </span>
                          </label>
                        ),
                      )}
                    </div>
                  </fieldset>

                  <button
                    type="submit"
                    className="mt-5 rounded-xl bg-white px-5 py-3 font-semibold text-black"
                  >
                    Usar calendários selecionados
                  </button>
                </form>
              ) : null}

              {googleAccount &&
              !calendarLoadError &&
              onboardingCalendars.length === 0 ? (
                <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm leading-6 text-white/60">
                  A conta Google não retornou nenhum
                  calendário disponível.
                </div>
              ) : null}

              <div className="mt-8 flex flex-wrap gap-3">
                <form action={skipCalendarStep}>
                  <button
                    type="submit"
                    className="rounded-xl border border-white/15 px-5 py-3 font-medium text-white"
                  >
                    Não usar calendário agora
                  </button>
                </form>

                <form action={goBack}>
                  <button
                    type="submit"
                    className="rounded-xl border border-white/15 px-5 py-3 font-medium text-white"
                  >
                    Voltar para preferências
                  </button>
                </form>
              </div>
            </>
          ) : currentStep === "REVIEW" ? (
            <>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Configuração básica pronta
              </h1>

              <p className="mt-5 text-base leading-7 text-white/70">
                Fonte, destino, preferências e a opção
                de calendário já estão definidos.
                O próximo gate fará a revisão antes
                da primeira simulação.
              </p>

              {firstTarget ? (
                <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-5">
                  <p className="text-xs font-medium uppercase tracking-wide text-white/45">
                    Primeiro destino
                  </p>

                  <p className="mt-1 font-semibold">
                    {firstTarget.name}
                  </p>

                  <p className="mt-2 text-sm leading-6 text-white/55">
                    Duração:{" "}
                    {firstTarget.durationMode ===
                    "CALENDAR"
                      ? "baseada no calendário"
                      : `${Math.max(
                          1,
                          Math.round(
                            (firstTarget.fixedDurationSeconds ??
                              0) / 60,
                          ),
                        )} minutos`}
                  </p>
                </div>
              ) : null}

              <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm leading-6 text-white/60">
                O Gate 6 fará a revisão e a primeira
                simulação. Nenhuma playlist foi
                alterada pelo Gate 5.
              </div>

              <form action={goBack} className="mt-8">
                <button
                  type="submit"
                  className="rounded-xl border border-white/15 px-5 py-3 font-medium text-white"
                >
                  Voltar para calendário
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">
                {STEP_LABELS[currentStep]}
              </h1>

              <p className="mt-5 text-white/70">
                Esta etapa ainda não está liberada neste
                gate.
              </p>
            </>
          )}
        </section>

        <footer className="mt-5 flex items-center justify-between gap-4 text-xs text-white/40">
          <span>
            {completedSteps.length} etapa
            {completedSteps.length === 1 ? "" : "s"}{" "}
            confirmada
            {completedSteps.length === 1 ? "" : "s"}
          </span>

          <span>
            Seu progresso é salvo automaticamente.
          </span>
        </footer>
      </div>
    </main>
  );
}
