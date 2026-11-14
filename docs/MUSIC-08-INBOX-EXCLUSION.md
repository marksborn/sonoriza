# MUSIC-08 (#319): "Não tocar mais" na inbox e na alimentação

Continuação da PR #558. A mesma preferência (`FirstPartyPlaybackPreference`, `TRACK / EXCLUDED / USER_EXPLICIT`), pelo **ID Spotify exato** da faixa, agora vale também fora do planner.

## Reingestão (MUSIC-03 #36)
- Toda alimentação (regra de playlist, faixas salvas, manual por link) consulta as exclusões antes de escrever na inbox. Uma faixa excluída não é adicionada, nem na prévia.
- Motivo auditável `INGESTION_SKIPPED_USER_EXCLUDED` em `MusicIngestionRun.details.userExcluded` e contagem em `MusicIngestionRun.userExcludedCount`. A exclusão vem antes do cooldown e da deduplicação, para o registro mostrar a decisão humana.
- Restaurar uma faixa não reprocessa eventos antigos: a marca d'água da regra já passou deles. Ela só volta numa nova ingestão normal.

## Limpeza da inbox (MUSIC-02 #35)
- Só fontes em modo inbox (`REMOVE_AFTER_PLAYED`) são afetadas. Fontes `KEEP_ALL` nunca são alteradas por uma exclusão.
- A prévia lista como removíveis as faixas reproduzidas **e** as excluídas. `MusicSourceCleanupRun.userExcludedUris` guarda as que saem só por exclusão, e a tela mostra esse número à parte. Uma faixa reproduzida e excluída conta como reproduzida.
- A exclusão nunca é registrada como reprodução: histórico, `TrackListeningState` e cooldown não mudam.
- A divisão por motivo entra no hash do plano só quando há exclusão. Planos sem exclusão mantêm o hash anterior. Restaurar uma faixa entre a prévia e a confirmação invalida a prévia, e nada é removido.
- A rotina periódica (fontes com automação já autorizada) também remove faixas excluídas, com as mesmas proteções de snapshot e permissão.
- O fallback por quota, que reaproveita uma prévia antiga, se abstém quando há exclusão envolvida, porque uma exclusão é reversível e uma reprodução não. Nesse caso é preciso uma leitura completa da playlist.
- A preferência continua valendo se a remoção física falhar.

## Fora deste corte
- Revisão de skips (quarentena de compliance MUSIC-05/#278).
- Aliases e relinks por identidade canônica (#374): continua valendo só o ID exato, mais o `linked_from` do próprio item da playlist.
- Homologação no navegador e no Android, e a Reserva ponta a ponta.

## Migração
`20261114150000_music08_inbox_exclusion`: só adiciona colunas (`MusicIngestionRun.userExcludedCount`, `MusicSourceCleanupRun.userExcludedUris`). Nenhuma limpeza ou ingestão roda por causa do deploy.
