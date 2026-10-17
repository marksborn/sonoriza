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

 
## Gate B.2 — durable admission, default OFF

**Status:** implementação experimental, sem endpoint de vínculo e **sem ativação da flag** `AUDIOBOOK02_WRITE_FENCE_MODE=ACTIVE`. Não fazer merge/deploy da migração sem aprovação.

O problema do check simples era uma corrida (TOCTOU): a geração podia ler "sem overlay", e logo depois um usuário vincular o livro enquanto o write remoto ainda estava começando. A estratégia B.2 é persistente e usa linha única `TargetAudiobookWriteFence(userId, spotifyPlaylistId)` para serializar admissão:

1. O writer em modo ACTIVE faz `upsert(activeWrites+1)` numa transação, que segura o row lock enquanto confirma ausência de overlay e de `reviewRequired`.
2. Só após o COMMIT da reserva o writer chama o Spotify. A reserva fica **persistida**, não limitada à vida de um lock de memória ou ao tempo de uma transação externa.
3. Ao completar a chamada com resultado conhecido, reduz `activeWrites`. Em erro ambíguo (WRITE_TIMEOUT, 502, falha de rede, 408 etc.) define `reviewRequired=true`, exigindo reconciliação **manual** antes de permitir futuro vínculo ou outras escritas quando o modo ACTIVE estiver ligado.
4. O futuro fluxo de vínculo chama `withAudiobookOverlayBindAdmission`, que faz um `upsert` no **mesmo registro**, mantém o row lock, exige `activeWrites=0`, `reviewRequired=false`, verifica `TargetPlaylist(userId,id,spotifyPlaylistId)` e só então executa a criação do overlay **na própria transação**. A validação de catálogo/seleção/consentimento deve ocorrer no endpoint autenticado antes dessa transação; o endpoint ainda não existe.
5. Reinício inesperado entre a reserva e a baixa pode deixar `activeWrites>0`; isto bloqueia o vínculo por segurança, **sem expiração automática**. Recuperação exige investigação/reconciliação e ação auditada futura, que NÃO está implementada.

**Fronteiras e riscos ainda abertos:**

- `AUDIOBOOK02_WRITE_FENCE_MODE` é OFF por padrão. O guard antigo continua com bloqueio para overlays existentes mesmo fora do modo ACTIVE. A interface de vínculo não está disponível; portanto ainda não é possível ao usuário proteger destinos automaticamente.
- A estratégia intercepta somente `SpotifyClient.request`; pode existir transporte direto em scripts/runners/API alternativos. O workflow lista candidatos estáticos em `src`/`scripts`, mas essa busca **não constitui prova de cobertura universal**. É necessária revisão humana do inventário.
- A associação e a solicitação ao Spotify devem usar a **mesma identidade usuário + playlist** em todas as rotas. Apenas validar o ID no preview não protege a playlist.
- `reviewRequired` não é confirmação de alteração real; só registra **incerteza**, não transforma 502 em sucesso. Não inventar um procedimento automático de limpeza.
- A base já pode conter um livro inserido manualmente **sem overlay**. Não executar gerador nesse destino até haver vínculo seguro.
- Ainda sem validação real em conta Spotify, sem escrita externa autorizada, sem concluir a auditoria de writers.
- Dependendo da latência/retry remoto, duas escritas simultâneas ficam contadas separadamente; o contador serve para proteger o vínculo, não para ordenar resultados entre writers.
- O modo ACTIVE introduz consultas e escrita adicionais no banco para todos os destinos mutáveis. Avaliar performance, quota e política de retry antes de qualquer rollout.
- O tratamento de falha de liberação da reserva é conservador: pode reter um registro pendente, e deverá existir ferramenta administrativa segura de reconciliação.

**Testes adicionais:** `write-admission.test.ts` (ordem begin→Spotify→finish, desconhecido, 4xx, falha de liberação, usuário desconhecido), `write-admission-store.test.ts` (integração com PostgreSQL descartável, vincular durante escrita deve falhar, write após vínculo deve falhar, resultado incerto bloqueia, destino incorreto falha).

**Atenção:** a proteção da concorrência é candidata técnica em revisão. Não considerar pronta para produção até validação do CI e implementação/autenticação da gravação de vínculos por usuário, e até confirmar ausência de bypass dos writers.


## Auditoria de transportes legados — Gate B.2

O inventário estático executado em CI inicialmente encontrou chamadas ao cliente e transportes alternativos:

- `src/jobs/generate-playlists-incremental.ts`: geração manual/agendada usa `SpotifyClient`, já protegida na camada compartilhada de request.
- `src/services/album-discovery/queue-operation.ts`: usa `writer.appendPlaylistItems` (via `SpotifyClient`), sem novo bypass identificado.
- `src/services/spotify/music-ingestion.ts`: **POST direto** em `/playlists/{id}/items`, não usava `SpotifyClient` nem `spotifyRequestAttempt`. O POST foi envolvido em `guardedSpotifyPlaylistWrite` com o userId original.
- `src/services/spotify/source-cleanup.ts`: **dois DELETEs diretos** em `/playlists/{id}/items` (limpeza manual e periódica). Ambos passaram a usar o mesmo guard.
- `src/services/spotify/album-catalog.ts`, `catalog-search.ts`, `incremental-reader.ts`, `recently-played.ts`: usam transporte comum `spotifyRequestAttempt` e devem ser revisados quanto a método/path; em ACTIVE, novas escritas diretas em `/items` ou `/tracks` são negadas sem token de admissão.
- `src/services/spotify/album-queue-preview.ts` tem leitura `GET`, não um write de playlist.

O guard geral já intercepta `/playlists/{id}/items` e a forma legada `/playlists/{id}/tracks`. A revisão de grep é uma fotografia: chamadas HTTP construídas dinamicamente, fluxos externos, scripts de experimentos ainda em Draft, código fora de `src`/`scripts` e outros providers não podem ser declarados cobertos só por essa busca.

**Importante:** testes automatizados e grep não substituem auditoria de identidade, per-user authorization ou do momento da mutação. O Gate B.2 permanece **não ativado** enquanto não existir registro confirmado de audiobook, avaliação da política de reconciliação de write ambíguo e teste completo do CI atual.
