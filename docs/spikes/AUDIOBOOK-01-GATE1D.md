# AUDIOBOOK-01 — Gate 1D: capítulos de audiolivros vs episódios e playlists

**Status:** DIAGNÓSTICO AUTENTICADO EXECUTADO E RECONCILIADO — Gate 1D read-only completo; decisão conservadora sobre escrita de capítulos mantida.
**Issue:** [#485](https://github.com/marksborn/sonoriza/issues/485) · **Gate original:** [#482](https://github.com/marksborn/sonoriza/issues/482) · **Gate 1C:** [PR #484](https://github.com/marksborn/sonoriza/pull/484).

## Pergunta
Um objeto `chapter` de audiobook, embora devolva URI de aparência `spotify:episode:`, pode ser tratado como um `episode` comum na API de playlists? Não presumir que URI semelhante implica semântica idêntica. A documentação oficial e a forma retornada pelo Spotify podem divergir.

## Evidências confirmadas em Spotify BR — 16/10/2026

| Prova | Resultado confirmado | Limite |
| --- | --- | --- |
| `GET /audiobooks/5E76EUAq7or1ncd4QNyHjI` | audiobook *1984*, total 35 capítulos | um catálogo/conta/mercado |
| `GET /chapters/71PKNrJrxgaYwUY6srGQ3L` | `type=chapter`, `is_playable=true`, `spotify:episode:71PKNrJrxgaYwUY6srGQ3L`, retomada | leitura de capítulo não prova que playlist aceite sua URI |
| Playlist manual `4kYizEAtQhFsrrwD3tFphP` | livro inteiro adicionado no app; item `null` opaco por API | API não identificou item como capítulo |
| `POST /playlists/1tsFauBmlMXWJLNKTCQFQE/items` com capítulo | única tentativa: HTTP **502**; depois playlist vazia por API e Android | 502 não demonstra rejeição permanente |
| Mesmo POST para episódio comum `spotify:episode:28WCykrOJqzTpUKSrABWwk` | **sucesso**, snapshot, GET total 1, `type=episode`, matched true | reprodução audível não comprovada pelo screenshot |
| Android para controle | episódio visível na playlist **privada**, título verde, pausa no player | UI indica reprodução ativa, não comprova som |
| Estado atual da segunda playlist | privada e **contém exatamente um episódio de controle** | qualquer script antigo que exige total=0 não deve ser reexecutado |

## Resultado autenticado do Gate 1D — 16/10/2026, conta Spotify BR

**Comando executado com commit `d3a9d4aa4d10770c10f1f674ad26ade0b38f04a1`** (PR #486; CI anterior aprovado), resultado:

`outcome=GATE1D_READONLY_COMPLETE_INTERPRET_WITH_CARE`, **9 GET, 0 POST, 0 PUT, 0 DELETE, 0 playlist writes, 0 OAuth refresh, 0 player commands, 0 retries**.

### Matriz de endpoints — o mesmo ID apresenta duas representações

| Endpoint (market=BR) | HTTP | `type` | `uri` | `playable` | Relação |
| --- | --- | --- | --- | --- | --- |
| `GET /chapters/71PKNrJrxgaYwUY6srGQ3L` | 200 | **`chapter`** | `spotify:episode:71PKNrJrxgaYwUY6srGQ3L` | true | `audiobook.id=5E76EUAq7or1ncd4QNyHjI`, nenhum `show` |
| `GET /episodes/71PKNrJrxgaYwUY6srGQ3L` | 200 | **`episode`** | **mesma URI** | true | `show.type=show`, sem `audiobook` |
| `GET /episodes/28WCykrOJqzTpUKSrABWwk` | 200 | `episode` | `spotify:episode:28WCykrOJqzTpUKSrABWwk` | true | `show.type=show` (podcast controle) |
| `GET /audiobooks/5E76EUAq7or1ncd4QNyHjI` | 200 | `audiobook` | não avaliada | — | 35 capítulos |

Todas as consultas de capítulo e episódio tiveram `restrictionReasonPresent=false`. Esse campo não garante elegibilidade de inclusão na playlist.

**Achado crítico:** o mesmo ID/URI de capítulo tem **representações distintas conforme o endpoint**. O Spotify o fornece tanto como `chapter` associado a audiobook quanto como `episode` associado a `show`. Portanto, é **incorreto** afirmar que o erro HTTP 502 do Gate 1C decorre necessariamente de o capítulo ser irreconhecível pelo endpoint de episódios comuns. Por outro lado, um GET bem-sucedido de episódio **não garante** a validade da mesma URI para o POST de playlist. A causa do 502 permanece **não determinada**.

O classificador do código retornou corretamente:
`BOTH_ENDPOINTS_RESOLVE_ID_BUT_PLAYLIST_COMPATIBILITY_UNPROVEN`.

### Reconciliação de playlists (GET somente leitura)

| Playlist | Visibilidade por API | Total | Itens retornados | Conteúdo observado |
| --- | --- | --- | --- | --- |
| Segunda experimental privada `1tsFauBmlMXWJLNKTCQFQE` | `public=false` | **1** | 1 | `episode` do podcast controle, URI exata reconhecida, `opaqueCount=0` |
| Primeira manual com livro completo `4kYizEAtQhFsrrwD3tFphP` | `public=true` | **1** | 1 | objeto `item=null`/tipo ausente, `opaqueCount=1` |

Ambas passaram na validação de ID, proprietário e nome, `collaborative=false`. **A segunda playlist NÃO está vazia**; não reutilizar scripts de inserção que exigem `total=0`. A primeira playlist mostra um item inteiro opaco e não pode ser interpretada como vazia só porque o objeto é `null`.

### Consequências técnicas

1. **Não existe uma equivalência direta entre tipo de catálogo e tipo de playlist:** manter `AudiobookChapter` e `PodcastEpisode` como conceitos distintos, mas registrar as representações `chapter` e `episode` possíveis para a mesma URI.
2. **Viabilidade de leitura confirmada para este livro e conta BR**: ambos endpoints e livro responderam HTTP 200; não generalizar por mercado ou títulos.
3. **Inserção de capítulo continua não demonstrada:** única tentativa do Gate 1C retornou **HTTP 502** e subsequente reconciliação encontrou **0 itens**. Controle de podcast no mesmo endpoint funcionou (POST aceito, GET item presente, Android mostrando reprodução ativa).
4. **Sem novos POSTs como conclusão deste Gate:** qualquer investigação de escrita futura deve justificar hipótese delimitada, desenhar limpeza sem afetar o controle, exigir aprovação própria, 1 tentativa sem retentativas e reconciliação obrigatória, e considerar rate limits/5xx.
5. **Decisão:** GO-LIMITED para estante/navegação/abrir no Spotify; NO-GO provisório apenas para *automatizar a inclusão de capítulos em playlists* sem demonstração de compatibilidade. O 502 isolado **não é prova de impossibilidade definitiva**.

### Evidências e classificação

- A saída é um relatório local de 9 GETs autenticados, não uma resposta de autorização de escrita.
- Exemplo de duas representações sob o mesmo ID é agora coberto por teste de regressão na PR #486.
- Não houve alterações de conteúdo, playlists, banco ou player.

## Documentação oficial do Spotify (verificação em 16/10/2026)

- [Add Items to Playlist](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist) aceita URIs de `track` ou `episode`; **não há autorização explícita de `chapter`**.
- [Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter) descreve URI do capítulo com prefixo `spotify:episode:` e marca o campo `type` como `episode`; **a resposta real do nosso capítulo foi `type=chapter`**.
- [Get Episode](https://developer.spotify.com/documentation/web-api/reference/get-an-episode) define um episódio comum com `show`, `type=episode` e `spotify:episode:`.
- [Get Audiobook Chapters](https://developer.spotify.com/documentation/web-api/reference/get-audiobook-chapters) e Get a Chapter documentam disponibilidade em US, UK, CA, IE, NZ e AU. **Nossa conta brasileira recebeu retorno bem-sucedido para *1984***, o que demonstra uma discrepância pontual com a documentação; não assumir que todos os livros/mercados funcionam.
- Spotify proíbe facilitar download/extração do conteúdo e exige atribuição da origem na integração. Gate não coleta áudio, capas nem tokens.

## Gate 1D: experimento SOMENTE LEITURA

Arquivo: `scripts/inspect-audiobook-gate1d-readonly.ts`.

Entrada: somente `--email=<conta Sonoriza conectada>` e token OAuth atualmente válido. **Não habilita refresh de OAuth.**

Matriz de GETs (no máximo 9, sem retries):

| Nº | Requisição | O que investiga |
| --- | --- | --- |
| 1 | `GET /me` | proprietário autorizado sem imprimir ID |
| 2 | `GET /chapters/{chapterId}?market=BR` | `type`, URI e vínculo com audiobook |
| 3 | `GET /episodes/{chapterId}?market=BR` | se ID de capítulo é resolvido como episódio; 403/404 são dados diagnósticos |
| 4 | `GET /episodes/{podcastId}?market=BR` | controle de episódio comum |
| 5 | `GET /audiobooks/{bookId}?market=BR` | leitura de audiobook e quantidade de capítulos |
| 6–7 | `GET /playlists/{secondId}` + `GET /playlists/{secondId}/items` | confirma episódio de controle já adicionado, playlist privada |
| 8–9 | `GET /playlists/{manualId}` + `GET /playlists/{manualId}/items` | confirma objeto de audiobook inteiro potencialmente opaco |

IDs de playlist, audiobook e capítulo são fixos no código; verificação de nome e proprietário antes de consultar itens. Nenhuma solicitação retorna dados de outras playlists.

**Proibições duras:** script contém apenas método `GET`; não importa helper de refresh e rejeita `--allow-token-refresh`, `--execute-post` e `--confirm`. Zero POST/PUT/DELETE/PATCH, zero player, zero criação/exclusão/renomeação de playlist, zero alterações no banco. Token expirado aborta sem efeitos de Spotify; sem deploy. Respostas saneadas incluem tipo, links verificados/URI booleano, contagens, `status` e erro abstrato; sem tokens/perfil/nome pessoal.

## Como interpretar resultados (sem sobreafirmação)

1. `GET /chapters/{id}` reconhece `type=chapter`, mas `GET /episodes/{id}` devolve 404, enquanto o podcast normal é `type=episode`: forte indício de objetos de catálogo distintos; **não** prova que capítulo nunca poderá entrar em playlist, apenas reforça bloqueio.
2. Ambos os endpoints devolvem o capítulo com `type=episode` ou `type=chapter`: ainda **não** autoriza a conclusão de que playlist permite inserção; o único POST real de capítulo falhou.
3. Spotify retorna 403 para capítulos: registrar possível restrição de escopo/mercado/entitlement, sem afirmar causa.
4. Playlist manual mostra `total=1` com `item=null`: evidencia limites de representação de audiobook inteiro no endpoint, não zero conteúdo.
5. Segundo playlist controla GET de episódio já persistido (`total=1`) — **não repetir** scripts do Gate 1C que pressupõem lista vazia.

## Decisão de produto proposta

- **GO-LIMITED:** planejar biblioteca/estante de audiolivros dentro do Sonoriza, catálogo/capítulos e links externos para abrir o Spotify, respeitando escopos/mercados/políticas; sem alegar controle de reprodução ou download de áudio.
- **NO-GO provisório:** permitir que o planejamento de playlists insira automaticamente capítulos de audiolivro enquanto não existir um caso bem-sucedido demonstrado via POST + GET da playlist + reprodução no player oficial.
- **Separação de modelos:** `PodcastEpisode` e `AudiobookChapter` como categorias semanticamente distintas no domínio do Sonoriza, mesmo quando as URIs compartilham prefixo `spotify:episode:`. Jamais usar prefixo da URI como único teste de tipo.
- **Mudança futura:** qualquer novo POST (incluindo limpar episódio de controle), alteração de visibilidade, refresh de token no DB ou deploy exige novo escopo de autorização e plano de reconciliação. Não retentar automaticamente erros 5xx.

## Critérios de encerramento deste Gate

- [x] Evidências e divergências de documentação catalogadas.
- [x] Contrato do inspetor GET-only documentado, sem mutações de conta/playlist.
- [x] CI inicial para helpers, teste, Prisma, typecheck e build aprovado (run #38989498425, commit d3a9d4aa); CI do update documental/testes executará separadamente.
- [x] Execução autenticada read-only com saída JSON saneada compartilhada (9 GET, zero alterações).
- [x] Resultado revisado: tipo dual de catálogo confirmado, compatibilidade de POST **não demonstrada**, GO-LIMITED leitura / NO-GO provisório inclusão automática; eventual novo Gate de escrita requer aprovação.

**Gate 1D read-only cumpriu os critérios de investigação, com evidência autenticada.** Esta conclusão **não implica** aprovação para novos POSTs, refresh OAuth, limpeza das playlists, merge ou deploy. PR permanece Draft até decisão de integração.
