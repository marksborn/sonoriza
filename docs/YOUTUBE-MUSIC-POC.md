# YTM-01 — PoC: playlist compartilhada YouTube e YouTube Music

**Status:** branch de investigação. Não altera autenticação, playlists, banco ou runtime do Sonoriza em produção.
**Issue:** #476. **Dependências arquiteturais:** #207 e #374. Respeitar #278. Não reabrir #146 (Pulse), encerrada como Not planned.

## Hipótese a comprovar

A ajuda oficial confirma que playlists do YouTube Music aparecem na biblioteca do YouTube. Playlists do YouTube exibem no YouTube Music apenas conteúdos elegíveis. Podcasts são suportados no YouTube Music, mas **isso não prova que episódios reproduzam dentro de uma playlist mista comum criada via API**.

Um só playlistId deverá ser testado nas duas superfícies:
- https://www.youtube.com/playlist?list=PLAYLIST_ID
- https://music.youtube.com/playlist?list=PLAYLIST_ID

Resposta da YouTube Data API **não prova** visibilidade, ordem, reprodução ou categorização como podcast no YouTube Music. Todos os itens permanecem NOT_VERIFIED até observação humana no aplicativo.

## Endpoints e cotas — documentação verificada em 14/10/2026

| Método | Custo |
|---|---:|
| playlists.list / playlistItems.list | 1 unidade por página |
| playlists.insert | 50 unidades |
| playlistItems.insert / delete / update | 50 unidades por chamada |

A documentação atual estabelece, por padrão, 10.000 unidades/dia para endpoints gerais, e um bucket separado para search.list (100 chamadas diárias no padrão). O painel do **Google Cloud do projeto real prevalece**.

Exemplo: adicionar 120 músicas custa 6.000 unidades; remover 120 e inserir outras 120 custa 12.000, ultrapassando a cota geral padrão. O futuro publicador precisará calcular diffs, evitar no-op, estimar custo antes de escrever e falhar fechado quando não houver orçamento suficiente.

Fontes oficiais:
- https://developers.google.com/youtube/v3/determine_quota_cost
- https://developers.google.com/youtube/v3/docs/playlists/list
- https://developers.google.com/youtube/v3/docs/playlists/insert
- https://developers.google.com/youtube/v3/docs/playlistItems/list
- https://developers.google.com/youtube/v3/docs/playlistItems/insert
- https://developers.google.com/youtube/v3/docs/playlistItems/delete
- https://support.google.com/youtubemusic/answer/7205933?hl=pt-BR
- https://support.google.com/youtube/answer/12751636?hl=pt-BR

## Script isolado

O arquivo scripts/youtube-music-poc.mjs usa Node.js >= 20, sem dependências nem IA. A ferramenta é **read-only por padrão**, faz chamadas apenas para a API oficial HTTPS do Google e não armazena tokens.

### Sem credenciais e sem rede

~~~bash
node scripts/youtube-music-poc.mjs quota --adds 120 --removes 120 --reads 4
node scripts/youtube-music-poc.mjs links --playlist-id PLAYLIST_ID
node --test scripts/youtube-music-poc.test.mjs
~~~

### Leitura real (somente com a conta/canal de TESTE)

Habilitar YouTube Data API v3 em projeto Google Cloud de teste e obter localmente um token OAuth do canal correto com escopo youtube.readonly. O OAuth de Calendar já existente no Sonoriza **não** concede escopos YouTube. Não colocar o token em chat, commits, arquivos de projeto, logs ou prints.

~~~bash
export YT_POC_ACCESS_TOKEN="TOKEN_TEMPORARIO_DO_CANAL_DE_TESTE"
node scripts/youtube-music-poc.mjs mine
node scripts/youtube-music-poc.mjs inspect --playlist-id PLAYLIST_ID
~~~

O script não cria refresh tokens; tokens temporários expiram. Não mexer em AUTH_GOOGLE_ID nem em nenhum consentimento atual do Sonoriza.

