# Contrato JSON de importação de provas

Use [prova.modelo.json](prova.modelo.json) como ponto de partida. Cada arquivo descreve um caderno e contém de 1 a 250 questões objetivas.

## Prova

| Campo | Formato |
| --- | --- |
| `prova.ano` | Ano de aplicação, inteiro com quatro dígitos. |
| `prova.uf` | Sigla brasileira em maiúsculas, como `AC`. Use `null` quando a prova for nacional ou a UF não estiver disponível. |
| `prova.orgao` | Nome do órgão responsável. |
| `prova.cargo` | Cargo, especialidade ou identificação do caderno. Pode ser omitido. |
| `prova.organizadora` | Nome da banca. Para apontar para uma banca cadastrada pelo UUID, use `prova.idOrganizadora` no lugar do nome. |

Para acrescentar números inéditos a uma prova com composição em aberto, substitua o objeto `prova` por `idProva` no nível raiz. Nesse formato, ano e UF vêm da prova existente. Arquivos antigos sem `uf` continuam válidos.

## Questões

Cada elemento de `questoes` contém o número original e único no caderno em `numero`, o texto em `enunciado` e de 2 a 10 `alternativas` com `letra` de A a J e `texto`. Use `tema` com o nome do catálogo ou `idTema` com o UUID. `idTemaPadrao` no nível raiz serve para questões sem tema próprio.

| Campo | Formato |
| --- | --- |
| `statusGabarito` | `definitivo`, `provisorio`, `anulada` ou `pendente`. O padrão é `pendente`. |
| `letraCorreta` | Letra presente nas alternativas para gabarito definitivo ou provisório. Omita nas anuladas e pendentes. |
| `fonte`, `fonteGabarito` | Referências opcionais ao caderno e ao documento do gabarito. |
| `dificuldade` | `facil`, `media`, `dificil` ou `nao_informada`. |
| `imagemUrl`, `explicacao` | URL HTTP(S) e texto explicativo opcionais. |

Para conteúdo regional, classifique pelo enunciado como **História** ou **Geografia** e preencha a UF na prova. A UF identifica a origem do caderno. Os 12 temas adicionados são Administração Pública, Atualidades, Ciências da Natureza, Ética e Filosofia, Fundamentos de Odontologia, Geografia, História, Informática, Legislação Policial Militar, Língua Portuguesa, Matemática e Raciocínio Lógico-Matemático.

## Integração

- No frontend, **Admin → Provas → Importar JSON** oferece o modelo para download, a prévia e a confirmação. Ao alterar o modelo compartilhado, atualize também a cópia distribuída com o frontend em `ConcursaAI/src/pages/administracao/prova.modelo.json`.
- A API administrativa aceita `POST /api/administracao/provas/importar` com um corpo `{"aplicar": false, "arquivo": {...}}` para validar. Envie `aplicar: true` para gravar o caderno como rascunho. A prévia informa as bancas e os temas que precisam ser cadastrados.
- O backend implementa o contrato em `ConcursaIA.BackNode/src/application/importacao-prova.service.ts`. O cadastro manual e a listagem de provas também expõem a UF.
