# AUDIOBOOK-02 — D.12: um livro global em múltiplas playlists

Issue #489; sucede D.11 (PR #505). **Decisão explícita:** o mesmo livro pode participar simultaneamente de quantas playlists do Sonoriza o usuário escolher. Um livro ativo por usuário; capítulo/progresso compartilhados globalmente.

## Limitação histórica corrigida
D.7 criava caderno 1:1 por `TargetPlaylist` com destino FIXED obrigatório; D.10 só calcula a simulação SHADOW para FIXED/MANUAL/PROPORTION. Essas condições são hipóteses técnicas de seus gates, **não regras de elegibilidade de audiolivro**. Os exemplos de 5 min e 600 min não definem requisitos de produto.

## Novo modelo (aditivo, sem backfill automático)
- `UserAudiobookLibraryReading`: entidade por **leitura** do usuário (título, show Spotify `/show/` declarado, capítulo/duração/consumo, revision/CAS, conclusão). Índice SQL parcial UNIQUE(userId) WHERE completedAt IS NULL garante **apenas uma leitura ativa por usuário**, mesmo sob concorrência.
- `UserAudiobookLibraryEntry`: snapshots append-only de cada revisão do capítulo; nenhuma atualização retroativa, registro preservado depois de concluir.
- `UserAudiobookLibraryTarget`: cada uso do livro num destino tem `targetPlaylistId` e **snapshot do verdadeiro SpotifyPlaylistId**, com marcador de proteção remota perene. Pode haver 0, 1 ou N destinos por leitura, inclusive FIXED e CALENDAR. O mesmo show não é reinterpretado como audiobook oficial pelo Spotify. O mesmo Spotify playlist ID não pode duplicar dentro de uma leitura.
- **Não há FK da associação para TargetPlaylist**: apagar/renomear destino não é evidência de remoção do livro no Spotify, nem retira proteção; FK para leitura e usuário mantém ownership e cascata de privacidade.
- D.7/D.9 antigos permanecem sem alterações destrutivas. Usuários com notebook antigo devem completar/revisar manualmente o estado antes de usar o fluxo D.12. Não inventar migração a partir de cadernos possivelmente ambíguos. A UI oferece o modo antigo enquanto houver caderno.
- Migração `20261018013000_audiobook_d12_global_multi_target`: somente CREATE TABLE/INDEX/FK/CHECK/TRIGGER; sem alterações de playlist/remapeamentos, sem backfill. Aplicar em ambiente descartável no CI; deploy separado com backup e autorização.

## API e UX opt-in
Flag `AUDIOBOOK02_MULTI_TARGET_MODE=ACTIVE` **OFF por padrão** exige todas flags de D.7 + D.9: UI PREVIEW, preview D.6, notebook ACTIVE, write fence ACTIVE e SINGLE_READING ACTIVE.
`GET/POST /api/audiobooks/library` exige sessão; POST exige Origin/Host e payload estrito. Ações:
- START: inicia livro manual único sem escolher uma playlist.
- UPDATE: capítulo/progresso compartilhados, CAS + histórico imutável.
- ATTACH: exige confirmação explícita `CONFIRMO_PROTEGER_PLAYLIST_ANTES_DA_INCLUSAO`. **O vínculo e o bloqueio durável devem ser registrados ANTES da inclusão do livro no Spotify**, para não existir janela insegura em que o Sonoriza ainda pode sobrescrever a playlist. O usuário, só depois da confirmação, adiciona o livro inteiro manualmente ao Spotify. Se o livro já estiver presente, protege imediatamente (não é prova de presença remota). Não envia áudio ao Spotify nem invoca APIs de escrita.
- COMPLETE: marca leitura concluída, preservando todas as revisões e **todos os vínculos/marker**. Nenhuma função de desassociação foi liberada: criar confirmação por botão para remover remoto sem evidência poderia liberar write e apagar livros.
- GET lista livro atual, destinos, capítulos anotados e concluídos.

O navegador mostra todas as playlists Spotify associadas a destinos do Sonoriza (não filtra FIXED). Playlist FIXED apresenta orçamento virtual calculado **somente na UI**; CALENDAR informa que o orçamento depende da janela/eventos reais. O capítulo contado é global, mas orçamento sempre depende da playlist. Associação não adiciona livro ao Spotify.

## Guardas obrigatórios
- `write-admission-store.begin`: todo item de playlist vinculado à biblioteca é bloqueado ANTES de escrita.
- `SpotifyClient`: consulta DB sobre associação D.12 independente de feature flag, em cada tentativa/retry.
- `withAudiobookOverlayBindAdmission` e `withAudiobookTargetSettingsAdmission`: recusam vínculos/configuração protegidos; locks do fence serializam concorrência.
- `generate-playlists-incremental.ts`: aborta lote REAL inteiro antes de coletar e escrever, mesmo com flag D.12 desligada.
- O sistema não consegue identificar remotamente um livro opaco de modo confiável nem aplicar patch preservador em todas as playlists. Até prova técnica e gate separado, geração automática e KEEP_FILLED/REBUILD_DAILY permanecem bloqueados nesses destinos protegidos.

## Invariantes e rollback
- Banco bloqueia proveniência diferente de USER_DECLARED_UNVERIFIED, durações inválidas, alterações ao histórico; conclusão mantém marcadores.
- Ao desligar D.12, os marcadores permanecem ativos nos guards; **não** há downgrade que restaure escrita no Spotify.
- Depois de concluir, associar novo livro a uma playlist já protegida por outro livro é recusado até um gate de reconciliação segura do estado remoto. Não concluir que concluir no Sonoriza remove o livro real da playlist.
- Pode-se cadastrar livro sem playlist. Um capítulo não tem orçamento global; só projeções por destino.
- Não executar alteração no Spotify, não acionar geração real nem alterar .env nesta PR.

## Aceitação / homologação
- [ ] CI PostgreSQL descartável, constraints/índice parcial, fluxo START/UPDATE/CAS/ATTACH 2 destinos FIXED + CALENDAR/COMPLETE e flags.
- [ ] CI typecheck + Next.js production build e demais workflows.
- [ ] Android: iniciar 1984, **proteger cada playlist antes de adicionar o livro no Spotify**, adicionar livro inteiro manualmente aos destinos e trocar capítulo uma vez para observar o mesmo estado em ambas.
- [ ] Verificar bloqueio de SpotifyClient, configuração de destino, geração real e archive mesmo com flag OFF.
- [ ] Homologar calendário com duração resolvida no runtime **em gate futuro**, sem inventar dados de duração.
- [ ] Homologar com usuário real, sem fazer deploy ou ligar flag sem aprovação expressa.
