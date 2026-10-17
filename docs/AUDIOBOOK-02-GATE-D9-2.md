# AUDIOBOOK-02 — Gate D.9.2: um livro ativo e histórico durável

Origem: decisão do usuário na issue #489, 17/10/2026. Depende do D.9.1 PR #502. PR #503.

## Contrato de produto

1. Uma única leitura de audiolivro declarada em andamento por usuário. A UI mostra título, capítulo atual, duração virtual e caderno; capítulos são selecionados **manualmente**.
2. Ao concluir a leitura, exige checkbox + texto `CONCLUIR_LIVRO_PRESERVAR_HISTORICO` (constante cliente/servidor) e revisão CAS atual.
3. A conclusão **não** remove o livro da playlist Spotify. Em uma única transação, o estado antigo e TODAS as revisões são copiados para `UserAudiobookCompletedReading/Chapter`, e apenas então o caderno D.7 é removido.
4. Novo livro pode ser iniciado no mesmo destino pelo formulário D.7, enquanto **o destino continua impedido de escrita automática ao Spotify** se há qualquer arquivo concluído naquele SpotifyPlaylistId.
5. Dados são `USER_DECLARED_UNVERIFIED`; nenhum capítulo, progresso ou remoção são confirmados pelo Spotify. O planejamento real e a geração/cron não são alterados.

## Permissão, proteção e concorrência

- Novo gate `AUDIOBOOK02_SINGLE_READING_MODE=ACTIVE` **OFF por padrão**, só funciona com as condições D.7: `AUDIOBOOK02_BIND_UI_MODE=PREVIEW`, `AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE=PREVIEW`, `AUDIOBOOK02_MANUAL_NOTEBOOK_MODE=ACTIVE` e `AUDIOBOOK02_WRITE_FENCE_MODE=ACTIVE`.
- API `GET/POST /api/audiobooks/manual-reading` condicionada por flag e sessão. POST exige Origem igual Host, conteúdo restrito, revisão e confirmação. GET pode receber `archiveId` para leitura detalhada **do próprio usuário**.
- Guardas do SpotifyClient, do durable write admission e de vinculação/configuração verificam o arquivo concluído. A guarda do SpotifyClient funciona **independentemente das feature flags**; desativar a flag depois de haver um livro concluído NÃO libera a playlist. Nenhum fluxo de desbloqueio automático foi implementado.
- A gravação D.7 com flag D.9.2 adquire `User FOR UPDATE` antes da cerca de playlist. A conclusão adquire os mesmos locks nessa ordem e requer exatamente um caderno ativo, com CAS de revisão.
- A troca de `bookTitle` em uma leitura ativa é bloqueada no novo modo. Para iniciar outro livro, concluir explicitamente a leitura anterior. Para corrigir um título legado ou migrar cadernos com múltiplos títulos, revisão manual em outro gate.
- Cadernos antigos são **preservados** na migração. Caso já existam mais de um, a operação não elege nenhum como atual e a conclusão falha com motivo de revisão. Não apagar conteúdo silenciosamente.
- A API destrutiva D.7 DELETE passa a recusar exclusão quando a flag D.9.2 estiver ativa; use a operação de concluir, que preserva histórico.

## Estratégia de migração

Migração aditiva (duas tabelas e índices) sem atualização/destruição de D.7 ou de playlists. A exclusividade entre cadernos é garantida por lock serializado `User` nas chamadas de gravação/conclusão **com gate D.9.2 ativo**, e não por índice único global que falharia se houver registros legados com mais de um caderno. Este limite é explícito; outros writers diretos fora do contrato da aplicação não devem criar cadernos.

Archive `originalNotebookId` é UNIQUE. Todas as revisões D.7 são copiadas e verificadas sequenciais; archive tem child unique `(readingId,revision)` e CHECK de proveniência/duração. A API de leitura exibe todos os capítulos do livro selecionado, enquanto a lista inicial limita a 20 livros.

## Testes e rollout

- CI: PostgreSQL descartável, `prisma migrate deploy`, testes de proteção/CAS/arquivo/owner, `npm run typecheck`, `npm run build`.
- Primeiro deploy com flag OFF e backup do DB: não ativa comportamento novo.
- Depois de validar histórico real e fila de destino, ativação D.7 + D.9.2 somente com autorização explícita, mantendo `AUDIOBOOK02_BIND_MODE=OFF` e `AUDIOBOOK02_PLANNER_MODE=OFF`. Antes da ativação, a guarda de todas as escritas da playlist arquivada precisa continuar ativa.
- Não realizar nenhuma escrita remota Spotify durante homologação.
