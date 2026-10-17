# AUDIOBOOK-02 — Gate D.8: simulação consultiva

Issue #489. PR empilhada sobre o Gate D.7 (#499).

O Gate D.8 permite uma estimativa **hipotética** do orçamento restante após um capítulo manual salvo. Ele não consulta capítulos Spotify nem seleciona músicas ou podcasts reais. A origem do capítulo continua `USER_DECLARED_UNVERIFIED`, e as durações ilustrativas são `HYPOTHETICAL_USER_ENTERED_DURATIONS`.

## Cálculo e contrato

O projetor puro `d8-manual-advisory-shadow.ts` recebe um snapshot do caderno D.7 com proprietário e revisão, destino FIXED + PROPORTION + MANUAL e durações hipotéticas digitadas. Ele recusa divergências de proprietário, destino, revisão, duração fixa, origem, overlay validado ou política.

A duração virtual do capítulo corresponde à duração informada menos o progresso declarado. O orçamento restante é dividido pelos percentuais do destino atual, lidos do banco. Cada bloco fictício cabe integralmente no teto da sua categoria ou é ignorado. Não há corte, troca automática de capítulo, identificação Spotify, controle de reprodução, escrita nem persistência da simulação.

Exemplo: destino 300.000 ms, capítulo 20.039 ms e 60% de podcast. Sobram 279.961 ms; teto de podcast 167.976 ms; música 111.985 ms. Amostras musicais 90s e 120s permitem encaixar 90s; amostra de podcast 120s cabe. Total virtual 230.039 ms; saldo final 69.961 ms. Esse resultado não prevê quais faixas reais seriam selecionadas.

**Invariantes de saída:** `durationEvidence=USER_DECLARED_UNVERIFIED`, `sampleEvidence=HYPOTHETICAL_USER_ENTERED_DURATIONS`, `plannerInfluence=false`, `approvalEligible=false`, `spotifyWrites=false`, `bindingEligible=false`, `persistentSimulation=false`, `remoteBookPresenceVerified=false` e `chapterVerifiedBySpotify=false`. Os resultados não contêm Spotify IDs de livro/capítulo ou URIs de músicas.

## API e habilitação

`POST /api/audiobooks/manual-advisory` recebe `targetPlaylistId`, `expectedRevision`, `sampleMusicDurationsMs` e `samplePodcastDurationsMs`, até 12 durações positivas por categoria. Usa login, proteção same-origin, body estrito e cache `no-store`. Lê um snapshot proprietário do caderno e do destino. Revisão antiga ou configuração alterada gera `ABSTAIN`, sem atualizar a nota. Nenhum `GenerationRun` ou estado de aprovação é criado.

A interface `AudiobookManualAdvisory` só aparece quando há caderno salvo e quando todas as flags estão configuradas:
- `AUDIOBOOK02_BIND_UI_MODE=PREVIEW`
- `AUDIOBOOK02_SELF_REPORTED_PREVIEW_MODE=PREVIEW`
- `AUDIOBOOK02_MANUAL_NOTEBOOK_MODE=ACTIVE`
- `AUDIOBOOK02_WRITE_FENCE_MODE=ACTIVE`
- `AUDIOBOOK02_MANUAL_SHADOW_MODE=PREVIEW` (nova)

Todas permanecem OFF por padrão. A flag `AUDIOBOOK02_PLANNER_MODE` não é ativada. A proteção de escrita do Gate D.7 permanece obrigatória mesmo com D.8 desligado.

## Limites e validações

- [x] Calculadora pura e rota separadas do planejamento real e do Spotify.
- [x] Rejeição de revisão antiga, dono diferente, mudança de duração/política, porcentagens inválidas e blocos inconsistentes.
- [x] Testes unitários, SSR e integração com PostgreSQL descartável incluídos.
- [ ] Aprovação final no CI, incluindo testes A–D.8, schema/migrations e typecheck.
- [ ] Revisão visual Chrome/Android e homologação em ambiente isolado.
- [ ] Merge, deploy e flags produtivas exigem autorização explícita. Não executar migrações produtivas nem escritas remotas neste gate.

O Gate D.9 poderá estudar uma prévia com candidatos reais obtidos das fontes configuradas, ainda sem autorização de escrita e sem tratar capítulo manual como catálogo verificado.
