import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { UiIcon } from "@/components/UiIcon";
import { auth } from "@/lib/auth";
import {
  executeAlbumQueueWrite,
  getAlbumQueueReview,
} from "@/services/album-discovery/queue-operation";
import { confirmationTokenForAlbum } from "@/services/album-discovery/queue-write";
import {
  formatAlbumDuration,
  formatTrackDuration,
} from "@/services/album-discovery/ui-presentation";

export default async function AlbumDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ albumId: string }>;
  searchParams: Promise<{ result?: string; reason?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  const { albumId } = await params;
  const query = await searchParams;

  let review: Awaited<ReturnType<typeof getAlbumQueueReview>> | null = null;
  try {
    review = await getAlbumQueueReview(session.user.id, albumId, "Adicionar");
  } catch (error) {
    console.error("ALBUM-UI preview load failed", error);
  }

  const expectedSnapshotId =
    review?.status === "PREVIEW_READY" ? review.preview.playlistSnapshotId : null;
  const expectedContentFingerprint =
    review?.status === "PREVIEW_READY" ? review.preview.playlistContentFingerprint : null;

  async function addAlbum() {
    "use server";

    const currentSession = await auth();
    if (!currentSession?.user?.id) redirect("/");
    if (!expectedSnapshotId || !expectedContentFingerprint) {
      redirect(`/dashboard/descobrir/albuns/${albumId}?result=abstain&reason=PREVIEW_NOT_AVAILABLE`);
    }

    const result = await executeAlbumQueueWrite({
      userId: currentSession.user.id,
      spotifyAlbumId: albumId,
      playlistName: "Adicionar",
      expectedSnapshotId,
      expectedContentFingerprint,
      confirmation: confirmationTokenForAlbum(albumId),
    });

    if (result.result === "POST_WRITE_VERIFICATION_FAILED") {
      throw new Error(`Spotify write could not be verified: ${result.reason}`);
    }

    if (result.result === "SUCCESS") {
      revalidatePath("/dashboard/descobrir/albuns");
      revalidatePath(`/dashboard/descobrir/albuns/${albumId}`);
      redirect("/dashboard/descobrir/albuns?added=1");
    }

    redirect(
      `/dashboard/descobrir/albuns/${albumId}?result=abstain&reason=${encodeURIComponent(result.reason)}`,
    );
  }

  return (
    <div className="space-y-5">
      <Link
        href="/dashboard/descobrir/albuns"
        className="inline-flex items-center gap-2 text-sm font-bold text-muted-inverse transition hover:text-ink-inverse"
      >
        <UiIcon name="arrow-left" size={17} />
        Voltar às recomendações
      </Link>

      {query.result === "abstain" ? (
        <div className="status-warning flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm">
          <UiIcon name="warning" size={18} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-black">A playlist mudou ou a edição deixou de estar elegível.</p>
            <p className="mt-1 opacity-80">{friendlyWriteReason(query.reason)}</p>
          </div>
        </div>
      ) : null}

      {!review ? (
        <section className="product-panel p-6">
          <div className="status-warning rounded-2xl border p-4 text-sm">
            Não foi possível carregar o preview agora. Nenhuma alteração foi feita.
          </div>
        </section>
      ) : review.status === "PERSISTED_QUEUED" ? (
        <section className="product-panel p-6 sm:p-8">
          <div className="flex items-start gap-4">
            <span className="product-icon-tile-accent h-12 w-12 shrink-0">
              <UiIcon name="check" size={22} />
            </span>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.15em] text-success">Enfileirado</p>
              <h2 className="mt-1 text-2xl font-black text-ink-inverse">Esta edição já está na sua memória de álbuns.</h2>
              <p className="mt-3 text-sm leading-6 text-muted-inverse">
                O Sonoriza não permite reenfileirar a mesma edição enquanto ela estiver no estado QUEUED.
              </p>
              {review.persistedMemory?.queuedAt ? (
                <p className="mt-2 text-xs text-muted-inverse">
                  Registrado em {formatDate(review.persistedMemory.queuedAt)}.
                </p>
              ) : null}
            </div>
          </div>
        </section>
      ) : review.status === "PLAYLIST_UNRESOLVED" ? (
        <section className="product-panel p-6">
          <div className="status-warning flex items-start gap-3 rounded-2xl border p-4">
            <UiIcon name="warning" size={20} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-black">A playlist Adicionar não pôde ser resolvida com segurança.</p>
              <p className="mt-1 text-sm opacity-80">
                Motivo: {review.playlistResolution.reason}. Nenhuma escrita é permitida enquanto isso não estiver resolvido.
              </p>
            </div>
          </div>
        </section>
      ) : (
        <AlbumPreview review={review} addAlbum={addAlbum} />
      )}
    </div>
  );
}

