# Arquitetura — target usage gating + lease de conteúdo entre destinos

- **Data:** 2026-09-25
- **Status:** proposta técnica para implementação gateada
- **Escopo:** scheduler, uso real de target, exclusividade entre destinos e lifecycle de conteúdo não consumido
- **Issues principais:** #402, #403
- **Relaciona-se a:** #58, #204, #279, #354, #55, #237, #275, #374

## 1. Decisão de produto

O Sonoriza deve separar três perguntas que hoje podem parecer semelhantes, mas possuem semânticas diferentes:

```text
1. COMO atualizar um destino?
   MANUAL | KEEP_FILLED | REBUILD_DAILY

2. QUANDO vale a pena executar a atualização automática?
   ALWAYS | AFTER_TARGET_USE

3. POR QUANTO TEMPO um item não consumido pode monopolizar
   exclusividade em um destino?
   TargetContentAssignment / lease
```

Essas dimensões são complementares e não devem ser fundidas em uma única policy.

Princípios:

```text
playlist não usada
→ não regenerar à toa

conteúdo exclusivo não consumido
→ não ficar preso para sempre

ausência de consumo
→ não significa skip, dislike ou reprodução
```

---

## 2. Motivação

### 2.1 Destinos usados esporadicamente

Uma playlist pode ser preparada e passar vários dias sem ser usada. Regenerar diariamente nesse período:

- desperdiça quota/provider calls;
- roda coleta/planner sem ganho;
- substitui conteúdo que ainda não teve oportunidade de ser ouvido;
- gera histórico operacional pouco útil.

Esse problema é tratado por **SCHEDULE-04 / #402**.

### 2.2 Conteúdo que fica preso por exclusividade

