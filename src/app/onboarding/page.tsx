import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  ONBOARDING_STEPS,
  ONBOARDING_VERSION,
  type OnboardingStepValue,
} from "@/services/onboarding/state";
import {
  appendPersistedStep,
  gate2CanAdvance,
  gate2CanGoBack,
  gate2NextStep,
  gate2PreviousStep,
  onboardingProgressPosition,
  readPersistedStepList,
} from "@/services/onboarding/shell";

const ONBOARDING_PATH = "/onboarding";

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

async function continueOnboarding() {
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
        status: "IN_PROGRESS",
        currentStep: "WELCOME",
        startedAt: new Date(),
        skippedAt: null,
      },
    });

    revalidatePath(ONBOARDING_PATH);
    redirect(ONBOARDING_PATH);
  }

  const currentStep = progress.currentStep as OnboardingStepValue;

  if (progress.status === "NOT_STARTED") {
    await prisma.onboardingProgress.update({
      where: { userId },
      data: {
        status: "IN_PROGRESS",
        startedAt: progress.startedAt ?? new Date(),
      },
    });
  }

  if (!gate2CanAdvance(currentStep)) {
    revalidatePath(ONBOARDING_PATH);
    redirect(ONBOARDING_PATH);
  }

  const nextStep = gate2NextStep(currentStep);
  if (!nextStep) redirect(ONBOARDING_PATH);

  await prisma.onboardingProgress.update({
    where: { userId },
    data: {
      version: ONBOARDING_VERSION,
      status: "IN_PROGRESS",
      currentStep: nextStep,
      startedAt: progress.startedAt ?? new Date(),
      completedSteps: appendPersistedStep(
        progress.completedSteps,
        currentStep,
      ),
    },
  });

  revalidatePath(ONBOARDING_PATH);
  redirect(ONBOARDING_PATH);
}

async function goBack() {
  "use server";

  const userId = await requireUserId();
  const progress = await ensureProgress(userId);
  const currentStep = progress.currentStep as OnboardingStepValue;

  if (!gate2CanGoBack(currentStep)) {
    redirect(ONBOARDING_PATH);
  }

  const previousStep = gate2PreviousStep(currentStep);
  if (!previousStep) redirect(ONBOARDING_PATH);

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
  const activeIndex = ONBOARDING_STEPS.indexOf(currentStep);

  return (
    <div
      className="flex items-center gap-1.5"
      aria-label={`Progresso do onboarding: etapa ${activeIndex + 1} de ${ONBOARDING_STEPS.length}`}
    >
      {ONBOARDING_STEPS.map((step, index) => (
        <span
          key={step}
          className={[
            "h-2 flex-1 rounded-full",
            index <= activeIndex ? "bg-white" : "bg-white/15",
          ].join(" ")}
        />
      ))}
    </div>
  );
}

export default async function OnboardingPage() {
  const userId = await requireUserId();

  const progress = await prisma.onboardingProgress.findUnique({
    where: { userId },
  });

  const status = progress?.status ?? "NOT_STARTED";
  const currentStep =
    (progress?.currentStep as OnboardingStepValue | undefined) ?? "WELCOME";

  const position = onboardingProgressPosition(currentStep);
  const completedSteps = readPersistedStepList(progress?.completedSteps);

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
          <p className="mt-4 text-white/70">
            Você pode revisar e alterar todas as configurações normalmente.
          </p>
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
            Nada foi apagado. Você pode voltar ao assistente quando quiser.
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
                Etapa {position.current} de {position.total}
              </p>
            </div>

            <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/55">
              v{ONBOARDING_VERSION}
            </span>
          </div>

          <div className="mt-4">
            <ProgressDots currentStep={currentStep} />
          </div>
        </header>

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
                O Sonoriza monta playlists automaticamente usando as fontes que
                você escolher, o tempo disponível e suas preferências.
              </p>

              <p className="mt-3 max-w-2xl text-base leading-7 text-white/70">
                Vamos configurar uma coisa de cada vez. Tudo poderá ser alterado
                depois nas telas normais do produto.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <form action={continueOnboarding}>
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
                Conectar Spotify
              </h1>

              <p className="mt-5 max-w-2xl text-base leading-7 text-white/70">
                Esta é a próxima etapa do onboarding. A conexão e validação do
                Spotify entram no Gate 3.
              </p>

              <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm leading-6 text-white/60">
                O Gate 2 não chama a API do Spotify, não sincroniza catálogo e
                não altera nenhuma playlist.
              </div>

              <div className="mt-8 flex flex-wrap gap-3">
                <form action={goBack}>
                  <button
                    type="submit"
                    className="rounded-xl border border-white/15 px-6 py-3 font-medium text-white"
                  >
                    Voltar
                  </button>
                </form>

                <button
                  type="button"
                  disabled
                  className="cursor-not-allowed rounded-xl bg-white/10 px-6 py-3 font-semibold text-white/35"
                >
                  Continuar — disponível no Gate 3
                </button>

                <form action={skipOnboarding}>
                  <button
                    type="submit"
                    className="rounded-xl px-5 py-3 text-sm font-medium text-white/55 hover:text-white"
                  >
                    Configurar sozinho
                  </button>
                </form>
              </div>
            </>
          ) : (
            <>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">
                {STEP_LABELS[currentStep]}
              </h1>

              <p className="mt-5 text-white/70">
                Esta etapa ainda não está liberada neste gate.
              </p>
            </>
          )}
        </section>

        <footer className="mt-5 flex items-center justify-between gap-4 text-xs text-white/40">
          <span>
            {completedSteps.length} etapa
            {completedSteps.length === 1 ? "" : "s"} confirmada
            {completedSteps.length === 1 ? "" : "s"}
          </span>

          <span>Seu progresso é salvo automaticamente.</span>
        </footer>
      </div>
    </main>
  );
}
