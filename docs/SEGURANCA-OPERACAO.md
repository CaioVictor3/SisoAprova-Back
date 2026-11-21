# Operação dos controles de segurança

## Implantação e limites de confiança

Nenhuma configuração de ambiente foi alterada nesta implementação. Com Opção1, BACKEND_CORS_ALLOWED_ORIGINS deve estar ausente para herdar FRONTEND_APPLICATION_URL; vazio explícito não herda. Em produção, login/cadastro/recuperação e webhooks exigem XFF válido selecionado por BACKEND_TRUSTED_PROXY_HOP_COUNT confiável (1..10); zero, ausência/inválido retorna 503, sem balde global ou IP inventado. Confirmar a cadeia real de proxies e impedir acesso por caminho mais curto que permita spoof de XFF. Não confiar em Host/Origin para deduzir peer. Nenhum valor universal de hops é garantido pelo Render.

Em desenvolvimento, sem peer/IP confiável e com NODE_ENV diferente de production, login/cadastro/recuperação usam cota por email normalizado e persistente, com validação de formato. IP também é limitado quando confiável. Não existe a antiga chave direto global. A proteção por IP fica deliberadamente reduzida só no ambiente do servidor de desenvolvimento; OAuth sem identidade e sem IP não recebe cota IP fictícia. Nunca publicar serviço com NODE_ENV de desenvolvimento.

## Store local

node:sqlite exige Node >=22.16 (API ainda experimental em Node22; Node24 do Docker também suporta). Store lazy em .cache/seguranca/limites.sqlite relativo ao runtime (diretório precisa ser gravável; Dockerfile prepara /app/.cache/seguranca para o usuário node), diretório privado, chaves SHA256 sem guardar IP/email em claro, TTL60s, índice por expiração, transação BEGIN IMMEDIATE/WAL/busy_timeout e capacidade10k. Falha de lock/escrita/lotação retorna503, sem fallback permissivo. Cotas de auth:30/IP/min e10/email/min; ações por usuário validadas:30/min. Webhooks Resend/MP:600/IP/min antes da assinatura. Rejeição deve manter erro não2xx para que o provedor tente novamente; eventos só são aceitos após HMAC e persistência idempotente. Nenhuma carga real foi medida; revisar capacidade antes de produção.

Esse store compartilha processos no mesmo arquivo e persiste reinícios no mesmo disco. Não é distribuído entre instâncias. Render tem filesystem efêmero, portanto deploy/substituição pode zerar contagens. Antes de múltiplas instâncias, substituir via interface ArmazenamentoLimites por store comum aprovado; não há Redis/infra remota nova neste lote.

## Sessões, senha e CPF

Cookies HttpOnly são o único resultado de login/renovação, em /Navegador e /Autenticacao; aliases recebem proteção Origin+header web. Bearer externo segue aceito nas APIs de negócio/CLI e em logout verificado (getUser antes de admin.signOut); senha em Bearer retorna erro explícito, sem update nem200 silencioso. Mutação de senha exige cookies e reautenticação transitória pela senhaAtual, sem substituir cookies do usuário. O cliente transitório é encerrado com scope local e a troca termina com signOut global. Erro de revogação não é sucesso. Refresh revalida conta ativa; cookies ficam em staging até a resposta: sucesso pode emiti-los; qualquer falha converte cookies pendentes em expiração segura (mesmo nome/path), nunca publica tokens novos e preserva limpeza. O financeiro aplica a mesma política.

Revogação invalida refresh tokens no provedor. JWT de acesso já emitido pode persistir até expiração; não foi introduzida denylist remota nem se promete invalidação instantânea. Claim recovery é obtida via getClaims com assinatura/expiração verificadas, nunca por user_metadata. Handler geral/aliases e financeiro aplicam guard; ambas representações AMR recovery são aceitas. A01/concluir-google não foi alterado.

CPF da conta é devolvido mascarado no campo cpf, inclusive após atualização. Omitir/null no update preserva CPF interno, sem devolver o original; informar máscara não substitui CPF. Novo CPF completo passa validação existente. Usuario/listar tem pagina/quantidadePorPagina (até100), busca por nome OU email e tipo/estadoCadastro/cadastroCompleto, com ordenação estável e count no servidor.

## Banco e superfície

Migration local restringe SELECT de questoes a colunas explícitas atuais sem explicacao. NÃO aplicada ao banco. Aplicação exige revisão do esquema/grants efetivos e autorização separada; não usar rollback que restaure SELECT amplo. RPCs existentes de correção/explicação continuam sob suas verificações de autorização. Sem confirmação remota de grants neste lote.

A raiz GET / é uma landing pública com HTTP 200 em desenvolvimento e produção: título Siso Aprova API e mensagem de funcionamento em HTML estático, legível sem JavaScript ou CSS. O proxy da raiz faz passagem direta, sem consultar sessão, variáveis ou serviços do Supabase, mesmo com cookies recebidos. A mensagem confirma a resposta HTTP da API, não a saúde do banco ou dos provedores. Em produção não há links Swagger, versão, ambiente, endpoints ou stack no conteúdo; a CSP permanece default-src none. Dev mantém o link /swagger. Swagger/OpenAPI continuam indisponíveis em production: /api/docs, seus subcaminhos e /api/openapi.json retornam 404; /swagger redireciona para /api/docs (404). Esta abertura da landing é demanda posterior à decisão histórica #7; o adendo arquitetural é mantido pela coordenação. Headers incluem CSP, HSTS só produção, XFO DENY, Referrer e Permissions. CSP de Swagger permite apenas assets/conexões locais e style inline necessário; JSON usa default-src none. OAuth/MP continuam navegando para provedores, sem iframe permitido no backend. Habilitação de HIBP/SMTP/provider do Supabase depende de configuração cloud e não foi modificada.

## Runtime e verificações

Express/roteadores/auth HTTP legados e dist/ foram retirados após conferir importações, scripts, tsconfigs e comandos; workers continuam entrypoints próprios e não são iniciados por npm start. test:all agora roda tipos, mocks e contrato ativo; scripts de testes ausentes .NET/Postgres foram removidos em vez de declarar execução fictícia. check:parity verifica contratos atuais e não preserva a antiga promessa de paridade .NET.

Build de revisão deve ocorrer em cópia isolada SEM .env/.next existentes, para não reescrever .next/standalone/.env protegido. Não executar npm build no checkout até tratar A03 em demanda própria. A01 e A03 estão fora deste lote.

## Referências verificadas

- [Supabase getClaims](https://supabase.com/docs/reference/javascript/auth-getclaims) e [JWT AMR](https://supabase.com/docs/guides/auth/jwt-fields): claims verificadas para restrição de recuperação.
- [Supabase admin.signOut](https://supabase.com/docs/reference/javascript/auth-admin-signout): revogação com JWT válido. Revogar refresh não garante expiração imediata de access JWT.
- [Resend retries](https://resend.com/docs/webhooks/retries-and-replays): tentativas com backoff após falhas; falhas persistentes podem desabilitar endpoint.
- [Mercado Pago webhooks](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-orders/resources/notifications/webhooks): confirmação200/201 e retry sem confirmação; não responder sucesso a evento recusado pelo limite.
- [Render proxies](https://render.com/articles/how-render-handles-ddos-attacks): XFF depende da cadeia confiável; não há hops universal assumido pelo código.
