# AUDIOBOOK-02 Gate D.5 — diagnóstico por conta Spotify e decisão de produto

Issue [#489](https://github.com/marksborn/sonoriza/issues/489). Esta PR será empilhada após Gate D.4 [#496](https://github.com/marksborn/sonoriza/pull/496). **Nada é executado em produção; sem merge/deploy, flags continuam OFF, sem alterações em playlists reais.**

## Decisão de produto

**Audiolivro inteiro dentro de uma playlist é controlado MANUALMENTE pelo usuário no Spotify.** O Sonoriza pode fornecer cálculo de duração virtual de um capítulo, prévia SHADOW e uma lista de faixas/episódios para incluir manualmente, **se** obtiver provas válidas dos dados necessários. O Sonoriza **não vai implementar, habilitar nem afirmar segurança para append/reorder/replace/delete automáticos em uma playlist com item de livro opaco**, porque `item=null` não comprova identidade ou preservação do livro. Mesmo um GET com snapshot estável e um perfil Spotify de país elegível NÃO revogam essa regra.

Não confundir:
1. **Mercado da conta Spotify** — pode ser obtido por GET `/me` quando o consentimento `user-read-private` é vigente (country é campo marcado *deprecated*, pode não ser devolvido);
2. **Acesso ao catálogo do livro** — GET `/audiobooks/{id}` + `/audiobooks/{id}/chapters` permite validar livro e capítulos, sujeito a permissões, mercado e conta. Mercado documentado por si só não prova disponibilidade de qualquer livro;
3. **Identidade do livro na playlist** — GET `/playlists/{id}/items` pode listar `item=null`, sem URI/ID do livro; identidade continua INVERIFICÁVEL;
4. **Segurança de escrita de playlist** — Spotify `POST /playlists/{id}/items` permite anexar faixas/episódios, mas sem CAS de snapshot no request. Não há prova de preservação de `item=null`. Portanto, o Sonoriza nunca fornece autorização de escrita a partir de qualquer diagnóstico.

## Mercado Spotify: documentação em 17/10/2026

Os endpoints de audiolivro e capítulo são documentados para `US, GB, CA, IE, NZ, AU` (Estados Unidos, Reino Unido, Canadá, Irlanda, Nova Zelândia, Austrália). **BR não consta**. País geográfico, IP, idioma ou localidade **não** provam o mercado da conta Spotify. Se o GET `/me` não devolver `country` válido, registrar **UNKNOWN** e abster-se; nunca usar a região física como fallback.

Referências oficiais:
- https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile
- https://developer.spotify.com/documentation/web-api/reference/get-an-audiobook
- https://developer.spotify.com/documentation/web-api/reference/get-audiobook-chapters
- https://developer.spotify.com/documentation/web-api/reference/get-a-chapter
- https://developer.spotify.com/documentation/web-api/reference/get-playlists-items
- https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist

## Entrega técnica

### Serviço puro e probe testável

`src/services/audiobooks/d5-account-capability.ts` mantém uma matriz **declarativa e tipada** com estados:
- `SPOTIFY_NOT_CONNECTED`
- `PROFILE_SCOPE_MISSING`
- `PROFILE_READ_FAILED`
- `ACCOUNT_MARKET_UNKNOWN`
- `MARKET_NOT_DOCUMENTED`
- `CATALOG_NOT_CHECKED`
- `CATALOG_READ_FAILED`
- `NO_PLAYABLE_CHAPTERS`
- `CATALOG_CHAPTERS_READABLE`

A decisão sempre tem `automaticPlaylistWritesAllowed=false`, `spotifyPlaylistPreservationGuaranteed=false`, `wholeBookIdentityInPlaylistVerified=false`, `productionApprovalGranted=false` e `existingBindingGuardsRemainRequired=true`. `catalogAccessibleForBook=true` é reservado para catálogo completo, livre de truncamento, IDs correspondentes e pelo menos um capítulo marcado como reproduzível; ainda requer validação de capítulo individual no fluxo existente.

`src/services/audiobooks/d5-account-capability-probe.ts` faz a orquestração com leitores `GET` injetados. Conta desconectada/permissão ausente **não gera chamadas externas**. Mercado desconhecido ou não documentado **não gera chamadas de catálogo**. O caminho de teste é independente de qualquer credencial real. Matriz de países usada também pelo ensaio D.4 para evitar divergências.

### Endpoint real (OFF em produção)

`POST /api/audiobooks/account-capability` disponível **somente** com `AUDIOBOOK02_BIND_UI_MODE=PREVIEW`, logado e same-origin, JSON estrito de `{}` ou `{spotifyAudiobookId: ID}` de 22 caracteres:
1. Verifica existência de `Account` `provider=spotify` ligado ao `session.user.id` e escopo armazenado `user-read-private`;
2. Caso habilitado, lê `GET /me` autenticado com token da conta vinculada. **Não expõe token, e-mail, nome nem outros campos de perfil ao navegador**, apenas o código de país e verdict.
3. Se e somente se o país constar na matriz documentada **e** o ID do livro tiver sido fornecido, consulta `readSpotifyAudiobookChapters(userId,id)` (somente GET e validador já existente).
4. Resposta `Cache-Control: no-store`; falhas do Spotify são representadas por estados de diagnóstico, sem raw provider PII/tokens.
5. **Não salva decisões no banco, não cria vínculos, não agenda geração, não altera a playlist.** Importante: o fluxo padrão `getSpotifyAccessToken` *pode* renovar e atualizar as credenciais OAuth quando necessário; isso NÃO altera o catálogo/playlist nem é um gate de aprovação.

### UI

`src/components/AudiobookCapabilityInspector.tsx` no assistente já experimental de audiolivros:
- botão explícito **Diagnosticar conta e catálogo**;
- país da conta, distinção documentação/API realmente consultada, causas de bloqueio e instrução adequada;
- não liga recursos adicionais, não oferece botão aplicar;
- reseta o diagnóstico quando o usuário muda a referência do livro;
- o fluxo existente de vínculo segue seu próprio validador e confirmação, protegido por fences dos gates B/D.

## Segurança e testes

- Suite pura prova que **nenhum** dos estados retorna `automaticPlaylistWritesAllowed=true`, inclusive quando o Spotify devolve capítulos válidos.
- Probes instrumentados verificam *zero GET* para conta desconectada/sem permissão e *zero GET de catálogo* para conta BR/sem país.
- Erros 403/429 simulados, perfil sem país, catálogos truncados ou de outro livro resultam em estados não autorizativos.
- Regressão dos Gates B/C/D/D.2/D.3/D.4, SSR offline, migrations PostgreSQL descartável, typecheck.
- `src/jobs/generate-playlists-incremental.ts` continua negando geração produtiva para qualquer lote com overlay; Spotify transport write fence B continua ativo conforme configuração.

## O que está pendente e não pode ser chamado de homologação real

- [ ] Consultar com autorização uma conta Spotify real para identificar seu mercado via `GET /me`, inclusive como o endpoint se comporta caso `country` esteja ausente/depreciado;
- [ ] Verificar leitura de livro/capítulos pela conta real, sem tentar forçar mercado via parâmetro incompatível com o token;
- [ ] Conferência manual da identidade do audiobook inteiro no Spotify e teste de UI em Chrome/Android em ambiente homologado;
- [ ] Aprovação explícita para merge, deploy ou flags. As PRs do stack continuam **Draft**.

**Encerramento do Gate D.5** significa: diagnóstico + decisão de produto + CI aprovados, **não** autorização para mutar playlists nem comprovação de funcionamento para uma conta Spotify BR. Qualquer proposta futura de valor manual alternativo (por exemplo, notas locais de capítulos informadas pela pessoa) deve ser uma nova issue explícita, com rastreabilidade/avisos próprios e sem inventar verificação por API.