function AlbumPreview({
  review,
  addAlbum,
}: {
  review: Extract<Awaited<ReturnType<typeof getAlbumQueueReview>>, { status: "PREVIEW_READY" }>;
  addAlbum: () => Promise<void>;
}) {
  const preview = review.preview;

  return (
    <>
      <section className="product-panel overflow-hidden p-6 sm:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-bold text-brand-400">{preview.artistNames.join(", ")}</p>
            <h2 className="mt-1 text-3xl font-black leading-tight tracking-[-0.035em] text-ink-inverse sm:text-4xl">
              {preview.albumName}
            </h2>
            <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-muted-inverse">
              <span className="product-badge px-3 py-1.5">{preview.releaseDate?.slice(0, 4) ?? "Ano ?"}</span>
              <span className="product-badge px-3 py-1.5">{preview.albumTrackCount} faixas</span>
              <span className="product-badge px-3 py-1.5">{formatAlbumDuration(preview.albumDurationMs)}</span>
              <span className="product-badge px-3 py-1.5">edição exata</span>
            </div>
          </div>

          <div className="rounded-2xl border border-line-dark/55 bg-surface-subtle/65 p-4 text-sm lg:w-72">
            <p className="font-black text-ink-inverse">Destino</p>
            <p className="mt-1 text-muted-inverse">Playlist {preview.playlistName}</p>
            <p className="mt-3 text-xs leading-5 text-muted-inverse">
              Antes de escrever, o Sonoriza confere novamente o snapshot e o fingerprint do conteúdo que você revisou aqui.
            </p>
          </div>
        </div>

        {preview.status === "READY_TO_APPEND" ? (
          <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-accent/25 bg-accent/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-black text-ink-inverse">Adicionar a edição completa</p>
              <p className="mt-1 text-sm text-muted-inverse">
                {preview.appendUris.length} faixas serão adicionadas em ordem original. {preview.existingTrackOverlapCount > 0 ? `${preview.existingTrackOverlapCount} faixas já aparecem isoladamente na playlist; a edição completa ainda será preservada.` : "Nenhuma faixa desta edição está atualmente na fila."}
              </p>
            </div>
            <form action={addAlbum}>
              <button
                type="submit"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-black text-brand-900 shadow-action transition hover:bg-accent-400 sm:w-auto"
              >
                <UiIcon name="plus" size={18} />
                Adicionar álbum
              </button>
            </form>
          </div>
        ) : preview.status === "ALREADY_QUEUED" ? (
          <div className="status-success mt-6 flex items-start gap-3 rounded-2xl border p-4 text-sm">
            <UiIcon name="check" size={19} className="mt-0.5 shrink-0" />
            <span>A sequência completa desta edição já está presente na playlist Adicionar. Nenhuma escrita será feita.</span>
          </div>
        ) : (
          <div className="status-warning mt-6 flex items-start gap-3 rounded-2xl border p-4 text-sm">
            <UiIcon name="warning" size={19} className="mt-0.5 shrink-0" />
            <span>Esta edição possui faixas indisponíveis no seu mercado. O Sonoriza não cria uma versão incompleta.</span>
          </div>
        )}
      </section>

      <section className="product-panel p-5 sm:p-6">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.15em] text-brand-400">Tracklist</p>
            <h3 className="mt-1 text-xl font-black text-ink-inverse">Ordem original da edição</h3>
          </div>
          <span className="text-xs font-bold text-muted-inverse">{preview.albumTrackCount} faixas</span>
        </div>

        <ol className="mt-5 divide-y divide-line-dark/45 overflow-hidden rounded-2xl border border-line-dark/55 bg-surface-subtle/55">
          {preview.tracks.map((track) => (
            <li key={track.uri} className="flex items-center gap-4 px-4 py-3 sm:px-5">
              <span className="w-11 shrink-0 text-right text-xs font-black text-muted-inverse">
                {String(track.discNumber).padStart(2, "0")}.{String(track.trackNumber).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink-inverse">{track.name}</span>
              <span className="text-xs text-muted-inverse">{formatTrackDuration(track.durationMs)}</span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

function friendlyWriteReason(reason?: string): string {
  switch (reason) {
    case "EXPECTED_SNAPSHOT_MISMATCH":
    case "EXPECTED_CONTENT_FINGERPRINT_MISMATCH":
      return "O conteúdo da playlist mudou depois que você abriu o preview. Revise novamente antes de confirmar.";
    case "PERSISTED_QUEUED_MEMORY":
      return "Esta edição já foi registrada como enfileirada e não será adicionada novamente.";
    case "PREVIEW_NOT_READY":
      return "A edição não está mais pronta para inclusão integral.";
    case "PLAYLIST_NOT_FOUND":
    case "PLAYLIST_NAME_AMBIGUOUS":
      return "A playlist Adicionar não pôde ser identificada de forma única.";
    default:
      return "A proteção do Sonoriza interrompeu a operação antes de qualquer escrita não autorizada.";
  }
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(value);
}
