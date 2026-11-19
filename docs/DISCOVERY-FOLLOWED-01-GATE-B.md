# DISCOVERY-FOLLOWED-01 (#564) — Gate B: contrato

Família nova da Descoberta por destino: **"Artistas que sigo"**. Ela oferece faixas **não curtidas e sem escuta conhecida** de artistas que o usuário segue no Spotify. É documento de contrato: nada aqui muda planner, banco ou playlists. A implementação vem nos Gates C (aquisição em SHADOW) e D (seleção em SHADOW).

## 1. Evidência do Gate A (19/11/2026)

- 614 artistas seguidos, todos acessíveis em 13 chamadas. 99% têm scrobbles no Last.fm e 75% têm faixas curtidas.
- Amostra de 10 artistas: 21 álbuns e singles por artista; das 345 faixas lidas, só 3,5% estão curtidas, e **62% não estão curtidas nem têm escuta conhecida** (teto, porque a comparação é por nome).
- O catálogo completo custaria **cerca de 14.500 chamadas**. Conclusão: leitura **amostrada** com orçamento diário, nunca o catálogo inteiro.

O valor está nas faixas pouco exploradas de artistas que o usuário já ouve, não na descoberta de artistas novos.

## 2. Política e provenance (PERSONAL §8.1)

| Dado | Origem | Uso permitido |
|---|---|---|
| Lista de seguidos | `SPOTIFY_FOLLOWED_ARTISTS` | Só **delimitar** quais artistas entram (capability `spotifyFollowedArtistsCandidateCapability`) |
| Álbuns e faixas | `SPOTIFY_CATALOG` | Identidade e catálogo |
| Ordem dos artistas | `LASTFM_SCROBBLE` | Afinidade e ordenação (permitido) |
| Curtidas, `TrackListeningState`, Last.fm | Spotify e Last.fm | Só **excluir** faixas já conhecidas (elegibilidade) |

- **Proibido:** ordenar ou pontuar por follow, por número de curtidas (Saved Tracks como perfil está bloqueado) ou por popularidade do Spotify. O follow nunca gera `ArtistAffinity`.
- **Avaliação da capability:** na aquisição e de novo ao entregar candidatos ao planner, falhando fechado. Se ela não for `allowed`, a família fica vazia e registra o motivo.
- **IA:** nada desta família chega a IA (Tião Brain).

## 3. Aquisição (Gate C)

**Armazenamento:** um snapshot por usuário, `FollowedArtistCatalogSnapshot`, no molde de `ReleaseRadarSnapshot`. Apaga junto com o usuário.

| Campo | Conteúdo |
|---|---|
| `followedArtists` | `{id, name}[]` e `followedSyncedAt` |
| `artistChecks` | por artista: `checkedAt`, `nextOffset` (rodízio de páginas de álbuns) e `sampledAlbumIds` |
| `candidates` | faixas acumuladas, no máximo 200, retidas por 60 dias (seção 4) |
| `evidence` | chamadas, falhas, exclusões por motivo e bloqueio de cota |

**Interruptor da aquisição (Gate C):** `FOLLOWED_ARTISTS_CATALOG_MODE=ACTIVE` liga a leitura diária automática; o padrão é OFF. Vale só para usuários com a permissão `user-follow-read`. O botão "Atualizar agora" em Descobrir → Seguidos funciona sempre e respeita o mesmo intervalo de 20 h. Implementação: `src/services/followed-artists/`.

**Cadência e orçamento:**
- **Lista de seguidos:** sincroniza 1 vez por semana (cerca de 13 chamadas). Artista que deixou de ser seguido sai do snapshot e leva junto seus candidatos. Fatos históricos não mudam.
- **Atualização do catálogo:** no máximo 1 por dia (intervalo mínimo de 20 h), aproveitando a ociosidade do cron como faz o radar de Novidades (`refreshDueReleaseRadars`). Lê **20 artistas por dia**.
- **Por artista:** 1 página de álbuns (`include_groups=album,single`, `limit=10`, `offset=nextOffset`) e as faixas de **até 2 álbuns** ainda não amostrados. São cerca de **3 chamadas por artista**, ou **cerca de 60 por dia**. O `nextOffset` avança e volta ao início quando passa do `total`.
- **Revisão de cada artista:** no máximo a cada 14 dias. Com 614 artistas, uma volta completa leva cerca de 31 dias e cobre 2 álbuns por artista por volta.
- **Cota:** para no primeiro `QUOTA_EXCEEDED`/`RATE_LIMITED` e respeita o backoff global. Snapshot com maioria de falhas não é gravado, mesma regra do radar.

**Ordem dos artistas (só Last.fm):**
1. Primeiro os nunca verificados, depois os verificados há mais tempo.
2. Entre os que estão na vez, pesa a soma de scrobbles do artista nos últimos 24 meses, para priorizar quem o usuário mais ouve.
3. Artistas sem Last.fm (6 hoje) vão para o fim da fila.

## 4. Regras de candidata

Uma faixa só vira candidata se passar por **todas** as regras abaixo. Cada exclusão é contada por motivo em `evidence`.

