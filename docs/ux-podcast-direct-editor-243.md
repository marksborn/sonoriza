# UX #243 — editor direto de podcast

Ajustes desta revisão:

- o card de **Músicas Curtidas** permanece somente na rota principal de Fontes e não aparece em `/dashboard/configuracao/fontes/podcasts`;
- o modo direto de edição omite o cabeçalho geral de Políticas de podcasts;
- o editor direto mostra navegação curta para **Fontes** e **Todos os programas**;
- o resumo completo do card não é repetido antes do formulário no modo direto;
- existe um único controle `episodeOrder`, rotulado como **Ordem dos episódios**;
- a variável local morta `directMode` foi removida;
- nenhuma regra do planner, policy store, banco ou Spotify foi alterada.
