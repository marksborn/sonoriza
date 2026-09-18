# Arquitetura — identidade musical canônica + Discovery Inbox

- **Data:** 2026-09-18
- **Status:** proposta técnica para implementação gateada
- **Escopo:** música, descoberta, fontes, planner e destinos
- **Relaciona-se a:** #37, #102, #103, #159, #165, #186, #200, #204, #207, #278, #319, #354

## 1. Decisão de produto

O Sonoriza deve evoluir em duas direções complementares:

1. **identidade musical canônica transversal** — o core deixa de tratar Spotify Track/Artist/Album IDs como identidade de negócio;
2. **Discovery como domínio próprio** — uma inbox automática, separada das fontes normais e da inbox manual `Escutar`, alimentada por estratégias e providers intercambiáveis.

Princípio:

```text
provider ID = referência operacional/evidência
identidade Sonoriza = entidade de domínio
```

E:

```text
Escutar   = "eu quero ouvir isso"
Discovery = "o Sonoriza acha que vale a pena eu ouvir isso"
```

Discovery não deve precisar materializar seus candidatos em `Escutar` para participar do planner.

---

## 2. Objetivos

Esta arquitetura precisa permitir, progressivamente:

- reconciliar a mesma música entre providers, releases, remasters e relinking;
- preservar diferenças reais de gravação, como studio, live, acústico, remix ou demo;
- evitar duplicidade sem depender de um Spotify ID específico;
- aplicar cooldown, exclusão explícita, exposição, skip, diversidade e source scope sobre identidade canônica;
- manter `Escutar` como inbox manual;
- criar `Discovery Inbox` automática com estoque controlado e refill;
- usar Last.fm como primeiro `DiscoveryProvider`, sem acoplá-lo ao domínio;
- configurar por destino **quanto Discovery pode participar** sem expor porcentagens rígidas;
- configurar por destino **quais estratégias de Discovery fazem sentido**;
- manter fontes normais no pool existente;
- integrar álbum completo como unidade de planejamento sem desmontar sua integridade;
- preservar provenance, explicabilidade, simulação e guards pré-write já existentes.

---

## 3. Não objetivos iniciais

- substituir Spotify como provider de playback atual;
- fundir músicas apenas por strings parecidas;
- criar reconhecimento acústico/fingerprint de áudio no primeiro gate;
- identificar composição/autoria musical universal entre covers de artistas diferentes;
- forçar quotas de Discovery;
- reescrever de uma vez todos os modelos existentes;
- apagar histórico ou referências Spotify legadas durante a migração;
- usar IA como requisito para reconciliação ou seleção.

---

# Parte A — Identidade musical canônica

## 4. Hierarquia de identidade

### 4.1 ArtistIdentity

Representa a entidade artista/banda dentro do Sonoriza.

```text
ArtistIdentity
  id
  canonicalName
  aliases/evidence
  status/confidence metadata
```

IDs externos ficam em referências separadas:

```text
ArtistProviderRef
  artistIdentityId
  provider
  providerArtistId
  market/context?
  evidence
```

Não usar nome textual como chave forte.

---

### 4.2 SongIdentity

Representa a música no sentido útil ao Sonoriza para dedupe e intenção de escuta.

No v1, `SongIdentity` **não deve tentar ser uma entidade universal de composição/autoria**. A identidade precisa ser conservadora e normalmente permanecer vinculada ao artista/intérprete canônico.

Exemplo:

```text
Metallica — Nothing Else Matters
```

Pode agrupar versões relacionadas da própria banda, mas um cover por outro artista não deve ser fundido automaticamente apenas porque título/composição parecem iguais.

---

### 4.3 RecordingIdentity

Representa uma gravação/interpretação concreta da `SongIdentity`.

Exemplo:

```text
SongIdentity: Foo — Song X

Recording A: STUDIO
Recording B: LIVE
Recording C: ACOUSTIC
Recording D: REMIX
```