| Regra | Motivo de exclusão |
|---|---|
| O artista seguido é o **artista principal** da faixa (`artists[0].id`) | `NOT_PRIMARY_ARTIST` |
| O álbum é `album` ou `single` (sem `appears_on` nem coletânea) | `NOT_OWN_RELEASE` |
| Não está curtida (`LikedTrackPreference.isLiked`) | `LIKED` |
| Sem `TrackListeningState` | `HEARD_SPOTIFY_STATE` |
| Sem scrobble no Last.fm com artista e título normalizados e sem sufixo de versão | `HEARD_LASTFM_NAME` |
| O título não indica versão: remaster, ao vivo, demo, instrumental, acústico, remix, karaokê, edit ou versão | `VERSION_AMBIGUOUS` (identidade incerta até a #374: ABSTAIN) |
| Reprodutível (`is_playable !== false`) e com duração entre 90 s e 10 min | `UNPLAYABLE` / `DURATION` |
| No máximo 2 por álbum e 3 por artista no snapshot | `CAP` |
| URI ainda não está no snapshot | `DUPLICATE` |

**Na geração**, as regras de sempre continuam valendo pelo `filterMusicBatchForCurrentRun`: "Não tocar mais" (#319), exclusão de artista, cooldown e repetição. A família não tem filtro próprio que pule essas regras.

**"Sem escuta conhecida" não prova que o usuário nunca ouviu.** O motivo mostrado diz exatamente isto: *"Artista que você segue; faixa ainda não curtida; sem escuta conhecida no histórico disponível."*

**Motivos gravados na candidata:**
- `FOLLOWED_ARTIST`, `NOT_LIKED`, `NO_KNOWN_PLAY`;
- `LASTFM_RANK` com a posição do artista na fila.

## 5. Integração com a Descoberta por destino (Gates D e E)

- **Opt-in por destino:** `TargetPlaylist.discoveryFollowedEnabled`, padrão `false`. Migração aditiva no Gate D, mostrada ao lado de "Novidades" em Descobrir por destino como **"Artistas que sigo"**.
- **Interruptor do operador:** `FOLLOWED_ARTISTS_PLANNER_MODE`, padrão **OFF**.
  - `SHADOW`: registra em `summary.targetDiscoveryRuntime.evidence.followedArtists` o que entraria.
  - `ACTIVE`: injeta. Remover a variável é a reversão.
- **Leitura na geração:** usa só o snapshot, **sem chamada ao Spotify**, como Novidades.
- **Teto por destino e por geração:**
  - pela intensidade: CONSERVATIVE 1, BALANCED 2, EXPLORATORY 3;
  - nunca acima de 5% das faixas de música estimadas para o destino, com mínimo de 1 quando o opt-in está marcado.
  - É teto, não cota: sem candidata segura, entram 0 e nada é substituído.
- **Espalhamento:** como em `spreadReleasesIntoPool`, mas em posições diferentes das de Novidades, para não colar duas descobertas seguidas.
- **Mesmo artista:** pelo menos 7 dias entre aparições desta família, contados pelos `GenerationItem` publicados. A regra vale só para esta família, não para as faixas familiares do artista.
- **Conflitos:**
  - URI que também está em Novidades fica com Novidades;
  - dedupe entre destinos pelas reservas já existentes;
  - nos destinos KEEP_FILLED, Reserva e por evento, as faixas da família são candidatas comuns e seguem as regras do destino.
- **Revisão e prévia:** linha "Artistas que sigo", no mesmo padrão de Novidades: "N faixa(s) entraram/entrariam" e os títulos.

**Implementação do Gate D:** `src/services/followed-artists/followed-planner.ts` e `src/jobs/incremental-planning.ts`.
- A capability é reavaliada ao carregar o snapshot; se não estiver liberada, a evidência registra `POLICY_BLOCKED` e nada entra.
- A estimativa de faixas de música usa média de 4 min: duração do destino × (100% − % de podcast).
- Cada artista entra no máximo uma vez por geração. O intervalo de 7 dias conta os `GenerationItem` de gerações reais (não simulações) com URI do catálogo, já que essas faixas são, por construção, não curtidas e sem escuta conhecida.
- Posições: Novidades usam índice % 4 = 1; esta família usa índice % 4 = 3.

## 6. Observação (Gate F)

- Exposição (`GenerationItem` publicado) ≠ escuta. A escuta só conta com scrobble no Last.fm ou com `TrackListeningState` vindo de fonte autorizada.
- Sem scrobble ≠ skip ≠ não gostei.
- **Métricas por família:**
  - candidatas;
  - injetadas;
  - publicadas;
  - ouvidas em até 7 dias por fonte autorizada;
  - excluídas pelo usuário ("Não tocar mais");
  - chamadas por dia e falhas.
- **Feedback:** "Não tocar mais" funciona como hoje. Reduzir a frequência de um artista fica para depois, junto com a #376.

## 7. Plano dos próximos gates

| Gate | Entrega | Impacto em playlist |
|---|---|---|
| C | Snapshot, sincronização semanal, refresh diário amostrado, evidência e tela em Descobrir mostrando as candidatas | nenhum |
| D | Opt-in por destino (migração), `FOLLOWED_ARTISTS_PLANNER_MODE=SHADOW` e evidência na revisão | nenhum |
| E | Simulação, geração manual e agendada em ACTIVE num destino piloto, com autorização explícita | só no piloto |
| F | Métricas e paridade registrada na #458 | — |

## 8. Decisões do dono — aprovadas em 19/11/2026

As três propostas abaixo foram aprovadas sem ajuste e valem para os Gates C a E.


1. **Exclusão de versões** (ao vivo, remaster, acústico...) na V1: proposta **excluir** até a #374 dar identidade confiável.
2. **Tetos por intensidade** de 1, 2 e 3 faixas por geração, além do limite de 5%.
3. **Orçamento diário** de 20 artistas, cerca de 60 chamadas, e revisão de cada artista a cada 14 dias.
