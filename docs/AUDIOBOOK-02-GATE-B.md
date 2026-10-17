# AUDIOBOOK-02 — Gate B (primeira fase): associação persistente e interdição de writers

**PR Draft empilhada sobre o Gate A** — nunca realizar merge ou deploy sem revisão da migração, prova de compatibilidade e autorização separada.

## O que está implementado nesta fase

1. Modelo `TargetAudiobookOverlay` em Prisma, com referência ao usuário e à `TargetPlaylist`, identidade explícita da playlist Spotify, livro e capítulo, duas durações e progresso local. Limite de **um overlay por destino** e de **um overlay por par usuário + playlist Spotify**.
2. Migração SQL com tabela nova, enum e índices. A migração não altera linhas antigas e não escreve no Spotify; **não foi executada em produção**.
3. `assertAudiobookPlaylistMutationAllowed`: bloqueio fail-closed acionado para métodos `PUT`, `POST`, `DELETE`, `PATCH` no endpoint de **itens de playlist** `/playlists/{id}/items`, incluindo queries. Usuário desconhecido, resposta de proteção indeterminada e erro no lookup impedem a escrita.
4. `SpotifyClient.request` chama o bloqueio **dentro do laço de tentativas**, antes de cada `spotifyRequestAttempt`. Ao encontrar overlay para o par `userId` + `spotifyPlaylistId`, bloqueia substituição, inclusão e exclusão. Criação de uma nova playlist `POST /me/playlists` e operações `GET` não são bloqueadas.
5. Testes offline do guard e testes estáticos do ponto de integração.

## Invariantes obrigatórios antes de um lançamento

- **Não habilitar o overlay na UI nem gerar playlists com audiolivro neste PR.** Nenhum endpoint de vinculação ou desvinculação foi criado; o novo modelo inicia sem registros.
- Vínculos futuros devem ser explicitamente confirmados por usuário autenticado, conferidos contra a `TargetPlaylist` correta, livro/capítulo via catálogo read-only, sem inferir o item opaco `null`.
- **Risco de concorrência (TOCTOU):** o lookup antes do envio não cria exclusão mútua com um processo paralelo que registre o overlay. Antes de ativar gravação de vínculos, implementar serialização transacional/lock compartilhado ou estratégia equivalente, cobrindo criação/remoção de vínculo e writers. Sem isso, não considerar garantia integral de proteção.
- **Risco de bypass:** inventariar todas as mutações Spotify fora de `SpotifyClient.request` (scripts, runners experimentais, rotas e clientes diretos). Este PR cobre apenas writers que usam esse cliente; não alegar proteção universal sem auditoria.
- Se houver um livro inserido manualmente **sem overlay registrado**, a proteção por vínculo ainda não opera. Não usar gerador contra a playlist enquanto o vínculo não estiver armazenado e validado.
- Requisições GET que retornam `item=null` continuam opacas; isso **não demonstra** qual livro existe no destino.
- `chapterDurationMs`, `providerDurationMs`, `manualConsumedMs` usam `Int` do Prisma (até 2.147.483.647). Validar limites inteiros em qualquer futura API de vínculo.
- Antes de ativar caminho de escrita, migrar banco **primeiro**, validar regressões em todos os callers/CI e confirmar que nenhum fluxo direto ignora o guard. Não instalar migração ou habilitar modo ativo em produção nesta etapa.

## Testes previstos

```sh
npx prisma validate
npx prisma migrate deploy  # somente PostgreSQL descartável de CI, jamais produção sem autorização
npx prisma generate
npx tsx --test src/services/audiobooks/*.test.ts
npm run typecheck
```

Este Gate B permanece **PARCIAL**, mesmo que testes passem: ainda faltam fluxo seguro para criar vínculo manual, provas de concorrência e auditoria dos writers. Sem alterar Spotify, motor do planner nem regras existentes de música/podcast. A issue principal permanece aberta: [#489](https://github.com/marksborn/sonoriza/issues/489).