Uma remasterização que usa o mesmo master/performance de estúdio pode apontar para a mesma `RecordingIdentity` quando houver confiança suficiente.

Live, acústico, demo e remix normalmente permanecem gravações diferentes, ainda que relacionadas à mesma `SongIdentity`.

---

### 4.4 AlbumIdentity e AlbumReleaseIdentity

Separar o conceito de álbum da edição específica.

```text
AlbumIdentity
  "o álbum"

AlbumReleaseIdentity
  edição original
  deluxe
  remaster 2011
  expanded edition
  provider/market release
```

Isso permite duas semânticas diferentes:

- diversidade pode, quando configurado, contar por `AlbumIdentity`;
- reprodução de álbum completo precisa preservar uma `AlbumReleaseIdentity` concreta e sua tracklist/ordem.

Não fundir releases automaticamente sem evidência suficiente.

---

### 4.5 Provider refs

Toda representação externa deve ser referência, não identidade central:

```text
TrackProviderRef
  recordingIdentityId
  provider
  providerTrackId
  uri
  isrc?
  market?
  albumReleaseIdentityId?
  playable/status
  observedAt
```

Possíveis evidências adicionais:

- ISRC;
- MBID;
- Last.fm artist/title;
- provider artist/album IDs;
- duração;
- disc/track number;
- classificações de versão de #200;
- relinking/provider aliases.

---

## 5. Resolver de identidade

A reconciliação deve ser **evidence-based e conservadora**.

Pipeline conceitual:

```text
entrada externa
  ↓
normalização textual não destrutiva
  ↓
evidências fortes
  ↓
evidências auxiliares
  ↓
matching + confidence
  ↓
MATCH / NEW / AMBIGUOUS / REJECTED
```

Evidências possíveis:

```text
provider ID já conhecido
ISRC
MBID
artist identity
base title
version classification
album/release
track duration
track/disc number
collaborators
```

Não implementar regra equivalente a:

```text
remove "(Live)"
remove "Remaster"
=> mesma música
```

A normalização textual serve para produzir sinais, não para declarar equivalência sozinha.

### Confiança

Persistir motivo/confiança da reconciliação.

Exemplo conceitual:

```text
EXACT_PROVIDER_ALIAS
SAME_ISRC
SAME_RECORDING_HIGH_CONFIDENCE
SAME_SONG_DIFFERENT_RECORDING
TEXTUAL_POSSIBLE_MATCH
AMBIGUOUS
```

Matching abaixo do limiar seguro deve permanecer separado e auditável.

---

## 6. Qual nível usar em cada regra

A identidade canônica só é útil se cada regra declarar sua semântica.

Direção inicial:

| Regra | Nível preferido |
|---|---|
| não duplicar `Escutar` x Discovery | `SongIdentity` |
| cooldown factual | `RecordingIdentity`, com política explícita de equivalência quando remaster compartilhar a mesma gravação |
| `USER_EXCLUDED` | `SongIdentity` ou `RecordingIdentity` conforme ação do usuário; v1 pode manter gravação e oferecer evolução para música inteira |
| MUSIC-07 exposure | `RecordingIdentity` |
| diversidade por artista | `ArtistIdentity` |
| diversidade por álbum | `AlbumIdentity` por padrão; release quando necessário |
| exclusividade entre destinos | `SongIdentity` para música; provider ref apenas na borda de execução |
| playback/write | `TrackProviderRef` reproduzível no provider do destino |
| álbum completo | `AlbumReleaseIdentity` + sequência concreta |

A implementação não deve escolher o nível implicitamente. Cada consumer precisa declarar qual identidade usa.

---

## 7. Migração transversal

Os IDs Spotify atuais continuam existindo durante a transição.

Estratégia:

```text
legado Spotify ID
   ↓ shadow resolve
canonical identity
   ↓ comparar decisões
   ↓ ativar consumer por consumer
```

Não fazer big-bang migration.

