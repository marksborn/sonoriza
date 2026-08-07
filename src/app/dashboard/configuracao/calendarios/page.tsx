import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { GoogleCalendarClient } from "@/services/google-calendar";

async function saveCalendarSelections(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const googleAccount = await prisma.account.findFirst({
    where: {
      userId: session.user.id,
      provider: "google",
    },
    select: { id: true },
  });

  if (!googleAccount) redirect("/dashboard");

  const selectedIds = new Set(
    formData
      .getAll("selected")
      .filter((value): value is string => typeof value === "string"),
  );
  const tripIds = new Set(
    formData
      .getAll("usedForTrips")
      .filter((value): value is string => typeof value === "string"),
  );

  let calendars;
  try {
    const client = await GoogleCalendarClient.forUser(session.user.id);
    calendars = await client.listCalendars();
  } catch {
    redirect("/dashboard/configuracao/calendarios?error=google");
  }

  await prisma.$transaction(
    calendars.map((calendar) => {
      const selected = selectedIds.has(calendar.id);

      return prisma.calendarSelection.upsert({
        where: {
          userId_googleCalendarId: {
            userId: session.user.id,
            googleCalendarId: calendar.id,
          },
        },
        create: {
          userId: session.user.id,
          googleCalendarId: calendar.id,
          summary: calendar.summary,
          selected,
          usedForTrips: selected && tripIds.has(calendar.id),
        },
        update: {
          summary: calendar.summary,
          selected,
          usedForTrips: selected && tripIds.has(calendar.id),
        },
      });
    }),
  );

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/configuracao/calendarios");
  redirect("/dashboard/configuracao/calendarios?saved=1");
}

type CalendarSettingsPageProps = {
  searchParams: Promise<{
    saved?: string;
    error?: string;
  }>;
};

