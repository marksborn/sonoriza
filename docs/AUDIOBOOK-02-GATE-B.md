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


## Gate B.3 — vínculo manual explícito, autenticação e evidência de catálogo

Implementação de backend/contrato criada na branch Draft **#491**, sem disponibilizar UI nem configurar flags de produção.

### API dormente

`POST /api/audiobooks/manual-bind` responde `404 AUDIOBOOK_BIND_DISABLED` por padrão. Só pode operar se **ambas** as flags forem `ACTIVE`:

- `AUDIOBOOK02_BIND_MODE=ACTIVE`
- `AUDIOBOOK02_WRITE_FENCE_MODE=ACTIVE`

Exige sessão Sonoriza permitida pelo wrapper `auth()`, header `Origin` da própria aplicação, `Host` correspondente, payload JSON válido, seleção de capítulo e confirmação literal explícita. O endpoint **não lê nem aceita `spotifyPlaylistId` como entrada**; esse ID é carregado da `TargetPlaylist` pertencente à conta autenticada.

Modelo de corpo (apenas documentação, não ativar em produção):

```json
{
  "targetPlaylistId": "<id do destino no Sonoriza>",
  "spotifyAudiobookId": "5E76EUAq7or1ncd4QNyHjI",
  "selectedChapterId": "71PKNrJrxgaYwUY6srGQ3L",
  "selection": { "mode": "FULL_CHAPTER" },
  "confirmation": "CONFIRMAR_VINCULO_AUDIOLIVRO"
}
```

Uma alternativa para progresso **informado pelo usuário**, nunca inferido da posição no player, é `"selection": {"mode": "MANUAL_REMAINDER", "consumedMs": 10000}`. A API rejeita campos inesperados, duração ou `spotifyPlaylistId` fornecidos pelo caller, IDs fora do formato Spotify e tempos incompatíveis.

### Comprovação e escrita local

1. Busca o destino por `(session.user.id, targetPlaylistId)`. Gate B.3, conservadoramente, só permite destinos **FIXED** com duração explícita e Spotify playlist já associada, sem criação de destino remoto.
2. Faz apenas `GET /audiobooks/{id}` e `GET /chapters/{id}` pelo token da conta conectada, verificando IDs, tipos, `chapter.audiobook.id`, duração positiva real, status/restrições de reprodução e título válido. Se o catálogo negar 401/403/404/429 ou faltar algum campo, **não cria overlay**. Falha fechada é especialmente importante em mercados em que o Spotify não oferece audiobooks via Web API.
3. Executa o cálculo puro do Gate A com a duração real do capítulo e o orçamento FIXED do destino. Rejeita progresso terminado ou capítulo excedente. O `providerDurationMs` do livro permanece `null` — o endpoint de audiobook não fornece duração total autoritativa; não preencher artificialmente 15h22.
4. Cria `TargetAudiobookOverlay` no banco **dentro da mesma transação que adquire `TargetAudiobookWriteFence`**. Se houver escrita ativa ou resultado remoto incerto, muda destino, houver vínculo anterior ou a chave única colidir, aborta sem escrita.
5. Responde `LINKED_LOCAL_ONLY` e dados de planejamento, reforçando que a seleção e a troca de capítulo no player Spotify são manuais. **Não faz nenhuma requisição Spotify POST/PUT/DELETE.**

### Não declarar pronto para rollout

- A entrada ainda não é exibida em UI, nem deve ser ligada por operador em produção; a flag é OFF por padrão.
- A confirmação literal em API não substitui uma UI de consentimento visível e clara, que precisa ser criada e testada antes da liberação.
- A playlist de destino pode ter um item opaco `null`; **isso não prova** que a obra selecionada realmente está naquela playlist. A identidade remota só é uma **declaração manual** explícita do usuário; a API valida o destino e o capítulo no catálogo, não a presença do livro.
- Não foi demonstrado catálogo Spotify disponível para a conta/mercado atual; qualquer negação deve bloquear.
- Mudanças posteriores de `TargetPlaylist.spotifyPlaylistId` precisam ser auditadas/impedidas enquanto houver vínculo. Apagar ou liberar vínculos exigirá protocolo de transação e reconciliação, não criar um DELETE permissivo.
- Todas as instâncias e escritores (inclusive crons e scripts externos) deverão usar a mesma configuração de fence ACTIVE antes de permitir binding. Ativação parcial criaria nova corrida.
- O modo B.3 não muda a composição automática da playlist, que continua sem suporte a audiolivros; o Gate C/D será separado.