Consumers prioritários para migração:

1. dedupe;
2. cooldown/recency;
3. `USER_EXCLUDED`;
4. MUSIC-04 artista/álbum;
5. TARGET-SCOPE exclusividade;
6. MUSIC-07 exposure;
7. Discovery;
8. ALBUM-01 / blocos de álbum;
9. métricas e histórico.

# Parte B — Discovery como domínio próprio

## 8. Discovery Inbox

Criar uma inbox automática gerenciada pelo Sonoriza.

```text
Discovery Inbox
  targetSize
  lowWatermark
  items[]
```

Exemplo inicial calibrável:

```text
targetSize = 30
lowWatermark = 10
```

Quando o estoque cai abaixo do low watermark, o Sonoriza adquire/resgata candidatos e repõe até o target.

Não fazer refill item a item após cada consumo.

---

## 9. Estado de um DiscoveryItem

Direção conceitual:

```text
DiscoveryItem
  id
  userId
  unitType = TRACK | ALBUM
  songIdentityId? / albumIdentityId?
  recordingIdentityId? / albumReleaseIdentityId?
  provider
  strategy
  status
  discoveredAt
  exposedAt?
  heardAt?
  dismissedAt?
  cooldownUntil?
  reasons[]
  provenance
```

Estados possíveis:

```text
PENDING
EXPOSED
HEARD
DISMISSED
SUPPRESSED
EXPIRED
```

Não apagar imediatamente o histórico do item ao ouvi-lo; manter memória para conversão e anti-loop.

---

## 10. Consumo da inbox

Um item sai da inbox ativa quando houver evidência suficiente de consumo real.

Fontes permitidas seguem #278. No desenho atual, Last.fm e estado first-party adequado são as principais evidências comportamentais.

Não considerar:

```text
entrou na playlist = foi ouvido
```

Nem:

```text
não apareceu no histórico = foi pulado
```

sem coverage/contrato válido.

---

## 11. `Escutar` x `Discovery`

Regra canônica:

```text
ESCUTAR > DISCOVERY
```

- `Escutar` é intenção humana/manual;
- `Discovery` é intenção algorítmica;
- Discovery não alimenta `Escutar` automaticamente;
- se uma `SongIdentity` já está ativa em `Escutar`, Discovery deve suprimir o item;
- se o usuário adiciona manualmente ao `Escutar` algo que estava em Discovery, a autoridade passa para `Escutar`.

Reasons esperadas:

```text
ALREADY_IN_MANUAL_INBOX
PROMOTED_TO_MANUAL_INBOX
DUPLICATE_DISCOVERY_IDENTITY
```

A regra usa identidade canônica, não provider track ID.

---

## 12. Providers de Discovery

Discovery não deve ser sinônimo de Last.fm.

Contrato conceitual:

```text
DiscoveryProvider
  acquireCandidates(context, strategy, budget)
```

Primeiro provider:

```text
LASTFM
```

Futuros providers podem ser adicionados sem mudar inbox/planner.

Separar capacidades:

```text
DiscoveryProvider
CatalogProvider
IdentityProvider
ListeningProvider
PlaybackProvider
```

Um mesmo serviço pode implementar mais de uma capacidade.

---

## 13. Estratégias de Discovery

V1 desejado:

```text
REDISCOVERY
DEEPENING
NEW_ARTIST
GENRE_EXPANSION
WILDCARD
NEW_RELEASE
```

### REDISCOVERY
Conteúdo com afinidade histórica relevante e ausência prolongada.

### DEEPENING
Faixa pouco/nunca ouvida de artista já conhecido/afim; também pode produzir unidade de álbum via ALBUM-01.

### NEW_ARTIST
Artista ainda não conhecido ou pouco conhecido, com boa afinidade provável.

### GENRE_EXPANSION
Exploração adjacente a estilos/tags/corredores já observados, sem exigir que o usuário configure gêneros manualmente.

