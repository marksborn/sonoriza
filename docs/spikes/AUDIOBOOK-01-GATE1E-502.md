# AUDIOBOOK-01 — Gate 1E: investigação do HTTP 502 sem novas escritas

**Status:** fase A preparada — análise estática e diagnóstico GET-only, aguardando CI e execução autenticada.  
**Issue:** [#487](https://github.com/marksborn/sonoriza/issues/487) · antecedentes [#482](https://github.com/marksborn/sonoriza/issues/482) e [#485](https://github.com/marksborn/sonoriza/issues/485).  
**Data da evidência:** 16/10/2026. **Produção:** intocada nesta investigação.

## Pergunta

Por que a única tentativa de inserir o capítulo de *1984* em uma playlist Spotify via API retornou **HTTP 502**, enquanto a inclusão de um episódio comum de podcast na mesma playlist e pelo mesmo código-base funcionou?

Não é seguro explicar um 502 isolado como proibição de audiolivros nem como falha puramente transitória. É erro 5xx do serviço/caminho HTTP; a causa precisa de evidência adicional e o POST anterior não pode ser repetido automaticamente.

## Evidência consolidada (Gates 1B–1D)

| Prova | Capítulo de *1984* | Podcast controle |
| --- | --- | --- |
| Spotify ID | `71PKNrJrxgaYwUY6srGQ3L` | `28WCykrOJqzTpUKSrABWwk` |
| `GET /episodes/{id}?market=BR` | 200; `type=episode`; `show.type=show`, `is_playable=true` | 200; `type=episode`; `show.type=show`, `is_playable=true` |
| `GET /chapters/{chapterId}?market=BR` | 200; `type=chapter`, audiobook associado; mesma URI `spotify:episode:` | não aplicável |
| Endpoint POST | `/playlists/1tsFauBmlMXWJLNKTCQFQE/items` | **mesmo endpoint** |
| JSON POST | `{"uris":["spotify:episode:71PKNrJrxgaYwUY6srGQ3L"],"position":0}` | `{"uris":["spotify:episode:28WCykrOJqzTpUKSrABWwk"],"position":0}` |
| Helper do Sonoriza | `spotifyRequestAttempt`, operação `playlist-write` | **mesmo helper e operação** |
| POST observado | **502** na única tentativa | sucesso, resposta com snapshot |
| GET da playlist pós-POST | 0 itens, confirmado após erro | 1 item do tipo `episode`, URI correspondente |
| Android | não há capítulo na playlist | episódio listado, interface indicando reprodução ativa |

**Importante:** os dois POSTs não aconteceram exatamente no mesmo momento, e o estado da playlist antes de cada um foi revalidado como vazio. A divergência de status **não permite excluir** falha transitória, nem demonstrar rejeição permanente específica ao capítulo.

Atualmente, a playlist privada `1tsFauBmlMXWJLNKTCQFQE` contém **um episódio de controle**. A playlist manual `4kYizEAtQhFsrrwD3tFphP` contém **um objeto de audiobook completo, opaco** no GET (`item=null`): preservá-las integralmente.

## Revisão da implementação HTTP

Os arquivos `scripts/probe-audiobook-existing-second-playlist-chapter.ts` e `scripts/probe-podcast-control-gate1c.ts` utilizam a mesma API `POST /playlists/{id}/items`, o mesmo método, a mesma estrutura JSON (URI única, `position:0`), o mesmo `spotifyRequestAttempt` e escopo Spotify válido nos preflights. A alteração relevante no payload é a **URI**, que representa conteúdos de naturezas diferentes, mesmo com prefixo `spotify:episode:`.

O helper `src/services/spotify/request.ts` faz um único `fetch` de escrita e, em timeout, retorna desfecho desconhecido sem repetir automaticamente. A execução anterior capturou um erro HTTP **502** por resposta; o relatório de Gate 1C não persistiu cabeçalhos de requisição/correlação, corpo nem `Retry-After`. **Não criar request ID fictício nem reconstruir logs não coletados.**

A documentação de [Add Items to Playlist](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist) explicita `track` e `episode`, não `chapter` como classe distinta, e o corpo JSON `uris`/`position`; o capítulo consultado pode ser representado como `episode` no GET, mas isso **não prova autorização no POST**. A documentação de [Get a Chapter](https://developer.spotify.com/documentation/web-api/reference/get-a-chapter) indica prefixo de URI `spotify:episode:`, em linha com o observado, apesar da forma `type=chapter` no endpoint de capítulos.

## Matriz de hipóteses após análise estática

| Hipótese | Evidência favorável | Evidência contrária ou lacuna | Situação |
| --- | --- | --- | --- |
| H1: 502 transitório no serviço/gateway | HTTP 502 único, sem segunda tentativa | Sem logs/correlação, testes em momentos distintos | Em aberto |
| H2: fluxo interno de playlist trata audiolivro de modo especial | Podcast normal funcionou; capítulo falhou | Mesmo capítulo também é `episode` por GET 200 | Em aberto |
| H3: entitlement/mercado/`show` de origem cria diferença | Audiobook possui representação própria; documentação de mercados restritos | `is_playable=true`, sem `restrictions.reason` detectado nos GETs | Em aberto |
| H4: erro de JSON, rota ou escopo no Sonoriza | Nenhuma | Mesma rota, payload estrutural, helper e preflight válidos para podcast | Menos provável |
| H5: limitação de observabilidade do 502 | Headers/request ID não registrados no relatório | Não existe diagnóstico retrospectivo completo | Confirmada como lacuna |

## Fase A — metadados somente leitura

`scripts/inspect-audiobook-gate1e-502-readonly.ts` compara:
1. `GET /me` (somente validar identidade da conta, sem imprimir ID);
2. `GET /episodes/71PKNrJrxgaYwUY6srGQ3L?market=BR` — capítulo sob a representação de episódio;
3. `GET /episodes/28WCykrOJqzTpUKSrABWwk?market=BR` — episódio comum, controle positivo;
4. `GET /shows/{showId}` para o show associado a cada item, extraído **somente** dos episódios fixos validados.

Limite máximo **5 GET**; nenhum POST/PUT/DELETE/PATCH, nenhum write no banco, nenhuma renovação OAuth, nenhuma alteração de playlist, player ou deploy. GET de `show` pode responder 403/404: registrar como diagnóstico, não retentar. Em 429 ou 5xx, abortar. **Não imprimir token, email, nomes de pessoas, publisher ou descrições**; registrar somente tipos, booleans e contagens. ID do show é necessário apenas dentro da execução e não precisa ser exibido ao usuário.

O script rejeita `--execute-post`, `--confirm=`, `--write*` e `--allow-token-refresh`. Token expirado interrompe com `TOKEN_EXPIRED_NO_REFRESH`. O resultado esperado quando todos GETs válidos forem concluídos será `GATE1E_METADATA_FORENSICS_COMPLETE_NO_WRITES`.

**Limite epistemológico:** dois episódios cujos metadados coincidam podem ter elegibilidade de playlist diferente. Esta inspeção GET-only nunca atesta a escrita de capítulo, mesmo que encontre `media_type` semelhante.

## Próxima decisão — sem autorização de escrita neste Gate

Se persistir a ambiguidade, pode ser pertinente:
- Consultar o suporte/Developer Community do Spotify com IDs públicos, as duas rotas, resultado 502 e comparação de POSTs, sem expor token, identidade da conta ou credenciais.
- Projetar um teste novo, controlado e autorizável de inserção **se houver hipótese técnica testável**, com uma única tentativa, preflight de identidade/snapshot/estado real e reconciliação após qualquer erro. **Isso não faz parte da fase A**.
- Preservar ou remover o episódio de controle **somente após consentimento para uma eventual limpeza**; não criar terceira playlist sem justificativa e aprovação.

**Decisão atual de produto:** GO-LIMITED para catálogo/estante/navegação/abertura no Spotify; NO-GO provisório para inserção automática de capítulos de audiolivro em playlists do Sonoriza até prova positiva de POST + GET + reprodução oficial.

## Check de saída
- [x] Forense estática de endpoint, JSON, token/preflight e tratamento de erros documentada.
- [x] Instrumentação GET-only, no máximo 5 consultas, sem OAuth refresh, sem playlist writes.
- [ ] CI dos helpers, testes, typecheck e build.
- [ ] Execução autenticada GET-only e análise de saída JSON sanitizada.
- [ ] Registrar achados e plano de investigação seguinte no GitHub, sem extrapolar resultado.
