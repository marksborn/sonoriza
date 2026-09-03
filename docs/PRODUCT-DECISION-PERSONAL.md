# Decisão de produto — Sonoriza como projeto pessoal

- **Data:** 2026-09-02
- **Status:** vigente
- **Issue de governança:** #278 — `SPOTIFY-COMPLIANCE-01`

> Este documento registra uma decisão de produto e a interpretação técnica adotada pelo projeto. Não é parecer jurídico. Termos e políticas dos providers devem ser revistos quando houver mudanças relevantes.

## 1. Decisão

O Sonoriza permanece um **projeto pessoal, gratuito e não comercial**, destinado ao autor e a um pequeno grupo de amigos autorizados no Spotify Development Mode.

Não faz parte do roadmap atual:

- cobrança;
- planos Free/Pro;
- waitlist pública;
- onboarding público irrestrito;
- comercialização como SaaS;
- Extended Quota como objetivo de crescimento;
- integração de Spotify Content/User Data com Tião Brain, LLM ou IA.

O propósito do Sonoriza continua sendo o original:

> **organizar e gerar playlists dinâmicas que misturam músicas e podcasts, deixando o Spotify responsável pelo playback.**

```text
fontes + regras + agenda
        ↓
     SONORIZA
        ↓
playlist de música + podcast
        ↓
      Spotify
        ↓
      playback
```

## 2. Princípio de arquitetura

Uso pessoal não elimina as políticas dos providers. Por isso, a arquitetura continua preservando origem/provenance e separando três classes:

```text
DIRECT_PROVIDER_OPERATION
SONORIZA_FIRST_PARTY_STATE
DERIVED_ANALYTICS_OR_PROFILING
```

Uma transformação ou agregado não pode apagar silenciosamente a origem do dado.

## 3. Papel das fontes

### Spotify — provider operacional

Usos esperados:

- autenticação/autorização;
- biblioteca e playlists-fonte;
- Saved Tracks como candidate source;
- leitura e escrita de playlists;
- resolução de identidade/catalogação;
- shows e episodes;
- estado operacional de episódios quando necessário;
- playback feito pelo próprio Spotify.

Não usar como nova fonte de:

- inferência de skip;
- `skipRate`;
- `completionRatio` derivado do histórico;
- perfil comportamental;
- afinidade derivada de histórico Spotify;
- IA/LLM/Tião Brain.

### Last.fm — histórico e analytics musicais

Direção principal para:

- scrobbles;
- playcount;
- top tracks/artists/albums;
- afinidade;
- momentum;
- redescoberta;
- similaridade (`artist.getSimilar`, `track.getSimilar`);
- evidência para MUSIC-06, sempre respeitando cobertura e limitações do scrobbling.

Last.fm não fornece retrospectivamente um campo de skip. Portanto:

```text
scrobble presente != ouviu até o fim
scrobble ausente != skip automaticamente
```

A ausência de scrobble só pode contribuir para uma inferência quando houver cobertura confiável e contexto first-party suficiente.

### Preferências explícitas — first-party

Regras declaradas pelo usuário são a fonte mais simples e forte para personalização:

```text
não tocar faixa X
reduzir artista Y
não quero versões ao vivo
quero mais descoberta
quero menos repetição
```

### Estado do Sonoriza — first-party operacional

Inclui:

- runs;
- ordem efetivamente publicada;
- `TrackExposure`;
- cooldown;
- lifecycle de episódios;
- decisões e regras explícitas.

Esse estado pode influenciar elegibilidade sem ser transformado automaticamente em gosto ou preferência.

### Extended Streaming History

É tratado separadamente como `USER_IMPORT_SPOTIFY_HISTORY`.

Para analytics/profile permanece `REVIEW_REQUIRED`; para IA permanece `DENY`.

## 4. Matriz PERSONAL

| Origem | Operational planning | Planner eligibility | Behavioral analytics | User profiling | Recommendation | AI |
|---|---|---|---|---|---|---|
| SPOTIFY | ALLOW/feature review | ALLOW/feature review | **DENY** | **DENY** | operação direta; derived = **DENY** | **DENY** |
| LASTFM | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | REVIEW_REQUIRED |
| USER_IMPORT_SPOTIFY_HISTORY | ALLOW/REVIEW | ALLOW/REVIEW | REVIEW_REQUIRED | REVIEW_REQUIRED | REVIEW_REQUIRED | **DENY** |
| FIRST_PARTY | ALLOW | ALLOW | ALLOW | ALLOW | ALLOW | REVIEW_REQUIRED |

Regras:

- mistura de origens herda a capability mais restritiva;
- lineage Spotify ou import Spotify nunca entra em IA;
- um perfil `COMMERCIAL`, se existir tecnicamente no futuro, permanece desativado enquanto esta decisão estiver vigente.

## 5. MUSIC-01 / MUSIC-07 — cooldown por exposição

Música tem uma política de repetição própria.

Além de consumo confirmado por uma fonte adequada, o Sonoriza pode usar seu próprio estado de exposição para impedir que a mesma faixa seja programada indefinidamente.

