# Configuração da API

Em desenvolvimento, configure `.env` na raiz de `ConcursaIA.BackNode` usando `.env.example` como base. A API, os workers e os scripts leem esse arquivo. Na hospedagem, defina as variáveis no ambiente de cada processo.

| Variável | Finalidade |
| --- | --- |
| `FRONTEND_APPLICATION_URL` | Origem da interface para CORS e links de autenticação, sem caminho ou barra final. Pode ficar vazia quando a API atende apenas clientes sem navegador. |
| `SUPABASE_PROJECT_URL` | URL raiz do projeto Supabase, sem `/rest/v1` ou `/auth/v1`. |
| `SUPABASE_PUBLISHABLE_API_KEY` | Chave usada pelo servidor para autenticação e consultas com a sessão do usuário. |
| `SUPABASE_SERVER_SECRET_API_KEY` | Chave privada para operações administrativas, workers e verificação de prontidão. |

O frontend chama a API pela origem de `BACKEND_API_BASE_URL`, configurada no build da interface. Para desenvolvimento, use `http://localhost:3000` na API e abra `http://localhost:5173` na interface. Use o mesmo nome de host nos dois endereços para que o navegador envie os cookies da sessão local.

## Produção

1. Configure as chaves do Supabase e das integrações no Web Service do Render. O serviço fornece uma URL HTTPS em `onrender.com`. Use essa URL em `BACKEND_API_BASE_URL` e na configuração dos webhooks.
2. Cadastre a origem HTTPS da interface em `FRONTEND_APPLICATION_URL`. Se usar `BACKEND_CORS_ALLOWED_ORIGINS`, inclua a origem da interface na lista.
3. No Supabase Auth, configure o Site URL do frontend e adicione as rotas `/autenticacao/google`, `/autenticacao/confirmar-email` e `/autenticacao/redefinir-senha` com a URL pública completa da interface. Configure o SMTP do Supabase Auth para confirmar contas e recuperar senhas. [URLs de retorno](https://supabase.com/docs/guides/auth/redirect-urls) e [SMTP do Supabase](https://supabase.com/docs/guides/auth/auth-smtp).
4. Para receber pagamentos reais, use as credenciais de produção, configure `MERCADO_PAGO_ENVIRONMENT=producao` e `MERCADO_PAGO_PRODUCTION_ENABLED=true`. O webhook aponta para `/api/financeiro/webhook` na API. `MERCADO_PAGO_CHECKOUT_RETURN_URL` aponta para `/pagamento/retorno` na interface.
5. Para e-mails transacionais, configure as credenciais Resend e execute o worker de e-mails com `TRANSACTIONAL_EMAIL_WORKER_ENABLED=true`. O webhook do Resend aponta para `/api/ResendWebhook/registrar-evento-entrega` na API.

A sessão em produção usa cookies HTTPS, HttpOnly e particionados. Quando os serviços estiverem em sites distintos, o navegador precisa aceitar cookies particionados. Para suportar navegadores antigos que bloqueiam cookies entre sites, publique a interface e a API em subdomínios do mesmo domínio, como `app.seu-dominio.com` e `api.seu-dominio.com`. A API pode continuar hospedada no Render. [Cookies particionados](https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies/Partitioned_cookies)

## Ajustes opcionais

- `BACKEND_CORS_ALLOWED_ORIGINS` substitui a lista de origens permitidas. Por padrão a lista contém `FRONTEND_APPLICATION_URL`. Para aceitar mais de uma origem, inclua a do frontend e separe os valores por vírgulas.
- `BACKEND_LOG_LEVEL` usa `info` por padrão. `BACKEND_TRUSTED_PROXY_HOP_COUNT` usa `0`. Configure a contagem conforme a topologia do proxy.
- A análise de questões usa `OPENAI_API_KEY` e, por padrão, `OPENAI_MODEL_NAME=gpt-4.1-mini`. Para estimar custos, informe `OPENAI_INPUT_PRICE_PER_MILLION_TOKENS_USD` e `OPENAI_OUTPUT_PRICE_PER_MILLION_TOKENS_USD` para o modelo contratado.
- Para o worker de e-mails, configure `RESEND_API_KEY` e `RESEND_SENDER_EMAIL_ADDRESS`. O webhook usa `RESEND_WEBHOOK_SIGNING_SECRET`. `TRANSACTIONAL_EMAIL_WORKER_ENABLED=false` desativa os envios do worker. Os valores padrão de processamento e dos fluxos estão em [configuracoes-ambiente.ts](../src/config/configuracoes-ambiente.ts).
- `AUTHENTICATION_LEGACY_TOKEN_SIGNING_KEY` preserva links antigos cifrados na fila de e-mails. Se já tiver esses links, conserve o valor original em base64.
- Para pagamentos, consulte [a configuração do Mercado Pago](mercado-pago.md). Para importação administrativa, forneça um token temporário em `ADMINISTRATIVE_IMPORT_ACCESS_TOKEN` e configure `BACKEND_API_BASE_URL` se quiser usar outro endereço de API.
- `INTEGRATION_TEST_API_BASE_URL` permite apontar `npm run check:integration` para outra porta local da API. O padrão é `http://localhost:3000`.

O runtime Next.js e os workers consultam a Data API do Supabase. `POSTGRESQL_CONNECTION_URL` e os ajustes `POSTGRESQL_*` atendem apenas aos utilitários e à implementação legada de PostgreSQL.

Para migrar uma instalação que já usa variáveis privadas na hospedagem, mantenha os valores e atualize os nomes conforme o exemplo. Em particular, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` e `SUPABASE_SECRET_KEY` passam a usar os nomes da tabela acima. `AUTH_CLIENT_URL` passa a ser `FRONTEND_APPLICATION_URL`.

## Servidor de e-mails transacionais (Resend e Supabase Auth)

### 1. Domínio próprio e DNS no Resend
- Cadastre e verifique o domínio remetente no painel do Resend (ex.: `notificacoes.seu-dominio.com` ou `seu-dominio.com`).
- Publique no provedor de DNS os registros exigidos pelo Resend:
  - **SPF** (`TXT` e `MX` do subdomínio de envio/bounce indicado pelo Resend);
  - **DKIM** (`TXT` `resend._domainkey`);
  - **DMARC** (`TXT` `_dmarc`, ex.: `v=DMARC1; p=none;`).
- Configure `RESEND_SENDER_EMAIL_ADDRESS` com um endereço pertencente ao domínio verificado e `RESEND_SENDER_DISPLAY_NAME=Siso Aprova`.

### 2. API Key e Webhook de eventos do Resend
- Gere uma API Key com permissão de envio no Resend e defina `RESEND_API_KEY`.
- No painel do Resend (**Webhooks**), cadastre o endpoint HTTPS da API:
  - **URL**: `https://<sua-api>/api/ResendWebhook/registrar-evento-entrega`
  - **Eventos**: `email.delivered`, `email.bounced`, `email.complained` e `email.failed`.
- Copie o segredo de assinatura Svix (`whsec_...`) para `RESEND_WEBHOOK_SIGNING_SECRET`.

### 3. Processamento da fila: Cron HTTP e Worker dedicado
- A fila `comunicacao.emails_transacionais` processa `WELCOME_EMAIL` (disparado na confirmação de e-mail em `auth.users`), `SUBSCRIPTION_EXPIRING` (gerado pela manutenção financeira em `POST /api/financeiro/tarefas` ou `npm run worker:pagamentos`), `USER_INACTIVE` (quando habilitado) e eventuais registros de `EMAIL_VERIFICATION` / `PASSWORD_RESET`.
- **Opção A — Cron HTTP (`POST /api/comunicacao/tarefas`)**:
  - Defina `TRANSACTIONAL_EMAIL_MAINTENANCE_AUTHORIZATION_SECRET` com pelo menos 32 caracteres aleatórios e `TRANSACTIONAL_EMAIL_WORKER_ENABLED=true`.
  - Agende chamadas `POST https://<sua-api>/api/comunicacao/tarefas` com cabeçalho `Authorization: Bearer <TRANSACTIONAL_EMAIL_MAINTENANCE_AUTHORIZATION_SECRET>`. Cada chamada executa a manutenção da fila e envia um lote via Data API do Supabase.
- **Opção B — Worker contínuo (`npm run worker:email`)**:
  - Compile com `npm run build:worker` e execute `npm run worker:email` com `TRANSACTIONAL_EMAIL_WORKER_ENABLED=true`.
  - Para testar apenas a conectividade do worker com a Data API do Supabase sem enviar e-mails, execute `npm run check:worker` (`node dist-worker/worker-emails-supabase.js --verificar`).

### 4. Custom SMTP do Resend no Supabase Auth
- Os e-mails nativos de confirmação de cadastro e recuperação de senha do Supabase Auth devem usar o **Custom SMTP** do Resend no painel do Supabase (**Authentication -> Emails -> SMTP Settings**):
  - **Host**: `smtp.resend.com`
  - **Port**: `465` (SSL/TLS) ou `587` (STARTTLS)
  - **Username**: `resend`
  - **Password**: a API Key do Resend (`re_...`)
  - **Sender email**: o mesmo endereço verificado em `RESEND_SENDER_EMAIL_ADDRESS`
  - **Sender name**: `Siso Aprova`

## Segurança do runtime

Consulte [SEGURANCA-OPERACAO.md](SEGURANCA-OPERACAO.md) antes de implantar: store SQLite requer diretório privado gravável .cache/seguranca, configuração de proxy válida em produção e Node compatível. Sem IP confiável, fluxos anônimos sensíveis falham503 em produção; desenvolvimento direto permanece utilizável por cota de conta/email. Opção1 exige CORS ausente, não vazio. Este lote não altera nenhuma variável real nem aplica migrations.


### Autenticação com Resend e sessão local

Com `RESEND_API_KEY`, `RESEND_SENDER_EMAIL_ADDRESS` e `SUPABASE_SERVER_SECRET_API_KEY`, o backend gera links pelo Admin Auth e envia diretamente pelo Resend, independentemente do worker habilitado. Os links usam `token_hash` e nunca são gravados no histórico. A migration `20261121173000_autenticacao_emails_resend_identidade.sql` preserva senhas em reenvios e registra mensagens aceitas, inclusive webhooks recebidos antes do registro. Sem essa migration, o reenvio usa `auth.resend` com segurança; o registro de envios imediatos é opcional e não interrompe o envio já aceito. Sem configuração Resend/Admin, os fluxos usam Supabase Auth.

Para usar também os templates no painel: Authentication → Email Templates → Confirm signup / Reset password. Cole respectivamente `docs/templates-supabase-auth/confirmar-cadastro.html` e `recuperar-senha.html`. Configure Site URL para a origem do frontend. Não altere os placeholders `{{ .SiteURL }}` e `{{ .TokenHash }}`. Referências: https://supabase.com/docs/reference/javascript/auth-admin-generatelink e https://supabase.com/docs/reference/javascript/auth-verifyotp.

Em HTTP loopback (`localhost`, `127.0.0.1`, `[::1]`), mesmo com `npm start`, cookies usam HttpOnly, SameSite=Lax e Secure=false. Em HTTPS de produção mantêm prefixo __Host-, Secure, SameSite=None e Partitioned. Hosts localhost e 127.0.0.1 entram juntos na lista CORS; cookies continuam vinculados ao host, portanto use o mesmo host para frontend e backend. Após atualizar código, reconstrua os artefatos antes de `npm start`.

Recuperação operacional: interrompa o processo local, restaure o código/artefatos anteriores se necessário e mantenha a migration incremental (não remove dados nem muda contratos). A proteção impede limpar uma senha existente; trocas para outra senha não vazia continuam permitidas. Aplicação remota e homologação real exigem operação autorizada separada.