### WILDCARD
Exploração deliberadamente mais distante da bolha, porém com ponte/evidência explicável. Não é puro aleatório.

### NEW_RELEASE
Evento de lançamento relevante. Deve considerar afinidade/momentum do artista e não depender de quota fixa.

`FAMILIAR` permanece uma classificação importante do perfil musical, mas não precisa ser tratada como estratégia de Discovery Inbox. Fontes normais já carregam repertório familiar.

---

## 14. Mixer interno de Discovery

As estratégias usam **pesos**, não quotas obrigatórias.

Exemplo inicial apenas para calibração:

```text
DEEPENING        25
NEW_ARTIST       25
REDISCOVERY      20
GENRE_EXPANSION  20
WILDCARD         10
```

`NEW_RELEASE` funciona como evento/budget separado, não precisa consumir um percentual fixo desse mix.

Se uma estratégia não tiver candidatos bons, redistribuir budget conforme política; nunca promover candidato fraco somente para bater uma porcentagem.

---

## 15. Refill

Fluxo:

```text
Discovery Inbox < lowWatermark
        ↓
DiscoveryRefill
        ↓
calcular vagas
        ↓
Mixer escolhe budgets por estratégia
        ↓
Providers adquirem candidatos
        ↓
Identity Resolver
        ↓
Catalog Resolver / playability
        ↓
Eligibility global
        ↓
dedupe Escutar/Discovery/histórico
        ↓
Inbox até targetSize
```

O refill precisa ser idempotente e auditável.

---

## 16. Last.fm v1

Usar dados já permitidos/previstos em #103 e #278:

- histórico/top artists/top tracks;
- similar artists;
- similar tracks;
- tags como sinal auxiliar;
- scrobbles para consumo/conversão;
- séries temporais já calculáveis localmente quando possível.

Last.fm entrega **candidatos e sinais**, não a identidade final de playback.

Depois de adquirir `artist + track`, resolver contra identidade Sonoriza e, quando necessário para Spotify, contra catálogo Spotify.

---

# Parte C — Destinos e planner

## 17. Fontes normais continuam no pool existente

TARGET-SCOPE-01 #204 continua sendo autoridade sobre fontes normais permitidas por destino:

```text
INHERIT_GLOBAL
SELECTED_ONLY
```

Fontes normais habilitadas entram no pool comum do destino.

Não criar percentuais por `SourcePlaylist` no v1.

Exemplos de fontes normais:

- Escutar;
- Só Covers;
- Músicas Curtidas;
- playlists-fonte adicionais.

Discovery não precisa virar uma `SourcePlaylist` falsa para participar.

---

## 18. Intensidade por destino

O usuário configura **graus**, não porcentagens.

```text
OFF
LIGHT
MODERATE
HIGH
INTENSE
```

UX conceitual:

```text
Quanto espaço dar para descobertas?

Desligado
Leve
Moderado
Alto
Intenso
```

Princípio:

```text
intensity = ceiling/budget
intensity != target quota
```

Mapeamento técnico inicial, calibrável e não contratual:

```text
OFF       0%
LIGHT    ~10%
MODERATE ~25%
HIGH     ~40%
INTENSE  ~60%
```

Esses valores não precisam aparecer na UI e podem mudar após observação real.

O ceiling deve ser calculado sobre a **porção MUSIC do plano final**, não sobre podcasts.

Nunca force-fill Discovery para atingir o ceiling.

---

## 19. Estratégias permitidas por destino

Intensidade responde **quanto**; o conjunto de estratégias responde **que tipo**.

Exemplo de policy:

```text
TargetDiscoveryPolicy
  intensity
  allowedStrategies[]
  albumMode
```

O planner só pode usar DiscoveryItem cuja estratégia esteja autorizada naquele destino.

---

## 20. Perfis de contexto para validação

Não hardcodar estes defaults globalmente; usá-los como cenário real de aceite/piloto.

### Carro

