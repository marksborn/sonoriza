# AUDIOBOOK-02 — D.9.1: um livro em andamento (prévia segura)

Issue #489. Decisão registrada pelo usuário em 17/10/2026: **a experiência principal deverá considerar um único audiolivro em andamento por usuário**. A reprodução e a passagem de capítulo continuam **manuais no Spotify**. O histórico deve sobreviver à conclusão de um livro e à entrada do próximo.

## Entrega D.9.1 (este PR)

- Introduz a projeção **read-only** `projectSingleReadingPreview` para apresentar o caderno D.7 existente como anotação atual **somente quando há exatamente um caderno** daquele usuário. Não inventa estados de conclusão, capítulos ou evidência Spotify.
- Se existirem dois ou mais notebooks legados por conta, exibe aviso de revisão em vez de escolher um livro arbitrariamente. Se ownership, proveniência ou duração forem inconsistentes, falha fechada.
- Página experimental `/dashboard/configuracao/audiolivros` mostra a diretriz "Um livro por vez". A consulta adicional ao banco só acontece se `manualNotebookEnabled(process.env)` já estiver habilitado; as flags existentes mantêm comportamento e valores atuais. **Nenhum novo modo de escrita é habilitado.**
- Fecha exclusão recíproca: `withAudiobookOverlayBindAdmission` também recusa cadernos D.7 existentes **sob o lock da mesma cerca durável**. Cobre caderno no próprio destino e em outro destino que compartilhe a mesma playlist Spotify. Tests PostgreSQL garantem que callback de vínculo jamais é chamado.
- Sem migração Prisma, alterações ao `.env`, novos endpoints, arquivamento fictício, triggers externos, planejador de produção ou writes ao Spotify.

## Não afirmar ainda

O modelo atual D.7 tem unicidade **por destino** (`userId,targetPlaylistId`) e aceita mudanças de `bookTitle` ao criar novas revisões. Não é correto afirmar que já existe exclusividade global, histórico de livros concluídos ou mecanismo de troca de livro. A prévia atual não prova nem controla a presença do livro na playlist Spotify e conserva a origem `USER_DECLARED_UNVERIFIED`.

## Próximo gate D.9.2 — conclusão, arquivamento e nova leitura

Implementar em outra PR, com migração explicitamente revisada e testes de concorrência:

1. Modelo explícito **um livro em andamento por usuário** e histórico de leituras **concluídas/arquivadas**, mantendo revisões dos capítulos e distinguindo livros diferentes. Não apagar cadernos existentes durante migração nem presumir que vários notebooks pertencem ao mesmo livro.
2. Operações `CONCLUIR` e `INICIAR_PROXIMO` com autorização do dono, confirmação explícita e CAS. Arquivamento preservar todo o histórico D.7, não apenas as 50 últimas revisões da UI. O fluxo de correção de título deve ser distinto da troca de livro.
3. Preservar proteção do destino Spotify **mesmo após concluir** se o audiolivro inteiro ainda estiver presente. Não liberar write fence por apagar ou arquivar nota local. Necessário procedimento explícito para confirmar remoção do item opaco no Spotify antes de restaurar mutações de playlist.
4. Política de migração para usuários com múltiplos notebooks legados: sinalizar conflito, exigir resolução manual, não escolher nem excluir automaticamente; investigar presença de overlay verificado antes de alterar índices.
5. Homologação com usuário real somente após prova em CI + confirmação. `AUDIOBOOK02_BIND_MODE` e `AUDIOBOOK02_PLANNER_MODE` continuam OFF em produção; não escrever playlists.

## Aceite técnico D.9.1

- [x] Duração do capítulo declarada como manual e não verificada.
- [x] Resumo seguro para um caderno; múltiplos => revisão manual.
- [x] Vinculação verificada bloqueada por caderno existente sob write fence.
- [x] Nenhuma mudança do banco, flags, Spotify ou comportamento do scheduler.
- [ ] Testes CI e build de produção da branch.
- [ ] Homologação visual/mobile futura com D.7 habilitado explicitamente.
