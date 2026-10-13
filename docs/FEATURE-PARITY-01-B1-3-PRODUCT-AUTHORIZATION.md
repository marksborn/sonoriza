# FEATURE-PARITY-B1.3 — autorização de produto por destino

Data: 13/10/2026. Issue #460; parte da #458. **PR empilhado sobre #462 e #461, sem merge/deploy automático.**

## Diferença entre três camadas

1. **Regra:** margem persistida globalmente ou por destino `NONE|DURATION|MUSIC_TRACKS|PODCAST_EPISODES`. É configuração, não permissão.
2. **Autorização do usuário:** `TargetPlaybackReserveActivation.enabled` explicitamente salva por usuário e destino; row ausente = **OFF**. A UI possibilita ativar/revogar.
3. **Liberação técnica:** `PLAYBACK_RESERVE_RUNTIME_MODE=ACTIVE` + `PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE=ACTIVE` + Gate 8 para cada execução. A variável nova fica **OFF quando não configurada**. O piloto antigo `PLAYBACK_RESERVE_ACTIVE_TARGET_IDS` continua independente, com precedência.

O opt-in só pode ser salvo como ON para destino habilitado, Spotify vinculado, manutenção KEEP_FILLED/REBUILD_DAILY e política efetiva de Reserva != NONE. Se isso mudar após o opt-in, o runtime volta a bloquear o novo caminho de produto. Nenhuma regra global liga autorizações individuais automaticamente.

## Segurança e rollback

- Nova tabela: `TargetPlaybackReserveActivation`, identificada por `userId+targetPlaylistId`, foreign key composta com CASCADE; `confirmedAt` representa uma escolha explícita e atualizável. Missing row e `enabled=false` são fail-closed.
- Sem o novo env `PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE=ACTIVE`, o comportamento produtivo legado fica **inalterado**.
- A autorização nova exige explicitamente **um target escolhido**; não autoriza execução multi-target por efeito colateral.
- O fingerprint **apenas para o novo caminho** vincula `spotifyPlaylistId` e `confirmedAt`. Mudar o destino Spotify ou revogar/reautorizar invalida a simulação anterior. O fingerprint do piloto legado permanece compatível.
- `REBUILD_DAILY`: sem simulação aprovada para o fingerprint atual, `ABSTAIN_SIMULATION_REQUIRED`.
- `KEEP_FILLED`: exige snapshot, preflight/simulação inline e sidecars seguros `PRIMARY/RESERVE` como no Gate 8.
- Revogar um opt-in desabilita imediatamente o caminho novo na resolução do runtime; não modifica a playlist remota nem cancela geração anterior já concluída. Se uma geração já estiver em andamento, são necessárias guardas transacionais adicionais para revogação em voo: **não liberar gate produtivo antes dessa revisão.**
- Kill switch operacional: desativar `PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE` para desligar toda autorização nova sem alterar o piloto legado.
- A migração adiciona tabela e índice; é preciso rodar `prisma migrate deploy` **antes** de iniciar processos de aplicação que usam o novo Prisma Client (não fazer deploy manual a partir deste documento).

## Testes/aceite necessários

- [ ] `npx prisma validate && npx prisma migrate deploy && npx prisma generate` em DB isolado de CI.
- [ ] Unitários e integração B1.1+B1.2+B1.3, testes legado Gate7/Gate8, `npm run typecheck && npm run build`.
- [ ] Confirmar idempotência de salvar, revogar, ausência de linha, isolamento multiusuário e vínculo Spotify alterado.
- [ ] Revisar UI desktop/mobile, disponibilidade, label de configuração vs ativo real.
- [ ] Validar simulação real sem escrita Spotify para alvo explicitamente escolhido.
- [ ] **Antes do rollout produtivo**: reforçar guardas anti-TOCTOU para revogação/mudança de vínculo durante a geração e checar guard de prewrite externo. Não habilitar a flag enquanto isso não estiver aprovado.
- [ ] Aprovação explícita separada para merge, deploy e mudança de env. Não abrir a todos de uma vez.

Estado: **CODE_DRAFT / CI_PENDING / PRODUCT_GATE_OFF**. Issues #458/#460 permanecem abertas.