export default async function CalendarSettingsPage({
  searchParams,
}: CalendarSettingsPageProps) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const params = await searchParams;

  const [googleAccount, savedSelections] = await Promise.all([
    prisma.account.findFirst({
      where: {
        userId: session.user.id,
        provider: "google",
      },
      select: { id: true },
    }),
    prisma.calendarSelection.findMany({
      where: { userId: session.user.id },
      select: {
        googleCalendarId: true,
        selected: true,
        usedForTrips: true,
      },
    }),
  ]);

  const selectionByCalendar = new Map(
    savedSelections.map((selection) => [selection.googleCalendarId, selection]),
  );

  let calendars: Awaited<ReturnType<GoogleCalendarClient["listCalendars"]>> = [];
  let loadError = false;

  if (googleAccount) {
    try {
      const client = await GoogleCalendarClient.forUser(session.user.id);
      calendars = await client.listCalendars();
      calendars.sort((left, right) => {
        if (left.primary) return -1;
        if (right.primary) return 1;
        return left.summary.localeCompare(right.summary, "pt-BR");
      });
    } catch {
      loadError = true;
    }
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#0b021f] px-5 py-8 text-white sm:px-8 lg:px-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_12%_5%,rgba(126,34,206,0.3),transparent_31rem),radial-gradient(circle_at_90%_10%,rgba(255,107,0,0.12),transparent_25rem),linear-gradient(180deg,#12032f_0%,#0b021f_55%,#090119_100%)]" />

      <div className="relative mx-auto max-w-5xl">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 text-sm font-bold text-violet-300 transition hover:text-white"
            >
              <span aria-hidden="true">←</span>
              Voltar ao painel
            </Link>
            <p className="mt-6 text-xs font-black uppercase tracking-[0.17em] text-orange-400">
              CONFIG-01
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] sm:text-4xl">
              Calendários do Google
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-violet-200/75 sm:text-base">
              Escolha quais calendários o Sonoriza consulta e quais deles representam
              viagens usadas para calcular a duração das playlists.
            </p>
          </div>

          <div className="rounded-2xl border border-violet-400/20 bg-violet-950/45 px-4 py-3 text-sm text-violet-200/75">
            <p className="font-bold text-white">Conta atual</p>
            <p className="mt-1">{session.user.email}</p>
          </div>
        </header>

        {params.saved === "1" && (
          <div className="mt-7 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-3 text-sm font-bold text-emerald-200">
            Configuração salva. Nenhuma playlist foi gerada automaticamente.
          </div>
        )}

        {(params.error === "google" || loadError) && (
          <div className="mt-7 rounded-2xl border border-orange-400/25 bg-orange-400/10 p-5">
            <p className="font-black text-orange-200">
              Não foi possível consultar os calendários agora.
            </p>
            <p className="mt-2 text-sm leading-6 text-orange-100/70">
              O acesso do Google pode ter expirado. Volte ao painel e reconecte a conta
              antes de tentar novamente.
            </p>
            <Link
              href="/dashboard"
              className="mt-4 inline-flex rounded-xl border border-orange-300/30 px-4 py-2 text-sm font-bold text-orange-100 transition hover:bg-orange-300/10"
            >
              Revisar conexão
            </Link>
          </div>
        )}

        {!googleAccount && (
          <section className="mt-7 rounded-[1.75rem] border border-violet-400/20 bg-violet-950/45 p-6 shadow-[0_24px_70px_-40px_rgba(139,92,246,0.75)] sm:p-8">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-violet-400">
              Conexão necessária
            </p>
            <h2 className="mt-2 text-2xl font-black">Conecte o Google Agenda primeiro</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-violet-200/70">
              O Sonoriza só consegue listar calendários depois que a conta Google está
              vinculada ao seu usuário.
            </p>
            <Link
              href="/dashboard"
              className="mt-5 inline-flex rounded-xl bg-gradient-to-r from-[#ff6b00] to-[#ff8a00] px-5 py-3 text-sm font-black text-white transition hover:brightness-110"
            >
              Ir para conexões
            </Link>
          </section>
        )}

        {googleAccount && !loadError && calendars.length > 0 && (
          <form action={saveCalendarSelections} className="mt-7 space-y-5">
            <section className="overflow-hidden rounded-[1.75rem] border border-violet-400/20 bg-[linear-gradient(145deg,rgba(42,15,94,0.92),rgba(22,6,53,0.94))] shadow-[0_24px_70px_-40px_rgba(139,92,246,0.75)]">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b border-violet-400/15 px-4 py-4 text-xs font-black uppercase tracking-[0.13em] text-violet-300 sm:px-6">
                <span>Calendário</span>
                <span className="text-center">Consultar</span>
                <span className="text-center">Viagens</span>
              </div>

              <div className="divide-y divide-violet-400/15">
                {calendars.map((calendar, index) => {
                  const saved = selectionByCalendar.get(calendar.id);
                  const selected = saved?.selected ?? Boolean(calendar.primary);
                  const usedForTrips = saved?.usedForTrips ?? false;
                  const selectedInputId = `calendar-selected-${index}`;
                  const tripsInputId = `calendar-trips-${index}`;

                  return (
                    <article
                      key={calendar.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-5 transition hover:bg-violet-900/20 sm:px-6"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="truncate font-black text-white">
                            {calendar.summary}
                          </h2>
                          {calendar.primary && (
                            <span className="rounded-full border border-orange-400/25 bg-orange-400/10 px-2.5 py-1 text-[0.68rem] font-black uppercase tracking-wide text-orange-300">
                              Principal
                            </span>
                          )}
                        </div>
                        <p className="mt-1 truncate text-xs text-violet-200/55">
                          {calendar.id}
                        </p>
                      </div>

                      <label
                        htmlFor={selectedInputId}
                        className="flex min-w-20 cursor-pointer flex-col items-center gap-2 text-xs font-bold text-violet-200/70"
                      >
                        <input
                          id={selectedInputId}
                          name="selected"
                          value={calendar.id}
                          type="checkbox"
                          defaultChecked={selected}
                          className="h-5 w-5 accent-violet-500"
                        />
                        Usar
                      </label>

                      <label
                        htmlFor={tripsInputId}
                        className="flex min-w-20 cursor-pointer flex-col items-center gap-2 text-xs font-bold text-violet-200/70"
                      >
                        <input
                          id={tripsInputId}
                          name="usedForTrips"
                          value={calendar.id}
                          type="checkbox"
                          defaultChecked={usedForTrips}
                          className="h-5 w-5 accent-orange-500"
                        />
                        Viagem
                      </label>
                    </article>
                  );
                })}
              </div>
            </section>

            <div className="flex flex-col gap-4 rounded-2xl border border-violet-400/20 bg-violet-950/45 p-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-sm leading-6 text-violet-200/65">
                Um calendário marcado como viagem só será considerado quando também estiver
                marcado para consulta. Essa regra é garantida novamente no servidor ao salvar.
              </p>
              <button
                type="submit"
                className="shrink-0 rounded-xl bg-gradient-to-r from-[#ff6b00] to-[#ff8a00] px-5 py-3 text-sm font-black text-white shadow-[0_14px_35px_-18px_rgba(255,107,0,0.95)] transition hover:-translate-y-0.5 hover:brightness-110"
              >
                Salvar calendários
              </button>
            </div>
          </form>
        )}

        {googleAccount && !loadError && calendars.length === 0 && (
          <div className="mt-7 rounded-2xl border border-violet-400/20 bg-violet-950/45 p-6 text-center text-violet-200/70">
            A conta Google não retornou nenhum calendário disponível.
          </div>
        )}
      </div>
    </main>
  );
}