```text
faixa publicada em run real
        ↓
TrackExposure
        ↓
N exposições válidas sem confirmação de consumo
        ↓
cooldown operacional
        ↓
faixa volta a ser elegível ao vencer a janela
```

`TrackExposure` significa apenas que o Sonoriza programou a faixa.

Não significa:

- ouviu;
- pulou;
- não gostou.

Portanto exposição, sozinha, não cria `INFERRED_SKIP` ou preferência negativa.

A playlist `Tocados` pode existir como materialização visual opcional do estado de cooldown, mas a fonte de verdade deve permanecer no banco do Sonoriza.

Ver #279.

## 6. MUSIC-06 — skip via Last.fm + first-party

A nova direção não usa Spotify Recently Played para detectar skip.

Detector conceitual:

```text
ordem publicada pelo Sonoriza:
A → B → C

Last.fm com cobertura confirmada:
A ✓
B ausente
C ✓

→ B pode gerar INFERRED_SKIP
  com confidence e evidence explícitas
```

A ausência só é avaliável quando houver cobertura Last.fm confirmada na janela.

Não usar:

- diferença temporal entre eventos Spotify;
- `duration_ms` + próxima reprodução Spotify;
- ausência em Recently Played;
- Extended History como ground truth automático.

Ver #277.

## 7. Podcasts — manter o conceito original

Podcasts continuam no Spotify, misturados às músicas na playlist de destino.

Não criar player RSS como substituto do fluxo principal.

```text
Spotify shows/episodes
        ↓
     Sonoriza
        ↓
podcast + músicas + podcast + músicas
        ↓
      Spotify
```

Podcast possui lifecycle próprio:

```text
AVAILABLE → SCHEDULED → ACTIVE → DONE
```

Não aplicar o cooldown de música a episódios.

`resume_position_ms` / `fully_played` podem ser tratados como estado operacional para manter/concluir um episódio, sem produzir métricas comportamentais como taxa de abandono ou preferência por duração.

Ver #55 e #237.

## 8. Saved Tracks

Saved Tracks continua sendo uma fonte operacional válida:

```text
Spotify Saved Tracks
        ↓
LIKED_TRACKS candidate source
        ↓
planner
```

Mas isso fica separado de perfil:

```text
Saved Tracks → candidate pool     operacional
Saved Tracks → ArtistAffinity     não usar como nova evidência Spotify
```

Afinidade/discovery devem priorizar Last.fm + preferências explícitas/first-party.

Ver #184, #186 e #103.

## 9. Discovery e álbum

DISCOVERY-01 e ALBUM-01 continuam no projeto pessoal.

Métricas como:

- afinidade;
- playcounts;
- momentum;
- redescoberta;
- sinais negativos;

precisam carregar provenance e ser calculadas prioritariamente a partir de Last.fm/first-party.

Spotify continua sendo provider de identidade/catalogação e destino de playlist, não a nova fonte de perfil comportamental.

## 10. IA

Invariante:

```text
SPOTIFY lineage ─X→ AI / LLM / Tião Brain
USER_IMPORT_SPOTIFY_HISTORY ─X→ AI / LLM / Tião Brain
```

O Sonoriza deve funcionar de forma determinística sem IA.

## 11. Privacidade e lifecycle

Mesmo como projeto pessoal, manter:

- mecanismo de desconexão;
- exclusão de dados aplicáveis após desconexão conforme termos vigentes;
- retenção definida;
- minimização de scopes;
- attribution/link back quando aplicável;
- lifecycle correto de tokens e reautenticação;
- provenance suficiente para aplicar políticas por origem.

## 12. Gates da #278

Os gates permanecem como governança técnica, não como preparação para lançamento comercial.

1. **Gate 1 — inventário read-only**
2. **Gate 2 — provenance/capabilities PERSONAL**
3. **Gate 3 — hard guard de IA**
4. **Gate 4 — preferências explícitas/first-party**
5. **Gate 5 — realinhar analytics/discovery para Last.fm/first-party**
6. **Gate 6 — retenção/deletion/disconnect**

O antigo Gate 7 de commercial readiness está encerrado enquanto esta decisão estiver vigente.

## 13. Roadmap encerrado

Encerrados como `not_planned`:

- #270 — PRELAUNCH-01 / waitlist pública;
- #208 — MONETIZATION-01 / Free-Pro / billing.

Também ficam fora do roadmap atual:

- CNPJ específico para comercialização do Sonoriza;
- pedido de Extended Quota como meta de crescimento;
- multiusuário público irrestrito;
- integração de Spotify data com Tião Brain.

## Referências internas

- #278 — governança/compliance/provenance
- #277 — MUSIC-06 / skip via Last.fm
- #279 — MUSIC-07 / exposição first-party
- #34 — MUSIC-01 / cooldown
- #55 / #237 — podcasts
- #103 / #102 / #185 — discovery, álbum e histórico
- #184 / #186 — liked/saved tracks

## Referências externas

- Spotify Developer Policy: https://developer.spotify.com/policy
- Spotify Developer Terms: https://developer.spotify.com/terms
- Spotify quota modes: https://developer.spotify.com/documentation/web-api/concepts/quota-modes
- Last.fm API: https://www.last.fm/api
