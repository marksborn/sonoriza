import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
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
  const durationIds = new Set(
    formData
      .getAll("usedForDuration")
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
          usedForDuration: selected && durationIds.has(calendar.id),
        },
        update: {
          summary: calendar.summary,
          selected,
          usedForDuration: selected && durationIds.has(calendar.id),
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
        usedForDuration: true,
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
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />

      <div className="relative mx-auto max-w-5xl">
        <header className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-2 text-sm font-bold text-muted-inverse transition hover:text-ink-inverse"
            >
              <UiIcon name="arrow-left" size={18} />
              Voltar ao painel
            </Link>
            <p className="mt-6 text-xs font-black uppercase tracking-[0.17em] text-accent-400">
              CONFIG-01
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
              Calendários do Google
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-inverse sm:text-base">
              Escolha quais calendários o Sonoriza pode consultar. A coluna de duração global permanece apenas para destinos legados ainda sem calendário próprio.
            </p>
          </div>

          <div className="product-card px-4 py-3 text-sm">
            <p className="font-bold text-ink-inverse">Conta atual</p>
            <p className="mt-1 text-muted-inverse">{session.user.email}</p>
          </div>
        </header>

        {params.saved === "1" && (
          <div className="status-success mt-7 flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="check" size={17} />
            Configuração salva. Nenhuma playlist foi gerada automaticamente.
          </div>
        )}

        {(params.error === "google" || loadError) && (
          <div className="status-warning mt-7 rounded-2xl border p-5">
            <p className="flex items-center gap-2 font-black">
              <UiIcon name="warning" size={18} />
              Não foi possível consultar os calendários agora.
            </p>
            <p className="mt-2 text-sm leading-6 opacity-80">
              O acesso do Google pode ter expirado. Volte ao painel e reconecte a conta antes de tentar novamente.
            </p>
            <Link
              href="/dashboard"
              className="mt-4 inline-flex items-center gap-2 rounded-xl border border-warning/35 px-4 py-2 text-sm font-bold transition hover:bg-warning/10"
            >
              Revisar conexão
              <UiIcon name="arrow-right" size={16} />
            </Link>
          </div>
        )}

        {!googleAccount && (
          <section className="product-panel mt-7 p-6 sm:p-8">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
              Conexão necessária
            </p>
            <h2 className="mt-2 text-2xl font-black text-ink-inverse">Conecte o Google Agenda primeiro</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-inverse">
              O Sonoriza só consegue listar calendários depois que a conta Google está vinculada ao seu usuário.
            </p>
            <Link href="/dashboard" className="mt-5 inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 shadow-action transition hover:bg-accent-400">
              Ir para conexões
              <UiIcon name="arrow-right" size={17} />
            </Link>
          </section>
        )}

        {googleAccount && !loadError && calendars.length > 0 && (
          <form action={saveCalendarSelections} className="mt-7 space-y-5">
            <section className="product-panel overflow-hidden">
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-3 border-b border-line-dark/50 px-4 py-4 text-xs font-black uppercase tracking-[0.13em] text-brand-400 sm:px-6">
                <span>Calendário</span>
                <span className="text-center">Consultar</span>
                <span className="text-center">Duração legado</span>
              </div>

              <div className="divide-y divide-line-dark/45">
                {calendars.map((calendar, index) => {
                  const saved = selectionByCalendar.get(calendar.id);
                  const selected = saved?.selected ?? Boolean(calendar.primary);
                  const usedForDuration = saved?.usedForDuration ?? false;
                  const selectedInputId = `calendar-selected-${index}`;
                  const durationInputId = `calendar-trips-${index}`;

                  return (
                    <article
                      key={calendar.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-4 py-5 transition hover:bg-surface-elevated/45 sm:px-6"
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="truncate font-black text-ink-inverse">{calendar.summary}</h2>
                          {calendar.primary && (
                            <span className="product-badge border-accent/30 bg-accent/10 text-accent-400">
                              Principal
                            </span>
                          )}
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-inverse/65">{calendar.id}</p>
                      </div>

                      <label
                        htmlFor={selectedInputId}
                        className="flex min-w-20 cursor-pointer flex-col items-center gap-2 text-xs font-bold text-muted-inverse"
                      >
                        <input
                          id={selectedInputId}
                          name="selected"
                          value={calendar.id}
                          type="checkbox"
                          defaultChecked={selected}
                          className="h-5 w-5 accent-brand"
                        />
                        Usar
                      </label>

                      <label
                        htmlFor={durationInputId}
                        className="flex min-w-20 cursor-pointer flex-col items-center gap-2 text-xs font-bold text-muted-inverse"
                      >
                        <input
                          id={durationInputId}
                          name="usedForDuration"
                          value={calendar.id}
                          type="checkbox"
                          defaultChecked={usedForDuration}
                          className="h-5 w-5 accent-accent"
                        />
                        Duração legado
                      </label>
                    </article>
                  );
                })}
              </div>
            </section>

            <div className="product-card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-sm leading-6 text-muted-inverse">
                “Consultar” define as agendas disponíveis para seleção por destino e para o modo “Todos os calendários consultáveis”. “Duração legado” só alimenta playlists antigas ainda não migradas.
              </p>
              <button
                type="submit"
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 shadow-action transition hover:-translate-y-0.5 hover:bg-accent-400"
              >
                <UiIcon name="check" size={18} />
                Salvar calendários
              </button>
            </div>
          </form>
        )}

        {googleAccount && !loadError && calendars.length === 0 && (
          <div className="product-card mt-7 p-6 text-center text-muted-inverse">
            A conta Google não retornou nenhum calendário disponível.
          </div>
        )}
      </div>
    </main>
  );
}
