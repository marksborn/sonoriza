import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  loadPlaybackReservePolicy,
  loadTargetPlaybackReservePolicy,
  resolveEffectivePlaybackReservePolicy,
  savePlaybackReservePolicy,
  saveTargetPlaybackReservePolicy,
} from "@/services/playback-reserve-policy";
import {
  formatPlaybackReservePolicyLabel,
  parsePlaybackReservePolicyForm,
  parseTargetPlaybackReservePolicyForm,
} from "@/services/playback-reserve-ui";

function revalidateConfiguration() {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/configuracao");
  revalidatePath("/dashboard/configuracao/reserva");
  revalidatePath("/dashboard/configuracao/revisao");
}

async function saveGlobalPolicy(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  try {
    await savePlaybackReservePolicy(
      session.user.id,
      parsePlaybackReservePolicyForm(formData),
    );
  } catch {
    redirect("/dashboard/configuracao/reserva?error=invalid-global");
  }

  revalidateConfiguration();
  redirect("/dashboard/configuracao/reserva?saved=global");
}

async function saveTargetPolicy(formData: FormData) {
  "use server";

  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const targetPlaylistId = String(formData.get("targetPlaylistId") ?? "").trim();
  if (!targetPlaylistId) {
    redirect("/dashboard/configuracao/reserva?error=invalid-target");
  }

  try {
    await saveTargetPlaybackReservePolicy(
      session.user.id,
      targetPlaylistId,
      parseTargetPlaybackReservePolicyForm(formData),
    );
  } catch {
    redirect(
      `/dashboard/configuracao/reserva?error=invalid-target&target=${encodeURIComponent(targetPlaylistId)}`,
    );
  }

  revalidateConfiguration();
  redirect(
    `/dashboard/configuracao/reserva?saved=target&target=${encodeURIComponent(targetPlaylistId)}`,
  );
}

const inputClass =
  "mt-2 w-full rounded-xl border border-line-dark/70 bg-surface-dark px-4 py-3 text-ink-inverse outline-none transition focus:border-accent-400/70 focus:ring-2 focus:ring-accent/15";

export default async function PlaybackReserveConfigurationPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string; target?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const params = await searchParams;

  const [globalPolicy, targets] = await Promise.all([
    loadPlaybackReservePolicy(session.user.id),
    prisma.targetPlaylist.findMany({
      where: { userId: session.user.id },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        enabled: true,
        updatePolicy: true,
      },
    }),
  ]);

  const targetPolicies = new Map(
    await Promise.all(
      targets.map(async (target) => [
        target.id,
        await loadTargetPlaybackReservePolicy(session.user.id, target.id),
      ] as const),
    ),
  );

  return (
    <main className="product-shell px-5 py-8 sm:px-8 lg:px-10">
      <div className="product-ambient" />

      <div className="relative mx-auto max-w-5xl">
        <Link
          href="/dashboard/configuracao"
          className="inline-flex items-center gap-2 text-sm font-bold text-muted-inverse transition hover:text-ink-inverse"
        >
          <UiIcon name="arrow-left" size={18} />
          Central de configuração
        </Link>

        <div className="mt-7 max-w-3xl">
          <p className="text-xs font-black uppercase tracking-[0.17em] text-accent-400">
            PLAYBACK-RESERVE-01
          </p>
          <h1 className="mt-2 text-3xl font-black tracking-[-0.04em] text-ink-inverse sm:text-4xl">
            Margem de reprodução
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted-inverse sm:text-base">
            Publique um sufixo de reserva depois da programação principal para absorver skips sem fazer a playlist acabar cedo. A reserva nunca corrige shortfall do PRIMARY e não vira skip ou exposição só por ter sido publicada.
          </p>
        </div>

        {params.saved === "global" ? (
          <div className="status-success mt-6 flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="check" size={17} />
            Regra global salva. A alteração entra no fingerprint e exige uma simulação compatível antes de qualquer ACTIVE real.
          </div>
        ) : null}
        {params.saved === "target" ? (
          <div className="status-success mt-6 flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="check" size={17} />
            Regra do destino salva. Nenhuma playlist foi alterada por esta tela.
          </div>
        ) : null}
        {params.error ? (
          <div className="status-warning mt-6 flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-bold">
            <UiIcon name="warning" size={17} />
            Não foi possível salvar. Confira o modo escolhido e informe valores positivos nos campos correspondentes.
          </div>
        ) : null}

        <section className="product-panel mt-7 p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-2xl">
              <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
                Regra global
              </p>
              <h2 className="mt-1 text-xl font-black text-ink-inverse">
                Padrão para todos os destinos
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-inverse">
                Destinos configurados para seguir o padrão global herdam esta regra automaticamente.
              </p>
            </div>
            <span className="product-badge">
              {formatPlaybackReservePolicyLabel(globalPolicy)}
            </span>
          </div>

          <form action={saveGlobalPolicy} className="mt-6">
            <label className="block text-sm font-bold text-ink-inverse">
              Modo da reserva
              <select
                name="reserveMode"
                defaultValue={globalPolicy.reserveMode}
                className={inputClass}
              >
                <option value="NONE">Sem reserva</option>
                <option value="DURATION">Tempo adicional</option>
                <option value="MUSIC_TRACKS">Quantidade de músicas</option>
                <option value="PODCAST_EPISODES">Quantidade de podcasts</option>
              </select>
            </label>

            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <label className="text-sm font-bold text-ink-inverse">
                Minutos extras
                <input
                  name="durationMinutes"
                  type="number"
                  min="0.02"
                  step="0.5"
                  defaultValue={(globalPolicy.durationSeconds ?? 900) / 60}
                  className={inputClass}
                />
                <span className="mt-2 block text-xs font-normal leading-5 text-muted-inverse/75">
                  Usado somente em Tempo adicional.
                </span>
              </label>

              <label className="text-sm font-bold text-ink-inverse">
                Músicas extras
                <input
                  name="musicTrackCount"
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={globalPolicy.musicTrackCount ?? 5}
                  className={inputClass}
                />
                <span className="mt-2 block text-xs font-normal leading-5 text-muted-inverse/75">
                  Usado somente em Quantidade de músicas.
                </span>
              </label>

              <label className="text-sm font-bold text-ink-inverse">
                Podcasts extras
                <input
                  name="podcastEpisodeCount"
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={globalPolicy.podcastEpisodeCount ?? 1}
                  className={inputClass}
                />
                <span className="mt-2 block text-xs font-normal leading-5 text-muted-inverse/75">
                  Usado somente em Quantidade de podcasts.
                </span>
              </label>
            </div>

            <label className="mt-5 flex items-start gap-3 rounded-2xl border border-line-dark/70 bg-surface-dark/55 p-4">
              <input
                name="podcastInDurationReserve"
                type="checkbox"
                value="IF_FITS"
                defaultChecked={globalPolicy.podcastInDurationReserve === "IF_FITS"}
                className="mt-1 h-5 w-5 accent-accent"
              />
              <span>
                <span className="block font-black text-ink-inverse">
                  No modo Tempo adicional, tentar 1 podcast se couber
                </span>
                <span className="mt-1 block text-sm leading-6 text-muted-inverse">
                  A duração é filtro, não ranking. Se nenhum episódio elegível couber, a reserva pode ser completada somente com música.
                </span>
              </span>
            </label>

            <button
              type="submit"
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 shadow-action transition hover:-translate-y-0.5 hover:bg-accent-400"
            >
              <UiIcon name="check" size={18} />
              Salvar regra global
            </button>
          </form>
        </section>

        <section className="mt-8">
          <div className="max-w-3xl">
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">
              Overrides por destino
            </p>
            <h2 className="mt-1 text-2xl font-black text-ink-inverse">
              Ajuste apenas onde fizer sentido
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted-inverse">
              Cada destino pode seguir a regra global ou usar uma configuração própria, inclusive Sem reserva mesmo quando o padrão global estiver ativo.
            </p>
          </div>

          <div className="mt-5 space-y-4">
            {targets.length === 0 ? (
              <div className="product-panel p-6 text-sm leading-6 text-muted-inverse">
                Nenhum destino configurado ainda.
              </div>
            ) : null}

            {targets.map((target) => {
              const targetPolicy = targetPolicies.get(target.id)!;
              const effective = resolveEffectivePlaybackReservePolicy(
                target.id,
                globalPolicy,
                targetPolicy,
              );
              const durationSeconds =
                targetPolicy.durationSeconds ?? globalPolicy.durationSeconds ?? 900;
              const musicTrackCount =
                targetPolicy.musicTrackCount ?? globalPolicy.musicTrackCount ?? 5;
              const podcastEpisodeCount =
                targetPolicy.podcastEpisodeCount ??
                globalPolicy.podcastEpisodeCount ??
                1;
              const podcastMode =
                targetPolicy.podcastInDurationReserve ??
                globalPolicy.podcastInDurationReserve;
              const editorReserveMode =
                targetPolicy.reserveMode ?? globalPolicy.reserveMode;

              return (
                <article key={target.id} className="product-panel p-5 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-black text-ink-inverse">
                          {target.name}
                        </h3>
                        <span className="product-badge">
                          {target.enabled ? "Ativo" : "Desativado"}
                        </span>
                        <span className="product-badge">{target.updatePolicy}</span>
                      </div>
                      <p className="mt-2 text-sm text-muted-inverse">
                        Efetiva: <strong className="text-ink-inverse">{formatPlaybackReservePolicyLabel(effective)}</strong>
                        {" · "}
                        {effective.source === "GLOBAL"
                          ? "seguindo a regra global"
                          : "override deste destino"}
                      </p>
                    </div>
                  </div>

                  <details
                    className="mt-5 rounded-2xl border border-line-dark/70 bg-surface-dark/45 p-4"
                    open={params.target === target.id}
                  >
                    <summary className="cursor-pointer select-none text-sm font-black text-ink-inverse">
                      Editar margem deste destino
                    </summary>

                    <form action={saveTargetPolicy} className="mt-5">
                      <input type="hidden" name="targetPlaylistId" value={target.id} />

                      <div className="grid gap-4 md:grid-cols-2">
                        <label className="text-sm font-bold text-ink-inverse">
                          Comportamento
                          <select
                            name="policyMode"
                            defaultValue={targetPolicy.policyMode}
                            className={inputClass}
                          >
                            <option value="INHERIT_GLOBAL">Seguir configuração global</option>
                            <option value="OVERRIDE">Personalizar para esta playlist</option>
                          </select>
                        </label>

                        <label className="text-sm font-bold text-ink-inverse">
                          Modo personalizado
                          <select
                            name="reserveMode"
                            defaultValue={editorReserveMode}
                            className={inputClass}
                          >
                            <option value="NONE">Sem reserva</option>
                            <option value="DURATION">Tempo adicional</option>
                            <option value="MUSIC_TRACKS">Quantidade de músicas</option>
                            <option value="PODCAST_EPISODES">Quantidade de podcasts</option>
                          </select>
                        </label>
                      </div>

                      <p className="mt-3 text-xs leading-5 text-muted-inverse/75">
                        Se escolher Seguir configuração global, todos os campos personalizados abaixo são ignorados.
                      </p>

                      <div className="mt-4 grid gap-4 md:grid-cols-3">
                        <label className="text-sm font-bold text-ink-inverse">
                          Minutos extras
                          <input
                            name="durationMinutes"
                            type="number"
                            min="0.02"
                            step="0.5"
                            defaultValue={durationSeconds / 60}
                            className={inputClass}
                          />
                        </label>
                        <label className="text-sm font-bold text-ink-inverse">
                          Músicas extras
                          <input
                            name="musicTrackCount"
                            type="number"
                            min={1}
                            step={1}
                            defaultValue={musicTrackCount}
                            className={inputClass}
                          />
                        </label>
                        <label className="text-sm font-bold text-ink-inverse">
                          Podcasts extras
                          <input
                            name="podcastEpisodeCount"
                            type="number"
                            min={1}
                            step={1}
                            defaultValue={podcastEpisodeCount}
                            className={inputClass}
                          />
                        </label>
                      </div>

                      <label className="mt-4 flex items-start gap-3">
                        <input
                          name="podcastInDurationReserve"
                          type="checkbox"
                          value="IF_FITS"
                          defaultChecked={podcastMode === "IF_FITS"}
                          className="mt-1 h-5 w-5 accent-accent"
                        />
                        <span className="text-sm leading-6 text-muted-inverse">
                          Em Tempo adicional, tentar 1 podcast elegível se ele couber integralmente.
                        </span>
                      </label>

                      <button
                        type="submit"
                        className="mt-5 inline-flex items-center gap-2 rounded-xl border border-brand-400/35 bg-brand-400/10 px-4 py-2.5 text-sm font-black text-ink-inverse transition hover:bg-brand-400/15"
                      >
                        <UiIcon name="check" size={17} />
                        Salvar regra de {target.name}
                      </button>
                    </form>
                  </details>
                </article>
              );
            })}
          </div>
        </section>

        <div className="status-warning mt-7 rounded-2xl border p-5">
          <div className="flex items-start gap-3">
            <UiIcon name="warning" size={19} />
            <div>
              <p className="font-black">Configurar não significa ativar o rollout.</p>
              <p className="mt-1 text-sm leading-6">
                Esta tela persiste a policy e altera o fingerprint da configuração. O runtime ACTIVE continua protegido pelos gates de allowlist, simulação aprovada, snapshot e role persistence dos Gates 7–8.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
