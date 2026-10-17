# AUDIOBOOK-01 — Gate 1D: capítulos de audiolivros vs episódios e playlists

**Status:** IMPLEMENTADO PARA INSPEÇÃO READ-ONLY — aguardando CI e execução controlada.
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
- [ ] CI para os helpers, teste, Prisma, typecheck e build aprovado.
- [ ] Execução autenticada read-only com saída JSON saneada compartilhada.
- [ ] Revisar resultado e decidir fechamento do Gate 1D / eventuais experimentos posteriores.

**Não concluir o Gate 1D apenas porque o CI passou:** a evidência autenticada ainda é necessária.