### Escrita de teste (explicitamente bloqueada por padrão)

A modalidade create-test **simula** e calcula cota sem --execute. Substituir os IDs abaixo por IDs válidos de vídeo YouTube, cada um com 11 caracteres. Só fazer o teste em conta pessoal ou canal dedicado ao experimento, com escopo OAuth de escrita como youtube.force-ssl e aprovação explícita do operador.

~~~bash
node scripts/youtube-music-poc.mjs create-test \
  --title "Sonoriza YTM-01 PoC" \
  --videos VIDEOID0001,VIDEOID0002,VIDEOID0003

# Somente para o canal de TESTE: executar após conferência.
export YT_POC_ALLOW_WRITES=YES_PRIVATE_TEST
node scripts/youtube-music-poc.mjs create-test \
  --title "Sonoriza YTM-01 PoC" \
  --videos VIDEOID0001,VIDEOID0002,VIDEOID0003 \
  --execute
~~~

A playlist criada é sempre **privada**. O programa informa o playlistId imediatamente depois da criação e registra inclusões individualmente: uma falha pode deixar uma playlist de teste parcial. Não há exclusão automática e **nunca** se aplica a playlists existentes. Aceita no máximo 10 itens de teste.

## Matriz de compatibilidade mista — obrigatória

Preparar uma sequência em uma única playlist, com vídeos reais:
1. Música A — vídeo oficial/art track.
2. Episódio completo de programa **elegível** como podcast no YouTube Music, confirmado individualmente.
3. Música B.
4. Vídeo de conversa que não seja conteúdo musical nem episódio elegível.
5. Música C.

**Não** marcar a playlist mista do Sonoriza como podcast. No YouTube o show de podcast é uma playlist do criador com episódios completos; isso é diferente de uma playlist pessoal com conteúdos variados.

| Validação | YouTube web | YouTube Android | Music web | Music Android |
|---|---|---|---|---|
| Mesmo playlistId abre | PENDENTE | PENDENTE | PENDENTE | PENDENTE |
| Itens visíveis (A/Podcast/B/Vídeo/C) | PENDENTE | PENDENTE | PENDENTE | PENDENTE |
| Ordem e reprodução real | PENDENTE | PENDENTE | PENDENTE | PENDENTE |
| Duração efetivamente reproduzível | PENDENTE | PENDENTE | PENDENTE | PENDENTE |
| Retomada e reprodução em segundo plano | PENDENTE | PENDENTE | PENDENTE | PENDENTE |
| Playlist criada pela API aparece | PENDENTE | PENDENTE | PENDENTE | PENDENTE |

Repetir com playlist originalmente criada no aplicativo YouTube Music. Testar níveis de privacidade separadamente. Registrar IDs, resultado, data, dispositivo, erros e capturas sem expor credenciais.

Se o YouTube Music omitir podcast ou alterar duração/ordem, marcar como capacidade parcial; **nunca** declarar meta de tempo ou percentual de podcast cumprida silenciosamente. Seguir com podcasts no Spotify até provar comportamento equivalente.

## Entrega e decisão

Entregue nesta branch:
- CLI isolada para listar playlists e inspecionar uma playlist da conta de teste;
- links das duas plataformas usando o mesmo ID;
- cálculo de orçamento, simulação de escrita, criação privada somente após desbloqueio;
- testes locais da regra de quota, IDs e classificação NOT_VERIFIED.

Pendente para conclusão da issue:
- OAuth real e seleção do canal de teste;
- leitura de playlist real e criação da playlist privada;
- teste humano de reprodução mista nos quatro ambientes;
- inventário da integração com os consumers Spotify e #374;
- revisão de políticas do Google/Spotify, provenance e consentimento;
- decisão GO / RESTRIÇÕES / NO-GO independente para fonte e destino.

**Nenhuma migração, integração produtiva, chamada real a APIs ou modificação de playlists do usuário foi realizada neste gate.**