**Testes:** `manual-bind-contract.test.ts`, `spotify-chapter-evidence.test.ts`, `bind-manual-audiobook.test.ts` (com PostgreSQL descartável e mock GET Spotify). Não usar conta Spotify real na suíte.

Documentação dos endpoints individuais: [Get Audiobook](https://developer.spotify.com/documentation/web-api/reference/get-an-audiobook) e [Get Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter).


## Gate B.4 — interface de seleção e prévia, desativada por padrão

**Objetivo:** permitir visualizar no navegador a seleção de playlist, livro, capítulo e tempo virtual, sem ativar a geração de audiolivros ou comandar Spotify.

- Nova página: \`/dashboard/configuracao/audiolivros\`, protegida pelo wrapper \`auth()\` e pelo layout de dashboard existente.
- **Flag padrão OFF:** a página, a opção de menu e os endpoints de leitura existem apenas quando \`AUDIOBOOK02_BIND_UI_MODE=PREVIEW\` é configurado explicitamente. Nenhum ambiente de produção foi modificado.
- A página mostra somente destinos \`FIXED\` com playlist Spotify já associada, duração positiva e sem overlay de audiolivro existente.
- O usuário cola o link/ID de um audiolivro existente no Spotify; não se usa o catálogo genérico de música nem se classifica o livro como podcast.
- \`POST /api/audiobooks/catalog\` busca por GET o livro e as páginas do catálogo \`GET /audiobooks/{id}/chapters\` (até 200 capítulos, páginas de 50). Respostas inválidas, acesso negado ou lacunas nas páginas resultam em erro visível. Apenas capítulos explicitamente reproduzíveis são selecionáveis. A UI informa quando a listagem é parcial.
- \`POST /api/audiobooks/manual-preview\` revalida por GET os IDs de livro/capítulo na conta conectada, calcula o orçamento via função pura do Gate A e **não faz INSERT nem chamadas Spotify com método não-GET**.
- O resumo mostra o título oficial, nome de capítulo e tempos (alvo, tempo virtual, saldo). Duas caixas de confirmação exigem que o usuário afirme que inseriu manualmente o livro completo na playlist Spotify e entenda que a troca/controle de capítulos é manual.
- O botão de confirmação chama \`POST /api/audiobooks/manual-bind\` somente quando a UI recebe \`bindingEnabled=true\`. No estado atual, o botão está desabilitado; a API de bind requer as duas flags separadas \`AUDIOBOOK02_BIND_MODE=ACTIVE\` e \`AUDIOBOOK02_WRITE_FENCE_MODE=ACTIVE\`.
- O destino e as durações do capítulo continuam revalidados **no servidor** antes de gravar; a prévia não funciona como token de autorização.
- Formatação e componentes seguem o tema atual do Sonoriza; não exibir telas fictícias ou prometer controle do Spotify.

**Limites:** a API de audiobooks do Spotify informa disponibilidade oficial apenas nos mercados US, UK, CA, IE, NZ e AU. Uma conta fora dos mercados suportados, ou com bloqueio do catálogo, deve receber erro legível e nenhum vínculo. No experimento com a obra já adicionada à playlist, um item opaco \`null\` não confirma automaticamente qual livro está presente.

**Critérios de aceite do Gate B.4:**
- [x] Página + entrada condicional na Configuração.
- [x] Lista de capítulos limitada, guardada e paginada sem comandos de escrita.
- [x] Preview server-side com revalidação e estados de erro.
- [x] Confirmação textual e botão indisponível em modo prévia.
- [x] Testes unitários de catálogos, regras e gate UI incluídos.
- [ ] CI final: confirmar testes, typecheck e regressões após alterações de interface.
- [ ] Teste de interface num ambiente de homologação sem credenciais produtivas.
- [ ] Planejar reconciliação de alterações de ID de playlist, desbloqueio auditado de writes incertos e liberação do bind.
- [ ] Gates C/D para cálculo no planner e playback manual, separados desta interface.

**Sem merge, deploy, alteração na base produtiva ou Spotify.**