Com TARGET-SCOPE-01 (#204), um destino `EXCLUSIVE` impede que o mesmo conteúdo seja usado simultaneamente em outro destino exclusivo.

Isso é desejável enquanto o item realmente pertence à programação atual. Porém, em playlists parcialmente consumidas, um episódio ou música pode permanecer dias naquele destino sem ser ouvido e bloquear novas oportunidades em outros contextos.

Exemplo real de intenção:

```text
Trabalho
Música → Podcast → Música → Podcast → ...
```

O usuário pode:

- ouvir apenas metade da playlist;
- precisar sair durante o dia;
- não abrir a playlist em determinado dia;
- querer muito ouvir um podcast que ficou preso em uma posição nunca alcançada.

Esse problema é tratado por **TARGET-LEASE-01 / #403**.

---

# Parte A — autoridade de uso do target

## 3. Um único contrato de `TargetUsageEvidence`

SCHEDULE-04, TARGET-LEASE e MUSIC-07 precisam responder variações da mesma pergunta:

> existe evidência positiva de que este destino/sessão foi realmente usado?

Não criar detectores concorrentes.

Definir uma autoridade reutilizável, conceitualmente:

```text
TargetUsageEvidence
  userId
  targetPlaylistId
  observedAt
  source
  confidence / coverage
  evidenceWindow
  generationAnchor?
  details / reason chain
```

A implementação final pode usar outro nome/modelo, mas a semântica deve ser única.

### 3.1 Estados mínimos

```text
USED
NOT_OBSERVED
UNKNOWN
```

- `USED`: há evidência positiva suficiente.
- `NOT_OBSERVED`: não há evidência positiva dentro do universo observado; não significa certeza de não uso.
- `UNKNOWN`: a checagem não pode ser concluída com confiança, por falha, cobertura insuficiente ou fonte indisponível.

Nunca colapsar `UNKNOWN` em `NOT_OBSERVED`.

### 3.2 Fontes de evidência

Priorizar fontes permitidas e auditáveis já existentes no Sonoriza, como:

- estado first-party quando disponível;
- Last.fm/scrobble reconciliado;
- estado factual de podcast quando compatível;
- outra evidência positiva explicitamente validada nos gates.

Não usar simples ausência de evento Spotify como prova de não uso.

---

## 4. Anchor temporal

Toda decisão precisa de um anchor claro.

### Scheduler

Pergunta:

```text
houve uso depois da última geração aplicada?
```

Anchor:

```text
lastAppliedGenerationAt
```

### Lease de conteúdo

Pergunta:

```text
quantas oportunidades de uso este item teve desde que foi atribuído?
```

Anchor:

```text
firstAssignedAt
```

ou uma contagem equivalente de janelas de uso válidas.

Não reutilizar o mesmo timestamp para semânticas diferentes.

---

# Parte B — SCHEDULE-04

## 5. Separação entre `updatePolicy` e `updateCondition`

Contrato desejado:

```text
updatePolicy
  MANUAL
  KEEP_FILLED
  REBUILD_DAILY

updateCondition
  ALWAYS
  AFTER_TARGET_USE
```

`updatePolicy` responde **como** atualizar.

`updateCondition` responde **quando o scheduler pode iniciar uma atualização automática**.

### 5.1 Combinações

```text
REBUILD_DAILY + ALWAYS
→ comportamento atual: rebuild no horário programado

REBUILD_DAILY + AFTER_TARGET_USE
→ rebuild no horário somente se houve uso posterior à última geração aplicada

KEEP_FILLED + AFTER_TARGET_USE
→ manutenção incremental somente depois de uso confirmado
```

Geração manual explícita não deve ser bloqueada por `AFTER_TARGET_USE`.

---

## 6. Ordem de execução do scheduler

Direção recomendada:

```text
scheduler due
   ↓
configuração válida / target ativo
   ↓
resolver updateCondition
   ↓
ALWAYS ──────────────┐
                     ├─→ avaliar calendário/duração
AFTER_TARGET_USE      │
   ↓                  │
TargetUsageEvidence   │
   ↓                  │
USED ─────────────────┘
NOT_OBSERVED → NOOP
UNKNOWN → decisão conservadora/fail-closed definida em gate
   ↓
coleta de fontes
   ↓
planner
   ↓
write
```

A checagem de uso deve acontecer **antes de qualquer coleta cara**.

---

## 7. NOOP auditável

Quando a condição não libera o run:

```text
conditionDecision = NOOP
reason = NO_PLAYBACK_SINCE_LAST_APPLIED_GENERATION
```

O NOOP deve evitar:

- leitura pesada de fontes;
- planner completo;
- write Spotify;
- alteração de geração aplicada.

Registrar pelo menos:

```text
updateCondition
lastAppliedGenerationAt
lastConfirmedTargetUseAt
targetUsageEvidenceStatus
conditionDecision
conditionReason
```

---

# Parte C — TARGET-LEASE-01

## 8. Exclusividade como lease, não posse permanente

Princípio:

```text
EXCLUSIVE != reservado para sempre
```

A exclusividade continua significando:

> o mesmo conteúdo não pode coexistir simultaneamente em dois destinos incompatíveis.

Porém a atribuição de um item a um target passa a possuir lifecycle operacional.

---

## 9. Unidade de exclusividade

### Música

A direção arquitetural de #374 é usar `SongIdentity` para TARGET-SCOPE sharing/exclusivity.

Enquanto essa migração não estiver ativa, a implementação pode precisar conviver com a reserva operacional legada por URI/provider ref, sem mudar silenciosamente a semântica.

### Podcast

A unidade de exclusividade é o **episódio**, não o show inteiro.

Portanto:

```text
Show A / episódio 10 em Trabalho
Show A / episódio 11 em Carro
```

pode ser semanticamente permitido, desde que cadência/caps/policies do show também permitam.

Cadência por show continua responsabilidade de #237/#275.

---

## 10. Lifecycle do assignment

Modelo conceitual:

```text
candidato global
    ↓
ASSIGNED(target A)
    ↓
consumido? ── sim → lifecycle factual normal
    │
    não
    ↓
lease expirou?
    │
    não → ACTIVE
    │
    sim
    ↓
EXPIRED
    ↓
RELEASE_PENDING
    ↓
write certificado remove/não preserva em A
    ↓
RELEASED
    ↓
volta ao pool global
```

Possível persistência:

```text
TargetContentAssignment
  userId
  targetPlaylistId
  canonicalContentId
  contentType = MUSIC | PODCAST_EPISODE
  firstAssignedAt
  lastAssignedAt
  assignmentGenerationRunId
  planRole = PRIMARY | RESERVE
  status = ACTIVE | EXPIRED | RELEASE_PENDING | RELEASED | CONSUMED
  usageOpportunityCount
  expiredAt?
  releasedAt?
  releaseReason?
  sameTargetEligibleAfter?
```

O schema final deve ser decidido somente depois do inventário Gate 1.

---

## 11. Expiração não é consumo

`UNCONSUMED_ASSIGNMENT_EXPIRED` é um estado operacional, não comportamental.

Não alterar por causa da expiração:

```text
lastPlayedAt
playCount
EpisodeListeningState = COMPLETED
INFERRED_SKIP
USER_EXCLUDED
MUSIC-07 cooldown
```

A provenance precisa registrar explicitamente:

```text
releaseReason = UNCONSUMED_ASSIGNMENT_EXPIRED
```

---

## 12. Relógios possíveis para expiração

Comparar em shadow duas semânticas.

### 12.1 `CALENDAR_DAYS`

Conta dias civis desde a atribuição.

Exemplo:

```text
segunda: podcast entrou em Trabalho
quinta: 3 dias passaram
→ lease potencialmente expirável
```

Vantagem: simples.

Risco: penaliza conteúdo mesmo quando o target não teve nenhuma oportunidade real de uso.

### 12.2 `TARGET_USAGE_DAYS`

Conta apenas dias/janelas em que houve `TargetUsageEvidence = USED`.

Exemplo:

```text
segunda: atribuído + Trabalho usado
terça: Trabalho não usado
quarta: Trabalho usado
quinta: Trabalho não usado
sexta: Trabalho usado

→ 3 oportunidades reais
```

Esse relógio representa melhor a intenção do produto para playlists contextuais.

### 12.3 Decisão de rollout

Não definir default numérico nem relógio produtivo antes do relatório shadow.

Medir em dados reais:

```text
calendarAgeDays
usageOpportunityDays
```

para Trabalho, Carro, Academia, Avulsa e outros targets relevantes.

---

## 13. Proteção contra recaptura imediata

Sem proteção adicional, este fluxo seria possível:

```text
Trabalho libera Podcast X
   ↓
planner roda Trabalho novamente
   ↓
Trabalho seleciona Podcast X de novo
```

Isso anularia a feature.

Definir um mecanismo equivalente a:

```text
sameTargetEligibleAfter
```

ou:

```text
sameTargetRetryDelay
```

Durante a janela:

- outros destinos compatíveis podem selecionar o item;
- o destino anterior não o recaptura;
- não existe penalidade global;
- após a janela, o conteúdo pode voltar ao destino original se continuar elegível.

O valor deve ser calibrado em shadow.

---

## 14. Não quebrar `EXCLUSIVE` fisicamente

Regra crítica:

> um item não está livre enquanto ainda está fisicamente presente/reservado no destino antigo.

Portanto:

```text
EXPIRED
!=
RELEASED
```

### EXPIRED

O lease venceu semanticamente.

### RELEASE_PENDING

A próxima manutenção deve remover/não preservar o item, mas o write ainda não foi certificado.

### RELEASED

O estado remoto foi atualizado e a reserva antiga deixou de existir.

Somente `RELEASED` permite que outro destino `EXCLUSIVE` publique o item sem conflito.

---

## 15. Reassignment multi-target

### Execução isolada de B

Se A ainda contém X:

```text
A: X presente
B: tentando selecionar X
```

A external reservation continua bloqueando B.

### Execução coordenada A + B

Pode existir transferência planejada:

```text
A: remove/não preserva X
B: seleciona X
```

mas somente com snapshot/write guards que garantam consistência e evitem janela silenciosa de duplicidade.

Essa otimização deve ser gate posterior.

---

# Parte D — interação entre as features

## 16. SCHEDULE-04 x TARGET-LEASE

As duas features não podem se contradizer.

Exemplo:

```text
SCHEDULE-04:
Trabalho não foi usado desde a última geração
→ NOOP

TARGET-LEASE:
Podcast X atingiu threshold de lease
→ EXPIRED
```

Resultado correto:

```text
Podcast X = EXPIRED / RELEASE_PENDING
mas continua reservado enquanto o target não puder ser mantido/escrito
```

TARGET-LEASE não deve executar uma mutação escondida dentro de um NOOP do scheduler.

---

## 17. MUSIC-07 x TARGET-LEASE

MUSIC-07 responde:

> a faixa teve exposições válidas repetidas sem confirmação e precisa de cooldown operacional?

TARGET-LEASE responde:

> este item pode continuar monopolizando exclusividade neste destino?

Portanto:

```text
lease expirado
→ não cria TrackExposure
→ não cria cooldown
→ não cria dislike
→ não cria skip
```

Ambas podem consumir `TargetUsageEvidence`, mas seus estados e efeitos permanecem separados.

---

## 18. PLAYBACK-RESERVE x TARGET-LEASE

`PRIMARY` e `RESERVE` não possuem a mesma oportunidade de consumo.

Um item em `RESERVE` pode nunca ter sido alcançado.

Portanto Gate 1 precisa medir separadamente:

```text
assignment.planRole = PRIMARY
assignment.planRole = RESERVE
```

Não assumir o mesmo threshold para os dois sem evidência.

Possível direção futura:

- PRIMARY usa `TARGET_USAGE_DAYS` normal;
- RESERVE exige evidência de alcance ou threshold diferente.

Não fixar essa regra antes do relatório real.

---

## 19. Podcast state x TARGET-LEASE

Primeiro contrato seguro:

```text
NOT_STARTED + lease expirado
→ candidato a release

IN_PROGRESS
→ não liberar automaticamente pela policy v1

COMPLETED
→ lifecycle factual normal, não lease unconsumed
```

Isso preserva continuidade de episódios já iniciados.

Publicação ou expiração do assignment também não consome cadência do show.

---

# Parte E — UX e diagnóstico

## 20. UI — atualização automática

```text
Atualização automática
Refazer diariamente

Quando atualizar?
(●) Sempre no horário programado
( ) Somente depois que esta playlist tiver sido usada
```

Texto de apoio:

> Se a playlist não for usada, o Sonoriza mantém o conteúdo atual e evita uma nova geração desnecessária.

Diagnóstico:

```text
Última geração: 25/09 07:00
Último uso confirmado: 25/09 09:12
Execução de 26/09: nenhuma alteração
Motivo: playlist ainda não foi usada desde a última atualização
```

---

## 21. UI — conteúdo não consumido

```text
Conteúdo não consumido

[x] Liberar conteúdo que ficou tempo demais nesta playlist sem ser ouvido

Após: [ 3 ] [ dias de uso da playlist ]

Depois de liberar:
Evitar voltar para esta mesma playlist por [ 7 ] dias
```

Texto de apoio:

> O conteúdo volta a ficar disponível para outras playlists. Isso não significa que você pulou ou não gostou dele.

Diagnóstico por item:

```text
Podcast X
Trabalho · reservado há 5 dias
3 oportunidades de uso sem consumo
Estado: lease expirado
Ação: liberar na próxima atualização permitida
```

---

# Parte F — observabilidade

## 22. Métricas de scheduler

```text
updateCondition
lastAppliedGenerationAt
lastConfirmedTargetUseAt
targetUsageEvidenceStatus
conditionDecision
conditionReason
providerCallsAvoided
```

## 23. Métricas de assignment

```text
activeAssignmentCount
expiredAssignmentCount
releasePendingCount
releasedUnconsumedCount
reassignedToOtherTargetCount
sameTargetRecaptureBlockedCount
assignmentAgeDays
assignmentUsageOpportunityDays
releaseReason
previousTargetId
newTargetId?
planRole
```

## 24. Perguntas que o diagnóstico deve responder

- por que este target não foi atualizado hoje?
- qual evidência de uso liberou a próxima execução?
- há quanto tempo este item está atribuído ao target?
- quantas oportunidades reais de uso ele teve?
- ele foi ouvido ou apenas liberado?
- por que ainda está bloqueando outro destino?
- quando poderá ser selecionado novamente pelo target original?
- para qual destino foi redistribuído depois?

---

# Parte G — gateamento

## 25. Gate 1 — inventário read-only compartilhado

Antes de schema/runtime:

- localizar última geração aplicada por target;
- mapear evidências atuais de uso real;
- mapear contratos de MUSIC-07 para playlist/session used;
- reconstruir assignments atuais por target;
- cruzar GenerationRun/GenerationItem com estado remoto conhecido;
- separar música/podcast;
- separar PRIMARY/RESERVE quando disponível;
- cruzar podcast factual `NOT_STARTED/IN_PROGRESS/COMPLETED`;
- medir idade civil e oportunidades de uso;
- identificar conteúdo atualmente preso por exclusividade;
- medir custo de uma checagem barata de `TargetUsageEvidence`.

Nenhuma influência produtiva.

## 26. Gate 2 — shadow de TargetUsageEvidence

Produzir, por target/janela:

```text
USED
NOT_OBSERVED
UNKNOWN
```

Comparar fontes/evidências e cobertura sem mudar scheduler, planner ou writes.

## 27. Gate 3 — shadow de scheduler

Para cada slot agendado:

```text
WOULD_RUN
WOULD_NOOP
UNKNOWN
```

Medir chamadas pesadas que poderiam ser evitadas.

## 28. Gate 4 — shadow de lease

Para cada assignment:

```text
WOULD_KEEP
WOULD_EXPIRE_CALENDAR
WOULD_EXPIRE_USAGE
BLOCKED_BY_IN_PROGRESS
BLOCKED_BY_PLAN_ROLE
BLOCKED_BY_INSUFFICIENT_EVIDENCE
```

Comparar thresholds sem mutação.

## 29. Gate 5 — persistência/configuração

Adicionar contratos backward-compatible:

```text
updateCondition default ALWAYS
assignment lifecycle sem influência produtiva
```

Nenhum target existente muda de comportamento automaticamente.

## 30. Gate 6 — SCHEDULE-04 canary

Ativar `AFTER_TARGET_USE` para target allowlisted.

Provar:

- NOOP barato;
- nenhuma coleta pesada em NOOP;
- uso posterior libera run;
- geração manual continua funcionando;
- nenhuma perda de diagnóstico.

## 31. Gate 7 — TARGET-LEASE REBUILD_DAILY canary

Primeiro target sugerido para avaliação: `Trabalho`, por representar o cenário real que motivou a feature.

Antes da ativação, simulação aprovada.

Provar:

- assignment expira sem falsificar playback;
- não é reselecionado imediatamente no mesmo target;
- remoção é certificada antes de virar `RELEASED`;
- outro destino pode selecionar depois;
- `EXCLUSIVE` nunca é violado.

## 32. Gate 8 — KEEP_FILLED

Adicionar lease expirado como nova razão de não preservação:

```text
CONSUMED
INVALID
UNCONSUMED_ASSIGNMENT_EXPIRED
```

Sem confundir remoção operacional com consumo.

## 33. Gate 9 — reassignment coordenado

Somente depois dos estados básicos validados, permitir transferência A → B no mesmo ciclo de planejamento, com guards transacionais/snapshot adequados.

## 34. Gate 10 — UI

Expor configuração, estado e explicação das decisões sem enums internos.

---

# Parte H — regressões obrigatórias

## 35. Scheduler

1. `ALWAYS` preserva o comportamento atual;
2. `AFTER_TARGET_USE` sem uso confirmado não inicia planner pesado;
3. uso posterior à última geração libera o próximo run;
4. uso anterior à geração não libera;
5. simulação não conta como geração aplicada;
6. publicação não conta automaticamente como uso;
7. geração manual explícita não é bloqueada;
8. `UNKNOWN` permanece distinto de `NOT_OBSERVED`;
9. `emptyCalendarBehavior` continua separado;
10. KEEP_FILLED/REBUILD_DAILY preservam sua semântica quando o run é liberado.

## 36. Lease

1. assignment novo permanece ACTIVE;
2. `NOT_STARTED` pode expirar conforme policy;
3. `IN_PROGRESS` não é liberado automaticamente no v1;
4. `COMPLETED` não é classificado como unconsumed expired;
5. expiração não cria playback;
6. expiração não cria skip/dislike;
7. expiração não cria MUSIC-07 cooldown;
8. EXPIRED ainda bloqueia sharing enquanto estiver fisicamente presente;
9. somente RELEASED libera para outro target EXCLUSIVE;
10. mesmo target não recaptura imediatamente após release;
11. outro target compatível pode selecionar depois do release;
12. episódio diferente do mesmo show continua sendo item distinto;
13. planRole PRIMARY/RESERVE permanece auditável;
14. execução isolada de B não ignora reserva ainda presente em A;
15. reassignment coordenado nunca produz duplicidade remota proibida.

## 37. Integração

1. NOOP de SCHEDULE-04 não executa release escondido;
2. lease pode ficar EXPIRED/RELEASE_PENDING durante NOOP;
3. TargetUsageEvidence é compartilhado, não duplicado;
4. estados de scheduler, exposure e lease permanecem semanticamente separados;
5. ausência de scrobble nunca vira preferência negativa;
6. nenhum novo mecanismo falsifica fatos de playback;
7. defaults existentes permanecem backward-compatible.

---

# Parte I — critérios de aceite arquiteturais

## 38. Aceite

- [ ] `updatePolicy` e `updateCondition` são dimensões separadas;
- [ ] `AFTER_TARGET_USE` usa evidência positiva e reutilizável;
- [ ] existe um contrato único de `TargetUsageEvidence` ou equivalente;
- [ ] target não usado pode gerar NOOP barato;
- [ ] exclusividade não implica posse indefinida do conteúdo;
- [ ] assignment de item possui lifecycle auditável;
- [ ] expiração não é consumo nem preferência negativa;
- [ ] música e podcast usam unidades de exclusividade corretas;
- [ ] podcast usa episódio como unidade, não show inteiro;
- [ ] `TARGET_USAGE_DAYS` e `CALENDAR_DAYS` podem ser comparados em shadow;
- [ ] não existe recaptura imediata pelo mesmo target após release;
- [ ] EXPIRED/RELEASE_PENDING não são tratados como RELEASED;
- [ ] RELEASED só ocorre após mudança remota certificada;
- [ ] TARGET-SCOPE `EXCLUSIVE` nunca é relaxado silenciosamente;
- [ ] PRIMARY/RESERVE permanecem distinguíveis;
- [ ] `IN_PROGRESS` possui proteção de continuidade;
- [ ] observabilidade explica todas as decisões;
- [ ] implementação começa read-only/shadow;
- [ ] merge, deploy e ativação produtiva continuam checkpoints separados.

---

## 39. Não objetivos iniciais

- monitorar player em tempo real;
- regenerar imediatamente ao primeiro playback;
- inferir dislike por ausência de consumo;
- transformar lease expirado em skip;
- liberar episódio `IN_PROGRESS` automaticamente;
- permitir duplicidade temporária entre destinos EXCLUSIVE;
- recaptura dinâmica em tempo real durante playback;
- escolher thresholds automaticamente por IA;
- migrar toda identidade de TARGET-SCOPE junto desta feature;
- alterar política de cadência de podcast;
- ativar qualquer mudança produtiva apenas pela existência deste documento.

---

## 40. Resumo operacional

A arquitetura desejada pode ser resumida assim:

```text
TARGET
  scheduler chega no horário
        ↓
  houve uso desde a última geração?
        ├─ não → NOOP
        └─ sim → updatePolicy normal

ITEM EXCLUSIVE
  entra num target
        ↓
  fica reservado
        ↓
  foi consumido?
        ├─ sim → lifecycle factual
        └─ não
             ↓
       teve oportunidades suficientes?
        ├─ não → continua reservado
        └─ sim → EXPIRED
                    ↓
             próxima manutenção
                    ↓
              RELEASE_PENDING
                    ↓
               write seguro
                    ↓
                RELEASED
                    ↓
          volta ao pool global
```

O resultado esperado é um Sonoriza que evita trabalho desnecessário quando uma playlist não foi usada e, ao mesmo tempo, evita que conteúdo desejado fique indefinidamente preso em um único contexto apenas por causa da exclusividade.