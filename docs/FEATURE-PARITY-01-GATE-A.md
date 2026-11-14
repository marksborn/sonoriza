# FEATURE-PARITY-01 — Gate A: inventário inicial e matriz por capacidade

**Data:** 13/10/2026, revisado em 14/11/2026 · **Issue mãe:** [#458](https://github.com/marksborn/sonoriza/issues/458) · **Estado:** `SOURCE_AUDITED / LIVE_SNAPSHOT_13_10 / NOVEMBER_CAPABILITIES_MAPPED / CROSS_TRIGGER_PARITY_PARTIAL`.

> **Revisão de 14/11/2026.** A seção 3A registra as capacidades entregues entre 14/10 e 14/11 e o estado delas na `main`. O script foi atualizado para cobri-las (seção 5). A coleta de 13/10 continua resumida em [`FEATURE-PARITY-01-GATE-A-LIVE-SUMMARY.md`](FEATURE-PARITY-01-GATE-A-LIVE-SUMMARY.md); uma nova coleta é o próximo passo para classificar destino × gatilho com dados atuais.

Este documento registra **evidência de código da branch `main`** e uma **fotografia operacional histórica de 10/10/2026** relatada na [#449](https://github.com/marksborn/sonoriza/issues/449). **Não contém um snapshot atual do banco, dos `.env` de produção ou dos `GenerationRun.summary` reais**, portanto não declara nenhum recurso globalmente ativo. Não autoriza alterar produção, configurar flags, gerar playlists, fazer Spotify writes, merge ou deploy.

## 1. Estados separados (não confundir)

- **COMPATÍVEL:** a forma/capacidade do destino permite usar o recurso.
- **CONFIGURÁVEL:** há controle de produto persistido e editável pela UI.
- **GATEADO:** a implementação existe, porém exige flag, allowlist, consentimento, simulação aprovada ou contexto operacional específico.
- **EFETIVO:** `GenerationRun.summary` de uma execução real prova `ACTIVE` naquele `target × trigger` sem abstention. Somente configuração no `.env` **não** basta.
- **PENDENTE:** ainda demanda implementação, testes e UX próprios; não ativar só por existir documentação, schema ou shadow.
- **NÃO APLICÁVEL:** incompatibilidade estrutural, explicada (e não ocultada) na UI.

## 2. Matriz histórica de destinos × capacidade

Evidência [#449](https://github.com/marksborn/sonoriza/issues/449): em **10/10/2026**, seis destinos, quatro habilitados com `SEQUENCE` e agendamento, dois desabilitados com `PROPORTION/MANUAL`. Não inferir que permaneçam iguais no dia 13.

| Destino (fotografia 10/10) | Ativo | Composição | Atualização | Podcast por slot | Reserva por política | Estado efetivo das features |
|---|---|---|---|---|---|---|
| Carro | Sim | SEQUENCE | KEEP_FILLED | Possível se houver slots/sources PODCAST | Potencial, sujeito a snapshot/preflight | **A verificar em runtime** |
| Trabalho | Sim | SEQUENCE | REBUILD_DAILY | Possível se houver slots/sources PODCAST | Potencial, sujeito a gates | **A verificar em runtime** |
| Academia | Sim | SEQUENCE | KEEP_FILLED | Possível se houver slots/sources PODCAST | Potencial, sujeito a snapshot/preflight | **A verificar em runtime** |
| Avulsa | Sim | SEQUENCE | REBUILD_DAILY | Possível se houver slots/sources PODCAST | Potencial, sujeito a gates | **A verificar em runtime**; identidade teve canary validado na #374 |
| Destino inativo A (nome não publicado) | Não | PROPORTION | MANUAL | **N/A** para bandas por slot | Não elegível ao runtime atual de Reserva | Sem geração ativa; exigir simulação interna isolada |
| Destino inativo B (nome não publicado) | Não | PROPORTION | MANUAL | **N/A** para bandas por slot | Não elegível ao runtime atual de Reserva | Sem geração ativa; exigir simulação interna isolada |

**Importante:** fontes como `Escutar` e `Adicionar` podem ser **fontes**, não presumir que sejam `TargetPlaylist`; verificar entidade e relações no banco. O código permite combinações novas além dos quatro nomes históricos.

## 3. Matriz de funcionalidades × elegibilidade × evidência

| Recurso | Compatibilidade de produto | Evidência da `main` | Situação de paridade / decisão |
|---|---|---|---|
| Composição `PROPORTION/SEQUENCE`, duração e ordem | Todos os destinos; sequência de slots somente em `SEQUENCE` | `prisma/schema.prisma`, `src/components/TargetPlaylistForm.tsx` | **Configuração geral existente**; testar por modo e fonte |
| Fonte global ou `SELECTED_ONLY`, exclusividade entre targets | Todos os destinos, respeitando fontes habilitadas | `TargetPlaylist.sourceScopeMode`, `sharingPolicy`, `TargetPlaylistSource`, `generate-playlists-incremental.ts` | **Configuração/guardas existentes**; não expandir fontes implicitamente |
| Música curtida / Saved Tracks no planner | Destinos com música, preferência habilitada e consentimento válido | #186; `NativeSourcePreference` no schema; flows de liked source/shadow | **Caminho existente com gate**; provar efetividade por usuário/destino/trigger e retirar dependência de listas fixas somente após validação |
| MUSIC-07 exposição/cooldown | Destinos elegíveis com música | #343; `MUSIC_07_ELIGIBILITY_MODE/SCOPE` (`ALLOWLIST/GLOBAL`) | **Global tecnicamente previsto**, mas `.env` real/`GenerationRun` não verificados; isolamento por target obrigatório |
| Discovery atual (3 intensidades, famílias) | Destinos com música e fonte/contexto válidos | `TargetDiscoveryForm`, `target-discovery-runtime-policy`, #376 | **Controles por destino existentes**, mas runtime requer master + allowlist de usuário; não inferir ativo a partir do toggle |
| Playback Reserve | `KEEP_FILLED`/`REBUILD_DAILY` com contexto válido; `MANUAL` não suportado pelo gate atual | `configuracao/reserva/page.tsx`, `playback-reserve-shadow-runtime.ts`, #354 | **UI global e override por destino existentes**; `ACTIVE` exige target único autorizado e, para `KEEP_FILLED`, snapshot/preflight; verificar por trigger |
| PODCAST-09 continuação `IN_PROGRESS` | Destinos com podcast e política elegível | `generate-playlists-podcast09.ts`, #421 | **Implementada com gates** separados para SIMULATION, MANUAL real e SCHEDULED real; validar `effectiveMode` por target/trigger |
| PODCAST-08 banda `ANY/SHORT/MEDIUM/LONG` por slot | Somente `SEQUENCE` contendo slots e fontes de PODCAST | `TargetPlaylist.podcastDurationSlotBands`, `TargetPlaylistForm` (editor gateado), #365 #448 #449 #451 | **Atualizado em 14/11:** #365 concluída, com cabeça de fila para programas ordenados, prévia efêmera, editor mobile (#448/#510) e validação no piloto Trabalho. A seleção por banda continua dependente de `PODCAST08_ACTIVE_MODE` + allowlist de destinos; não generalizar sem decisão |
| MUSIC-IDENTITY canônica | Destinos de música compatíveis quando consumer específico estiver migrado | `canonical-dedupe-runtime.ts`, `generate-playlists-music-identity.ts`, #374 | **Canary Avulsa histórico**; exige par exato `user:target`; demais consumers e rollout não concluídos |
| Discovery Inbox e estratégias novas | Futuramente destinos de música opt-in | #375 #376 (ausência dos contratos finais) | **Pendente**; manter Discovery atual sem migração silenciosa |
| Álbum completo como bloco indivisível | Futuramente destinos com música/álbum opt-in | #377; fila `Adicionar` da #102 é separada | **Pendente**; não confundir fila/recomendação com unidade de planejamento |
| Atualizar só após uso (`AFTER_TARGET_USE`) | Destinos com atualização automática e evidência positiva adequada | #402; `updatePolicy` existente é como atualizar, não quando atualizar | **Pendente**; contrato de evidência do destino não implantado |
| Lease/redistribuição de conteúdo não consumido | Destinos com exclusividade e remoção remota comprovada | #403; docs arquiteturais | **Pendente**; nunca liberar só por expiração/ausência de scrobble |
| Outros backlogs: curadoria skips, Novidades, Fora da bolha, pesquisa de podcasts | Conforme tipo e consentimento | #319 #161 #203 #209 | **A rastrear separadamente**; não bloqueiam inventário de recursos existentes |

## 3A. Capacidades entregues entre 14/10 e 14/11/2026

Estado na `main` em 14/11. "Implantada" significa código em produção confirmado por `DEPLOY OK`; não significa ativa. Uma flag `UNSET` mantém o comportamento anterior.

| Capacidade | Issue / PRs | Controle por destino | Interruptor do operador | Estado |
|---|---|---|---|---|
| Sequência por evento (CALENDAR-04) | #532 | Composição por evento → `SEQUENCE_PER_EVENT` | `CALENDAR_04_PLANNER_MODE` | Concluída na #532 |
| Regenerar a cada evento (CALENDAR-05) | #553 · #554 #555 | `regenerateOnEvent` + antecedência 5/15/30 min | `CALENDAR_05_EVENT_REGENERATION_MODE` (padrão OFF) | Código na `main`; ativação e aceite operacional pendentes |
| Podcast Snippet (episódios ≤ 5 min em posição de música) | #559 · #560 | Checkbox `allowPodcastSnippets` (padrão desmarcado) | `PODCAST_SNIPPET_MODE` (padrão OFF) | **Implantada em 14/11 (`6a0b41d`), desligada.** Toda geração registra `summary.podcastSnippet` para o levantamento de impacto antes da ativação |
| "Não tocar mais" no planner | #319 · #558 | Global por usuário (preferência explícita) | — | Implantada; homologação parcial |
| "Não tocar mais" na alimentação e na limpeza da inbox | #319 · #561 | Global por usuário; limpeza só em fontes `REMOVE_AFTER_PLAYED` | — | **Implantada em 14/11 (`868f3d5`).** Prévia da limpeza homologada no Android em 14/11; ingestão a homologar |
| Reserva configurável por destino (B1) | #460 · #466 #477 | Opt-in por destino (`TargetPlaybackReserveActivation`) | `PLAYBACK_RESERVE_PRODUCT_AUTHORIZATION_MODE` (padrão OFF) | Pilotos Trabalho (13/10) e Avulsa (14/10) homologados, flag devolvida a OFF; generalização e `KEEP_FILLED` pendentes |
| Novidades no Descobrir e por destino (RELEASES-01) | #161 · #548 #549 #556 | Família Novidades no Discovery do destino | `RELEASES_PLANNER_MODE` | Gates 1 e 2 na `main`, radar diário automático |
| Audiolivro como 1º slot de podcast e progresso lido do Spotify | #489 · #544–#547 | Overlay ou caderno manual por destino | `AUDIOBOOK02_*` | D.13/D.14 na `main`; rollout pelos gates da AUDIOBOOK-02 |
| Cooldown factual não degrada ACTIVE para SHADOW | #512 · #513 #514 #515 #519 #530 #531 | — | `MUSIC_REPEAT_LASTFM_MODE`, `MUSIC_REPEAT_CANONICAL_MODE` | Incidente corrigido; consumidor canônico mantido OFF (depende da #374) |

Para declarar paridade de qualquer linha acima, vale a regra da seção 1: um modo configurado não é `EFETIVO` sem `GenerationRun.summary` real por destino e gatilho.

## 4. Lacunas operacionais que impedem concluir Gate A

1. **Banco de produção, agora:** enumerar todos os destinos reais (`enabled`, `compositionMode`, `sequencePattern`, slots/bandas, `updatePolicy`, sources, calendários, Discovery, exclusividade), **sem publicar IDs privados**. Dados da #449 têm data de 10/10, não são prova atual.
2. **Ambiente efetivo:** confirmar, sem divulgar os valores de allowlists ou secrets, master flags e presença de autorizações para MUSIC-07, MUSIC-IDENTITY, Liked, Discovery, Reserva, PODCAST-09 e PODCAST-08. Um modo solicitado não significa `ACTIVE` efetivo.
3. **Run summaries por target × trigger:** medir `MANUAL`, `SCHEDULED`, `SIMULATION` separadamente. `GenerationRun.summary` pode ser agregado; **não atribuir resultado multi-target a target individual**.
4. **Distinção funcional entre N/A, BLOQUEADA e DESLIGADA POR ESCOLHA:** um destino `PROPORTION` não recebe bandas por slot, mas pode ter podcasts; destino inativo continua configurável, porém **a UI pública `/api/generate` não permite simulação de disabled** (#449).
5. **Validação de interface:** verificar controles desktop/mobile, explicação do motivo da indisponibilidade e simulação isolada sem alterações no Spotify. A #448 mantém pendência de largura mobile.
6. **Gates de segurança:** preservar consentimento e data provenance, strict sequence, calendários, `KEEP_FILLED` snapshots, quota, source scope e não introduzir Spotify writes em auditoria.

## 5. Coleta operacional read-only

Script: [`scripts/report-feature-parity-inventory.mjs`](../scripts/report-feature-parity-inventory.mjs), revisado em 14/11/2026.

- Inclui por destino: composição e regeneração por evento, `allowPodcastSnippets`, opt-in da Reserva, audiolivro (overlay ou caderno) e as capacidades derivadas.
- Lê as flags de rollout atuais por **lista explícita** (nunca por prefixo). Dos modos, mostra o valor; das allowlists, só se estão preenchidas.
- Nas execuções recentes, inclui `summary.podcastSnippet` por destino: em modo OFF, é o levantamento de impacto da #559.
- Validado em 14/11 contra um PostgreSQL com todas as migrações e dados de exemplo: sem erro de schema, sem e-mail nem conteúdo de allowlist na saída.

Depois do merge e do deploy, o script está no checkout de produção. No terminal **root** do servidor, rodar como o usuário do site, com o Node 24 do site (nunca o Node do sistema):

```bash
APP=/home/itsoft-sonoriza/htdocs/sonoriza.itsoft.com.br
NODE_BIN=/home/itsoft-sonoriza/.nvm/versions/node/v24.19.0/bin
read -r -p 'E-mail da conta Sonoriza a auditar: ' SONORIZA_AUDIT_EMAIL
REPORT=$(runuser -u itsoft-sonoriza -- mktemp /tmp/sonoriza-feature-parity.XXXXXX.json)
runuser -u itsoft-sonoriza -- env --chdir="$APP" HOME=/home/itsoft-sonoriza \
  PATH="$NODE_BIN:/usr/local/bin:/usr/bin:/bin" SONORIZA_AUDIT_EMAIL="$SONORIZA_AUDIT_EMAIL" \
  "$NODE_BIN/node" --env-file=.env scripts/report-feature-parity-inventory.mjs > "$REPORT"
chmod 600 "$REPORT"; echo "Relatório privado: $REPORT"
```

O script faz apenas `findFirst/findMany`: não chama Spotify, Google nem Last.fm, não gera playlist, não grava no banco e não altera `.env` nem PM2. O JSON contém nomes de playlists: **não colar inteiro em issue ou PR pública.** Para a classificação, basta compartilhar em privado ou resumir sem nomes.

## 6. Próximos critérios verificáveis

- [x] Levantamento do schema, UI, gates e dependências no código.
- [x] Matriz preliminar por capacidade com fotografia histórica identificada.
- [x] Instrumento de coleta somente leitura e sem IDs/allowlists no output preparado.
- [x] Leitura de produção de 13/10 executada (resumo em `FEATURE-PARITY-01-GATE-A-LIVE-SUMMARY.md`).
- [x] Capacidades de novembro mapeadas e script atualizado (14/11).
- [ ] Nova leitura de produção com o script revisado e classificação de cada destino e gatilho.
- [ ] Conferir `effectiveMode` e abstention dos runs recentes por recurso e destino.
- [ ] Homologar e registrar diferenças entre UI e runtime com evidência repetível.
- [ ] Consolidar matriz definitiva `feature × target × trigger × estado` e priorizar Gate B sem ativação massiva.

### Fontes principais

- [Schema `TargetPlaylist`/`GenerationRun`](https://github.com/marksborn/sonoriza/blob/main/prisma/schema.prisma)
- [Tela Configuração → Destinos](https://github.com/marksborn/sonoriza/blob/main/src/app/dashboard/configuracao/destinos/page.tsx)
- [Editor de playlists](https://github.com/marksborn/sonoriza/blob/main/src/components/TargetPlaylistForm.tsx)
- [Discovery: resolução de runtime](https://github.com/marksborn/sonoriza/blob/main/src/services/music-discovery/target-discovery-runtime-policy.ts)
- [Reserva: resolução de runtime](https://github.com/marksborn/sonoriza/blob/main/src/services/playback-reserve-shadow-runtime.ts)
- [PODCAST-09: gate por trigger](https://github.com/marksborn/sonoriza/blob/main/src/jobs/generate-playlists-podcast09.ts)
- [MUSIC-IDENTITY: rollout](https://github.com/marksborn/sonoriza/blob/main/src/jobs/generate-playlists-music-identity.ts)
- [PODCAST-08: editor gateado](https://github.com/marksborn/sonoriza/blob/main/src/components/TargetPlaylistForm.tsx)
- [Fotografia de produção de 10/10/2026](https://github.com/marksborn/sonoriza/issues/449)