Intenção: repertório familiar, baixo esforço cognitivo.

Direção:

```text
intensity = LIGHT
REDISCOVERY = on
DEEPENING = opcional/conservador
NEW_ARTIST = off
GENRE_EXPANSION = off
WILDCARD = off
NEW_RELEASE = apenas alta afinidade
```

### Trabalho

Intenção: contexto exploratório; fácil abrir artista, curtir música ou investigar álbum.

Direção:

```text
intensity = HIGH
REDISCOVERY = on
DEEPENING = on
NEW_ARTIST = on
GENRE_EXPANSION = on
WILDCARD = on
NEW_RELEASE = on
```

### Academia

Intenção: exploração moderada com preferência por álbum completo.

Direção:

```text
intensity = MODERATE
albumMode = PREFER
REDISCOVERY = on
DEEPENING = on
NEW_ARTIST = on
NEW_RELEASE = on
```

---

## 21. Álbum completo como unidade

A arquitetura deve aceitar:

```text
DiscoveryUnit = TRACK | ALBUM
```

Mas a ativação de `ALBUM` no planner deve ser gateada separadamente e reutilizar ALBUM-01 #102.

Modos por destino:

```text
OFF
WHEN_RECOMMENDED
PREFER
```

Quando um álbum entra como bloco:

- preservar `AlbumReleaseIdentity` concreta;
- preservar `disc_number + track_number`;
- não espalhar as faixas arbitrariamente;
- não tratar as faixas como N descobertas independentes para explicação;
- todas as faixas continuam sujeitas a `USER_EXCLUDED` e indisponibilidade;
- integridade/cooldown segue o contrato especializado de ALBUM-01.

A participação no ceiling de Discovery deve ser auditável. Em v1, todas as faixas efetivamente publicadas do bloco contam como conteúdo Discovery da porção MUSIC.

Se o bloco ultrapassar o budget permitido, o planner deve abster ou usar policy explícita futura; não quebrar silenciosamente o álbum em faixas avulsas.

---

## 22. Candidate Universe

Direção final:

```text
Fontes normais ─────┐
                    │
Discovery Inbox ────┼──→ Candidate Universe
                    │
Album Units ────────┘
          ↓
canonical identity
          ↓
eligibility
          ↓
cooldown / preference / exposure
          ↓
diversity
          ↓
target discovery budget/strategy
          ↓
planner
          ↓
provider resolution/write
```

O planner trabalha com intenção/identidade canônica; provider URI deve ficar próximo da borda de execução.

---

## 23. Migração do Discovery atual

#103/#165/Gate 5H já provaram Discovery em produção com integração cirúrgica e ceiling.

Não remover esse caminho antes de provar o novo modelo.

Migração sugerida:

```text
1. criar Discovery Inbox sem planner influence
2. comparar candidatos com Gate 5H atual
3. projetar inbox em shadow no planner
4. provar ceilings/strategies por destino
5. ativar um destino piloto
6. comparar seleção + conversão
7. migrar demais destinos
8. aposentar aquisição/surgical path antigo somente após paridade
```

Nenhum passo deve permitir duas camadas diferentes inserirem a mesma `SongIdentity` na mesma geração.

---

## 24. Eligibility global

Antes de qualquer seleção Discovery ou fonte normal, respeitar autoridades existentes:

```text
USER_EXCLUDED
provider availability
MUSIC-01 cooldown
MUSIC-07 operational cooldown
TARGET-SCOPE sharing/exclusivity
MUSIC-04 diversity
source scope
reserve constraints
album block constraints
```

A ordem exata será formalizada por consumer, mas Discovery nunca deve criar bypass de regra já existente.

---

## 25. Provenance e explicabilidade

Todo item precisa permitir responder:

- de qual inbox/fonte veio?
- qual provider descobriu?
- qual estratégia?
- por que foi sugerido?
- qual identidade canônica foi resolvida?
- qual provider ref foi usado no playback?
- por que entrou neste destino?
- por que foi suprimido?

