# FEATURE-PARITY-B1.4 — cerca de autorização antes de cada escrita

**Data:** 13/10/2026 · **Issue:** #460 · **Stack:** #461 → #462 → #463 → B1.4.

## Problema

Uma autorização válida ao iniciar uma geração pode tornar-se obsoleta depois do planejamento e antes de escrever no Spotify. Exemplos: revogação de opt-in, kill switch OFF, mudança de destino Spotify, política de atualização passando a MANUAL ou alteração da margem global/override que invalida o fingerprint da simulação.

## Contrato implementado (somente caminho PRODUCT_OPT_IN)

A função `assertPlaybackReserveProductAuthorizationBeforeWrite`, no contexto `AsyncLocalStorage` do Gate 8, consulta **novamente o banco** e o ambiente:

1. Estado da geração: `ACTIVE` real com autorização `PRODUCT_OPT_IN`, um target, `simulationApprovedRunId` e fingerprint válidos.
2. Master global e kill switch de produto ainda em `ACTIVE`.
3. Destino ainda pertence ao usuário, habilitado, Spotify vinculado ao **mesmo ID**, política de manutenção `KEEP_FILLED|REBUILD_DAILY` preservada.
4. Opt-in ainda `enabled` e `confirmedAt` idêntico ao original; revogar/reautorizar invalida o prewrite.
5. Regra global/override atual ainda produz o mesmo fingerprint aprovado, incluindo vínculo Spotify, timestamp da autorização e snapshot de KEEP_FILLED.
6. Reconsulta rápida do destino e da autorização após carregar a policy para reduzir a janela entre leituras.

O gate é chamado pelo `assertGenerationRunWritable` existente **antes de iniciar cada mutação** no Spotify, inclusive antes da criação de playlist, replace, append e remove. Não altera o fluxo da allowlist legada, nem cria uma nova chamada Spotify em simulação.

Se uma checagem falhar, a geração não inicia a **próxima** operação externa e registra `PLAYBACK_RESERVE_PRODUCT_PREWRITE_BLOCKED`. As operações já finalizadas no Spotify **não são revertidas automaticamente**.

## Limite de garantia e risco residual

Uma consulta de autorização feita imediatamente antes da requisição não pode cancelar uma requisição HTTP já enviada ao Spotify nem eliminar matematicamente a pequena janela entre a última leitura e o envio. Assim, **revogação em curso não implica cancelamento atômico de uma escrita já disparada**.

Para exigência contratual de revogação linearizável, implementar um protocolo de publicação/lease transacional, com exclusão entre revogação e início de mutação, definição de timeouts e estado `REVOCATION_PENDING`, sem manter bloqueio SQL por toda a latência do Spotify. Este PR fornece defesa fail-closed nas fronteiras de escrita e documenta explicitamente o limite; não afirma atomicidade inexistente.

## Verificações

- [ ] `PLAYBACK_RESERVE_DB_TEST=1` em CI isolado: `playback-reserve-product-prewrite.integration.test.ts` cobre kill switch, revogação, reautorização, mudança de vínculo, policy e updatePolicy.
- [ ] Gates históricos 1–8 e B1.1/B1.2/B1.3 intactos, `npm run typecheck && npm run build`.
- [ ] Revisar mocks de Spotify para várias mutações KEEP_FILLED: revogação entre APPEND e REMOVE deve impedir REMOVE, e marcar resultado parcial, não retry ambíguo.
- [ ] Documentar eventual necessidade de rollback operacional se ocorrer escrita parcial ou timeout remoto; nenhum retry automático após possível write.
- [ ] Validar com Codex a garantia de produto desejada para revogações durante HTTP já em trânsito.
- [ ] **Não habilitar** `PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE` até homologação operacional e autorização explícita; default continua OFF.
- [ ] Deploy deverá aplicar migração da B1.3 no banco **antes** da aplicação com novo Prisma client.

**Estado:** code draft / CI em validação / produção sem alteração.
