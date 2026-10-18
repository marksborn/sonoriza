# AUDIOBOOK-02 D.11 — ajuste do fluxo /show/ no mobile

Ref #489 e D.10 (#504).

## Problema
O formulário do catálogo oficial continuava visível como parte principal da página. Ao colar um /show/ de livro narrado, o diagnóstico D.5 exibia a restrição de mercado BR, confundindo o usuário: o cadastro manual D.10 já aceita /show/ e não depende da API /audiobook/.

## Ajuste de UX (sem ampliar permissões)
- Caderno manual é o caminho primário. A consulta por catálogo /audiobook/ fica em seção avançada fechada por padrão, com orientação explícita de mercado.
- Se o usuário colar /show/ na seção avançada, não rodar o diagnóstico D.5 do catálogo. Oferecer ação explícita que canonicaliza o link e abre o formulário manual já preenchido, via query param validado no servidor.
- Um botão opcional de exemplo pré-preenche 1984 /show/ e Apresentação (20,039 s), valores registrados na #489. Isso não consulta o Spotify, não salva automaticamente e não pressupõe presença do livro no destino. Confirmar os dados antes de salvar.
- Manter todas as validações D.7/D.9, CAS, owner, restrições de duração, flags e fences. Nenhum endpoint/write Spotify nem integração produtiva com planner foi modificado.
- O cabeçalho e as mensagens diferenciam claramente cálculo local, SHADOW opt-in e geração real bloqueada.

## Limites e aceite
1. No mobile, o formulário manual é encontrado antes do diagnóstico; o rodapé não deve cobrir o fim da página.
2. /show/ na consulta avançada -> transferência explícita e segura da referência para o formulário manual, sem buscar capítulos pela API de audiolivros.
3. Exemplos são opt-in, não salvam nem provam o conteúdo do Spotify.
4. Um caderno ativo não pode trocar livro/show via atalho sem passar pela validação existente; a proteção de playlist permanece.
5. Testes TS/CI necessários antes de merge/deploy; homologar em navegador Android e com uma conta real. Não autorizar escrita Spotify.
6. A simulação D.10 SHADOW permanece opt-in e a composição PRODUTIVA protegida ainda é trabalho de outro gate.