Exemplo:

```text
sourceKind = DISCOVERY
provider = LASTFM
strategy = NEW_ARTIST
reason = SIMILAR_TO_HIGH_AFFINITY_ARTIST
songIdentityId = ...
recordingIdentityId = ...
playbackProvider = SPOTIFY
spotifyTrackId = ...
```

---

## 26. Métricas

Identidade:

```text
identityResolvedExact
identityResolvedSameRecording
identityResolvedSameSongDifferentRecording
identityAmbiguous
identityNew
identityMergeRejected
providerAliasCount
```

Discovery Inbox:

```text
discoveryInboxActiveCount
discoveryRefillCount
discoveryCandidatesAcquired
discoveryCandidatesResolved
discoverySuppressedManualInbox
discoverySuppressedDuplicate
discoveryHeard
discoveryDismissed
discoveryExpired
```

Por destino:

```text
discoveryIntensity
discoveryCeiling
discoverySelectedCount
discoverySelectedShareOfMusic
selectedByStrategy
abstainedByStrategy
albumBlocksSelected
```

Conversão reutiliza/evolui as métricas de #103.

---

## 27. Fingerprint e simulation parity

Qualquer configuração que altere seleção deve participar do fingerprint:

- intensidade efetiva;
- strategies habilitadas;
- album mode;
- versão da política/mapping de intensity;
- versão relevante do resolver/identity policy quando influenciar decisão.

Mudança entre simulação e write precisa invalidar/revalidar conforme guards existentes.

Preferência explícita/estado dinâmico continua exigindo revalidação pré-write; fingerprint não substitui estado operacional dinâmico.

---

## 28. Gates de arquitetura

### Gate A — inventário e modelo de identidade

Mapear todos os lugares que usam Spotify IDs como identidade de negócio e classificar consumer/nível desejado.

Sem influence produtiva.

### Gate B — canonical identities em shadow

Criar modelos/refs e resolver identidades existentes sem alterar seleção.

Relatório de aliases, merges, ambiguidades e casos de remaster/live.

### Gate C — migrar regras transversais

Dedupe, preferência, cooldown, diversidade e target sharing, uma por vez, com comparação shadow.

### Gate D — Discovery Inbox read-only

Criar inbox/refill/providers/strategies, Last.fm primeiro, sem influenciar playlists.

### Gate E — destination policy shadow

OFF/LIGHT/MODERATE/HIGH/INTENSE + strategies permitidas em preview.

### Gate F — planner integration piloto

Um destino allowlisted, ceiling sem force-fill, simulação antes de write.

### Gate G — album block

Integrar ALBUM-01 como unidade de planejamento em destino piloto, começando por Academia.

### Gate H — migração/aposentadoria do caminho legado

Somente após paridade de segurança, qualidade e conversão.

---

## 29. Regressões obrigatórias

1. Spotify ID diferente para o mesmo remaster não cria automaticamente música nova quando a gravação foi reconciliada;
2. live e studio da mesma música permanecem gravações distintas;
3. `Live Forever` não é classificada como live apenas pela palavra;
4. cover por outro artista não é fundido por título igual;
5. baixa confiança não cria merge automático;
6. `Escutar` e Discovery não mantêm a mesma `SongIdentity` ativa simultaneamente;
7. adicionar manualmente uma descoberta ao `Escutar` faz a inbox manual prevalecer;
8. Discovery refill só ocorre abaixo do low watermark;
9. refill não duplica item já ativo;
10. consumo real remove da inbox ativa sem apagar memória/conversão;
11. ausência de scrobble isolada não vira consumo nem skip;
12. provider Last.fm indisponível não quebra fontes normais;
13. intensidade OFF preserva comportamento sem Discovery;
14. intensidade é ceiling e nunca quota;
15. destino sem strategy habilitada não recebe item daquela strategy;
16. Carro pode aceitar Redescoberta e rejeitar NEW_ARTIST sem mudar a inbox global;
17. Trabalho pode aceitar strategy que Carro rejeita;
18. MUSIC-04 conta artista por `ArtistIdentity` quando migrado;
19. album deluxe/remaster não burla limite de álbum quando reconciliado ao mesmo `AlbumIdentity`;
20. `USER_EXCLUDED` não é burlado por provider alias/remaster reconciliado;
21. target sharing não é burlado por outro provider ref da mesma identidade;
22. álbum completo preserva sequência e edição escolhida;
23. álbum não é quebrado para preencher ceiling;
24. Discovery não altera podcasts indevidamente;
25. simulação é read-only e reprodutível;
26. mudança de policy invalida fingerprint;
27. provider ref só é exigido na borda de playback/write;
28. caminho legado e novo nunca inserem a mesma identidade na mesma run durante migração.

