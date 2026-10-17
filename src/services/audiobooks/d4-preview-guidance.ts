/**
 * AUDIOBOOK-02 Gate D.4 — honest, user-facing failure explanations.
 * Never infer Spotify ACCOUNT market from location, language or IP.
 */
const messages: Readonly<Record<string, string>> = {
  AUDIOBOOK_CATALOG_UNAVAILABLE:
    "O Spotify não confirmou o catálogo ou os capítulos para esta conta. " +
    "A documentação atual limita a API de audiolivros a US, GB, CA, IE, NZ e AU; " +
    "o Brasil não consta na lista. Também podem ocorrer falhas de autorização, " +
    "permissões ou limite de requisições. Nenhum capítulo foi presumido.",
  AUDIOBOOK_MANUAL_HANDOFF_NO_RECENT_SHADOW:
    "Não há simulação SHADOW concluída para este destino na última hora. " +
    "Execute uma simulação e tente novamente; ela não modifica a playlist.",
  AUDIOBOOK_MANUAL_HANDOFF_DISABLED:
    "A prévia de inclusão manual ainda não está habilitada neste ambiente.",
  AUDIOBOOK_MANUAL_HANDOFF_STALE_OVERLAY:
    "O capítulo ou a associação ao destino mudou. Atualize esta página " +
    "antes de consultar novamente.",
  AUDIOBOOK_MANUAL_HANDOFF_CHANGED_DURING_READ:
    "A configuração mudou durante a leitura Spotify. Nenhuma sugestão foi liberada.",
  AUDIOBOOK_MANUAL_HANDOFF_READ_FAILED:
    "O Spotify não permitiu uma leitura estável da playlist. Nenhuma alteração foi realizada.",
  NO_OPAQUE_ITEM_FOR_MANUAL_VERIFICATION:
    "A playlist não apresentou nenhum item opaco no snapshot lido. " +
    "Confira manualmente o livro inteiro antes de seguir.",
  PROPOSED_ITEMS_ALREADY_IN_PLAYLIST:
    "Uma ou mais sugestões já aparecem na playlist. Gere uma simulação atualizada.",
  BUDGET_OR_PROGRESS_DRIFT:
    "O capítulo ou o orçamento virtual mudou após a simulação. " +
    "Gere uma simulação nova.",
  STALE_OR_UNVERIFIED_SHADOW:
    "A simulação não corresponde mais ao vínculo de audiolivro atual.",
  UNSUPPORTED_SPOTIFY_URI:
    "A simulação inclui um item não adicionável manualmente como música/episódio.",
  CATALOG_OR_CHAPTER_GET_UNAVAILABLE:
    "O catálogo Spotify está indisponível nesta conta ou mercado. " +
    "Não é possível confirmar o capítulo pela API.",
};

export function explainAudiobookPreviewFailure(code: unknown): string {
  if (typeof code !== "string") return "Não foi possível concluir a prévia.";
  return messages[code] ??
    "A validação não autorizou a lista manual. Confira o vínculo e a simulação.";
}
