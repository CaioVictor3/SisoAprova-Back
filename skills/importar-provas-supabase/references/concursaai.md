# Integração ConcursaAI

## Contrato e acesso

Localize `compartilhado/importacao-provas/prova.modelo.json` no workspace ou no backend. A implementação vigente está em `ConcursaIA.BackNode/src/application/importacao-prova.service.ts`. Leia as migrations do importador e o esquema do ambiente antes da operação. Para prova nova use `prova.ano`, `prova.uf`, órgão, cargo e banca. Use `idProva` para inserir números novos em um rascunho existente autorizado. Preserve números originais, temas História e Geografia e a UF na prova. Use `fonte` para o caderno e a página e `fonteGabarito` para PDF, página física e cabeçalho. O importador atual aceita até 250 questões por chamada. Uma prova maior requer capacidade transacional adequada antes da carga.

- Use o conector Supabase para inventário e consultas de verificação. Confira se o destino corresponde à API e à configuração do projeto. Para funções e Storage, consulte a [documentação oficial](https://supabase.com/docs/guides/storage).
- Grave pelo `POST /api/administracao/provas/importar` com corpo `{"aplicar": false, "arquivo": ...}` para prévia e `aplicar: true` para escrever. Use sessão de administrador do app ou token temporário de administrador aceito pelo backend. O backend chama a RPC e preserva as regras de criação e rollback do lote. Mantenha segredos no ambiente e fora de comandos exibidos, logs, manifestos e arquivos distribuídos.
- Antes de repetir uma carga, busque prova por órgão, ano, UF, banca e cargo e compare os números já persistidos. Para corrigir uma questão existente, siga a edição administrativa autorizada. A importação de novos números preserva a composição e o histórico já gravados.

## Imagens no Storage

Use o bucket aprovado para entrega aos alunos. Use o SDK ou a API oficial de Storage no servidor e aplique permissões de escrita restritas. Confira a política de leitura na sessão de aluno. Para conteúdo público autorizado, use URL estável de leitura do bucket. Se for privado, use caminho estável com resolução autenticada já implementada pelo aplicativo. URL assinada de curta validade não é valor persistente. Se faltar entrega autenticada, mantenha o material preparado até o app suportá-la.

Use chaves como `provas/rn/2022/<caderno>/q018-<sha256>.png` com hash dos bytes finais, extensão e MIME coerentes, sem sobrescrita. Reuse um objeto já presente apenas quando os bytes corresponderem. Confronte o download em tamanho, MIME e SHA-256, além da legibilidade do recorte quando exibido no app. Use PNG ou WebP legível e imagens carregadas junto à questão. Verifique o suporte a `imagemUrl` na administração, na resolução e na correção. Se a versão publicada não renderizar o campo, mantenha a prova como rascunho e reporte essa dependência.

Storage e Postgres têm operações distintas. Registre quais objetos a execução criou. Se a gravação falhar, reconcilie o banco primeiro. Preserve objetos reutilizados e referenciados. Limpe somente objetos recém-criados e comprovadamente sem referência quando a limpeza estiver dentro do escopo. Em caso de estado incerto, registre as chaves para recuperação.

## Manifesto de conferência

Monte este JSON a partir do caderno e do gabarito, separadamente do JSON de importação. Preencha o conjunto exato de números esperado com base no caderno completo. Cada item registra a resposta da leitura conferida do gabarito e o recurso visual aprovado, quando houver.

```json
{
  "numerosCaderno": [17, 18],
  "questoes": [
    {
      "numero": 17,
      "paginaCaderno": 6,
      "paginaGabarito": 25,
      "secaoGabarito": "Odontopediatria, tipo 01, branca",
      "statusGabarito": "anulada",
      "imagem": null
    },
    {
      "numero": 18,
      "paginaCaderno": 6,
      "paginaGabarito": 25,
      "secaoGabarito": "Odontopediatria, tipo 01, branca",
      "statusGabarito": "definitivo",
      "letraCorreta": "B",
      "imagem": {
        "arquivo": "recortes/q018.png",
        "sha256": "<sha256 dos bytes revisados>",
        "url": "https://<projeto>.supabase.co/storage/v1/object/public/<bucket>/<chave>"
      }
    }
  ]
}
```

Exemplo fictício. `imagem: null` registra a inspeção de que a questão pode ser resolvida sem arquivo visual. O caminho da imagem é relativo ao manifesto. A URL pode ficar ausente até o upload. Depois de conferir o objeto remoto, copie a URL também para `imagemUrl` no item do JSON de importação. Remova pendências de extração somente após resolvê-las.

Execute `python3 scripts/conferir_lote.py MANIFESTO.json LOTE.json` durante a preparação. Use `--pronto` para exigir a URL final em cada item visual. São verificações estruturais e de integridade local. A leitura das fontes, a validação remota e a verificação do app continuam necessárias.

## Leitura após gravar

Use `concursos` ou a view `provas` para ano, UF e metadados. Use `questoes."idConcurso"` e `numero` para enumerar questões e comparar `imagem_url`. Cruze `alternativas."idQuestao"` com as questões e `gabaritos."idAlternativaCorreta"` com a alternativa da própria questão. A situação `pendente` no contrato corresponde à ausência de linha de gabarito na operação atual. Compare `fonte_gabarito` quando fornecida e confirme `rascunho` e composição em aberto.

## Ordem da gravação

1. Valide o conteúdo localmente. O verificador compara numeração, situação, letra e integridade dos recortes. A prévia da API também valida regras do contrato e referências. Revise os resultados de ambas as verificações.
2. Antes de enviar objetos, confirme que a API está atendendo à rota de importação e que o projeto e o bucket correspondem ao ambiente autorizado. Confira se os metadados identificam um único caderno. Quando a edição possuir variantes identificáveis, preserve essa distinção no campo de identificação do caderno aceito pelo contrato. Em caso de colisão com prova existente, identifique o registro antes de decidir entre anexar números, corrigir um rascunho ou preparar outro caderno.
3. Mantenha um registro local dos objetos esperados com questão, chave, tamanho, MIME e SHA-256. Após o upload, registre a URL verificada e se cada objeto foi criado nesta execução ou reutilizado. Para verificar o conteúdo, baixe o objeto pelo caminho de leitura previsto e compare o hash dos bytes. Um código HTTP de sucesso por si só não comprova que a URL aponta para o recorte certo.
4. Complete `imagemUrl` no JSON. Execute `conferir_lote.py --pronto MANIFESTO.json LOTE.json` e valide a mesma versão na API. Se alterar o JSON após a prévia, valide novamente. Confira se o resumo da API corresponde às quantidades e situações do manifesto.
5. Faça uma chamada com `aplicar: true` por caderno. Registre o resultado e o ID retornado. Na releitura, percorra todas as páginas quando a API limitar resultados. O total da primeira página e a quantidade gravada são medidas diferentes.

## Falhas e retomada

| Situação | Próxima ação |
| --- | --- |
| Prévia recusada | Corrija o campo ou referência indicado e revalide o mesmo caderno. |
| Upload interrompido | Confira as chaves previstas. Reuse os objetos que passarem na conferência de hash e envie apenas os que faltarem. |
| Chave já existe com bytes diferentes | Preserve o objeto existente. Confira o arquivo de origem e a chave calculada antes de continuar. |
| A gravação foi rejeitada | Confira se a transação reverteu e se algum objeto ficou sem referência. Preserve o registro das chaves para retomar. |
| Timeout ou resposta perdida depois de enviar | Localize o caderno e leia todos os números e vínculos antes de reenviar. Se corresponderem ao lote, registre o ID e conclua a reconciliação. Se houver diferenças, identifique o estado antes de corrigir. |
| Imagem gravada que não aparece ao aluno | Teste a URL no contexto do aplicativo e confira se o frontend renderiza o campo. Mantenha o rascunho até resolver a causa. |

Para concluir a releitura, compare cada questão com o manifesto e com o JSON final. Uma contagem idêntica pode esconder uma substituição de número ou um vínculo incorreto. Para cada resposta com letra, confirme que a alternativa apontada pertence à mesma questão. Para anuladas, confirme a ausência de alternativa correta. Compare as imagens inclusive nos itens sem recurso visual, que devem ficar sem URL.
