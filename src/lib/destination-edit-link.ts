const DESTINATIONS_PATH = "/dashboard/configuracao/destinos";

/** Anchor id of a destination card on the Destinos page. */
export function destinationCardId(targetId: string): string {
  return `destino-${targetId}`;
}

/** Opens the Destinos page with this target's editor expanded and in view. */
export function destinationEditHref(targetId: string): string {
  return `${DESTINATIONS_PATH}?editar=${encodeURIComponent(targetId)}#${encodeURIComponent(
    destinationCardId(targetId),
  )}`;
}

/** Anchor id of a destination card on the Composição por evento page. */
export function destinationCompositionCardId(targetId: string): string {
  return `composicao-${targetId}`;
}