---

## 30. Critérios de aceite arquiteturais

- [ ] existe identidade canônica explícita para artista, música, gravação e álbum;
- [ ] provider IDs são referências externas, não chaves de domínio;
- [ ] matching é conservador, auditável e confidence-aware;
- [ ] regras declaram qual nível de identidade usam;
- [ ] `Escutar` permanece inbox manual;
- [ ] existe Discovery Inbox separada;
- [ ] Last.fm é primeiro provider, não o domínio;
- [ ] Discovery possui strategies explícitas;
- [ ] refill usa watermarks e é idempotente;
- [ ] `Escutar` prevalece sobre Discovery em conflito;
- [ ] destinos usam intensidade por grau, não porcentagem exposta;
- [ ] intensidade funciona como ceiling, nunca quota;
- [ ] strategies podem ser ativadas/desativadas por destino;
- [ ] fontes normais continuam sob TARGET-SCOPE-01;
- [ ] planner pode evoluir para Candidate Universe canônico;
- [ ] álbum completo pode entrar como unidade sem perder ordem;
- [ ] migração do Gate 5H atual é gradual e reversível;
- [ ] provenance e conversion continuam auditáveis;
- [ ] nenhuma migration/ativação produtiva ocorre automaticamente apenas pela aprovação desta especificação.

---

## 31. Relações com issues existentes

- #37 `MUSIC-04` — diversidade hoje baseada em IDs Spotify; migrar para identidade canônica;
- #102 `ALBUM-01` — autoridade para recomendação/fila de álbum completo;
- #103 `DISCOVERY-01` — perfil e mecanismo atual de descoberta;
- #159 `DISCOVER-UI` — hub visual existente;
- #165 `DISCOVER-DEST-01` — policy atual por destino; esta especificação é evolução, não apagamento;
- #186 `SOURCE-LIKED-01` — fonte normal persistente;
- #200 `MUSIC-VERSION-01` — evidência/classificação de versões;
- #204 `TARGET-SCOPE-01` — source scope e exclusividade;
- #207 `PROVIDER-01` — fronteira multi-provider e canonical recording;
- #278 — provenance/capabilities e compliance pessoal;
- #319 `MUSIC-08` — preferência explícita/exclusão;
- #354 `PLAYBACK-RESERVE-01` — reserva precisa respeitar as mesmas identidades e regras.

---

## 32. Entregas derivadas

Esta especificação deve ser implementada por issues separadas para evitar uma mudança transversal monolítica:

1. **MUSIC-IDENTITY-01** — domínio canônico + resolver + migração transversal;
2. **DISCOVERY-INBOX-01** — inbox automática, providers, strategies, refill e dedupe com `Escutar`;
3. **DISCOVERY-DEST-02** — intensidade por grau, strategies por destino e integração bounded no planner;
4. **ALBUM-DEST-01** — álbum completo como bloco/unidade por destino reutilizando ALBUM-01.

A ordem recomendada é 1 → 2 → 3, com 4 após o modelo de identidade estar estável e o planner bounded por destino estar validado.