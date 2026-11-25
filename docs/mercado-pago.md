# Pagamentos antecipados — Siso Aprova / Mercado Pago (Checkout Bricks + Payments API)

Atualizado em 21/11/2026 conforme decisão arquitetural `docs/DECISAO_PAGAMENTO_BRICKS_20261121.md`. Backend Next.js/TypeScript, frontend React/Vite e Supabase Auth/Data API preservados.

## Arquitetura vigente e convivência com histórico Orders

Novas compras utilizam **Checkout Bricks (Payment Brick + Status Screen Brick) com Payments API (`/v1/payments`)** dentro da própria plataforma, aceitando exclusivamente **cartão de crédito** e **Pix** (sem boleto, débito, carteira ou redirecionamento externo para pagar).

Pedidos históricos criados sob a integração anterior (`provedor = 'orders'`, identificados por `id_order_mp` `ORD...`/`ORDTST...`) permanecem preservados e conciliáveis em seu protocolo original, sem conversão para Payments API e sem criação de novas cobranças `/v1/orders`.

Documentação oficial de referência:

- [SDK Payment Brick](https://github.com/mercadopago/sdk-js/blob/main/docs/bricks/payment.md) e [Envio de cartão pelo Payment Brick](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/payment-brick/payment-submission/cards).
- [SDK Status Screen Brick e 3DS](https://github.com/mercadopago/sdk-js/blob/main/docs/bricks/status-screen.md) e [Integração 3DS via Payments API](https://www.mercadopago.com.br/developers/pt/docs/checkout-bricks/how-tos/integrate-3ds).
- [Payments API (`/v1/payments`)](https://www.mercadopago.com.br/developers/pt/reference/payments/_payments/post) e [Webhooks Mercado Pago](https://github.com/mercadopago/sdk-nodejs/blob/master/docs/webhooks.md).
- [RLS Supabase](https://supabase.com/docs/guides/database/postgres/row-level-security).

### Credenciais e ambientes (`Payments API` vs histórico `Orders`)

- Na integração **Checkout Bricks / Payments API**, o ambiente `teste` exige `MERCADO_PAGO_PUBLIC_KEY` e `MERCADO_PAGO_ACCESS_TOKEN` iniciados por `TEST-`, enquanto `producao` exige `APP_USR-` (com `MERCADO_PAGO_PRODUCTION_ENABLED=true`).
- Não há dependência de `/users/me` com tag `test_user` para criar pagamentos via `/v1/payments`; toda resposta consultada do provedor é validada contra `collector_id` (`MERCADO_PAGO_SELLER_ACCOUNT_ID`), `application_id` (`MERCADO_PAGO_APPLICATION_ID`, quando retornado pelo provedor), `live_mode` vs `ambiente`, `external_reference`, moeda `BRL`, valor em centavos inteiros e `payment_type_id` (`credit_card` ou `bank_transfer` com `pix`).
- Para conciliação de pedidos legados `orders`, variáveis opcionais `MERCADO_PAGO_ORDERS_*` podem ser informadas caso a aplicação histórica utilize credenciais separadas.

## Fluxo e regras financeiras

1. O frontend consulta `GET /api/financeiro/configuracao`, que expõe apenas `{ publicKey, ambiente, maxParcelas, meiosPagamento: ["credit_card", "pix"] }` com `Cache-Control: no-store`. Nenhum segredo (`accessToken`, `webhookSecret`, credenciais administrativas) é exposto.
2. No checkout (`POST /api/financeiro/checkout`), o cliente envia `{ idPlano, pagamento }` e o header UUID obrigatório `X-Idempotency-Key`. O objeto `pagamento` aceita apenas a allowlist estrita: `payment_method_id`, `payer` (`email`, `identification` `CPF`/`CNPJ`, `first_name`/`last_name` opcionais) e, exclusivamente para cartão de crédito, `token` efêmero, `installments` (`1..12`, limitado a `1` no plano mensal e a `maxParcelas` nos demais) e `issuer_id` opcional. O servidor força `three_d_secure_mode: "optional"` nas compras com cartão e recusa qualquer campo monetário, item, referência ou método fora do escopo (como débito ou boleto).
3. Antes do `POST /v1/payments`, o servidor bloqueia a identidade do estudante (`FOR UPDATE`), cria ou recupera o pedido (`provedor = 'payments'`), valida o método ativo em `/v1/payment_methods` (para cartão) e grava a reserva durável (`estado_checkout_mp = 'enviando'`).
4. **Sigilo e não-persistência de dados sensíveis**: `token` de cartão, CVV, PAN, `formData`, `three_ds_info`/`creq` e corpo bruto do provedor **nunca** são gravados no banco (`checkout_payload` permanece `NULL` em Payments), nem em logs (`redact` no Pino) ou URLs.
5. **Recuperação determinística de falhas**:
   - Se o primeiro `POST /v1/payments` retornar rejeição explícita de entrada/autenticação (`HTTP 400/401/403/422`) sem tentativa transitória prévia, o servidor executa `falhar_payment` (marcando o pedido como `rejeitado` / `creation_rejected` e cancelando a assinatura pendente associada) e responde `HTTP 400` com `code: "PAYMENT_NOT_CREATED"` e `retryable: true`, permitindo que o frontend descarte a chave e remonte o Brick com segurança.
   - Se ocorrer timeout, erro de rede ou `5xx` após o envio, o pedido entra em `estado_checkout_mp = 'ambiguo'`. Novas chamadas com a mesma chave reconciliam via `GET /v1/payments/search?external_reference=...` e `GET /v1/payments/{id}` sem reenviar `POST /v1/payments`; enquanto inconclusivo, o servidor responde `HTTP 409` e bloqueia nova compra no mesmo ambiente para evitar dupla cobrança.
6. **Desafio 3DS 2.0 (`pending_challenge`)**: quando o Mercado Pago retorna `status = "pending"` e `status_detail = "pending_challenge"`, o backend valida `three_ds_info` contra a allowlist HTTPS estrita (`ORIGENS_DESAFIO_3DS = ["https://acs-public.tp.mastercard.com"]`, sem porta, usuário ou senha) e devolve transitoriamente `threeDsInfo: { externalResourceUrl, creq }` apenas ao estudante proprietário (na criação, em `GET /api/financeiro/pedido` e em `POST /api/financeiro/sincronizar`). Caso a URL do emissor esteja fora da allowlist, o pedido e `idPagamentoMp` são preservados e a resposta traz `desafioIndisponivel: true`, sem expor URL ou `creq`.
7. **Webhook e ativação de acesso Premium**:
   - `POST /api/financeiro/webhook` aceita notificações `payment` (`data.id` numérico de 1 a 30 dígitos) e históricas `order` (`ORD...`/`ORDTST...`).
   - Valida `x-request-id`, `x-signature` (`ts`, `v1`), janela de ±5 minutos e manifesto HMAC-SHA256 com `timingSafeEqual`, além de rate limit por IP confiável (`600/min`).
   - O evento é persistido em `financeiro.webhooks` (com `provedor` e `ambiente`) antes do `HTTP 200` e processado via `after()` / agendador.
   - **Somente aprovação confirmada por webhook assinado (`webhook_confirmado = true`) ativa a assinatura e concede acesso Premium.** Consultas diretas (`sincronizar`/`pedido`) atualizam o estado informativo (`aprovado` aguardando confirmação), mas não liberam vigência.
8. **Renovação, estornos e contestações**:
   - Renovação antecipada soma meses de calendário em UTC ao término vigente; após vencimento, inicia na confirmação.
   - `refunded`, `cancelled`, `charged_back` e `in_mediation` atualizam pagamento e assinatura (`cancelada` ou `suspensa`), revogando o acesso do período afetado sem alterar outros períodos pagos. Reembolso parcial preserva a vigência e registra `valor_estornado`. Eventos atrasados nunca revertem estados terminais (`estornado`/`contestado`).

## Persistência, migrações e correções operacionais (`MP01` e `MP05`)

As migrations locais compõem a cadeia financeira:

- `database/migrations/20261105232541_pagamentos_mercado_pago.sql`
- `database/migrations/20261107133819_vigencia_acesso_premium.sql`
- `database/migrations/20261121142032_pagamentos_bricks_payments.sql` (gerada localmente para Payments API; **não** aplicada remotamente durante o desenvolvimento).

Principais garantias da migration `20261121142032_pagamentos_bricks_payments.sql`:

- Colunas aditivas em `public.pedidos_pagamento` (`provedor`, `id_pagamento_mp`, `status_pagamento_mp`, `detalhe_pagamento_mp`, `estado_checkout_mp`), `id_order_mp` opcional em `public.pagamentos` e `provedor`/`ambiente` em `financeiro.webhooks`.
- **`MP01` (recuperação de lease vencido na 12ª tentativa e visibilidade operacional)**: `reservar_eventos` e `manutencao` convertem eventos em `status = 'processando'` com `tentativas >= 12` e `reserva_ate < now()` para `status = 'falha'` (`erro = 'reserva_expirada_limite_tentativas'`), tornando-os visíveis em `eventosFalhos` e recuperáveis por `POST /api/financeiro/admin/reprocessar`. O painel administrativo também expõe `aprovadosSemWebhook` e `checkoutsInconclusivos`.
- **`MP05` (isolamento por ambiente e consistência de filtros no painel)**: `GET /api/financeiro/admin/painel` filtra listas (`pagamentos`, `assinaturas`, `historico`, `cancelamentos`, `eventosFalhos`, `aprovadosSemWebhook`, `checkoutsInconclusivos`) e indicadores (`indicadores`, `ativos`, `porPlano`, `vencendo`, `renovacoes`) pelo mesmo `ambiente` (`teste` ou `producao`) e escopo de pedidos filtrados.
- **Assunto de aviso de vencimento**: e-mails transacionais de expiração utilizam o assunto `'Sua assinatura Siso Aprova'`.
- **RLS e privilégios**: `anon` e `authenticated` não possuem `EXECUTE` em `financeiro.operar_backend`, `financeiro.operar_backend_legacy` nem `public.operar_financeiro_backend` (exclusivas de `service_role`).

## Endpoints `/api/financeiro/*` e contratos OpenAPI

Todos os 15 endpoints financeiros possuem schemas explícitos registrados em `src/http/documentacao-financeiro.ts` (`FinanceiroConfiguracao`, `FinanceiroPlano`, `FinanceiroPedido`, `FinanceiroPagamentoBrick`, `FinanceiroAssinatura`, `FinanceiroPagamento`, `FinanceiroHistorico`, `FinanceiroAviso`, `FinanceiroMinhaAssinatura`, `FinanceiroPainel`) e exportados offline via `npm run contratos:exportar`.

| Método / Rota                               | Finalidade / Contrato                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/financeiro/configuracao`          | Público; retorna `{ publicKey, ambiente, maxParcelas, meiosPagamento }`                                                                                       |
| `GET /api/financeiro/planos`                | Público; catálogo ativo com `moeda: "BRL"` e preço do banco                                                                                                   |
| `GET /api/financeiro/acesso`                | Estudante; retorna `{ premium, vigenciaAte }`                                                                                                                 |
| `GET /api/financeiro/minha-assinatura`      | Estudante; assinaturas, pedidos (com `webhook_confirmado`, `provedor`, `idPagamentoMp`, `statusPagamentoMp`, `status_detail`), pagamentos, histórico e avisos |
| `POST /api/financeiro/checkout`             | Estudante; `{ idPlano, pagamento }` + header `X-Idempotency-Key` UUID                                                                                         |
| `GET /api/financeiro/pedido?id=UUID`        | Estudante; consulta pedido próprio e recupera `threeDsInfo` transitório quando em `pending_challenge`                                                         |
| `POST /api/financeiro/sincronizar`          | Estudante; `{ id }` do pedido próprio                                                                                                                         |
| `POST /api/financeiro/cancelamento`         | Estudante; `{ id, justificativa }`                                                                                                                            |
| `GET /api/financeiro/admin/painel`          | Administrador; filtros validados (`ambiente`, `pessoa`, `plano`, `status`, `de`, `ate`, `vencimento`, `pagina`; datas inválidas retornam `HTTP 400`)          |
| `POST` / `PUT /api/financeiro/admin/planos` | Administrador; `PUT` exige `id` UUID obrigatório                                                                                                              |
| `POST /api/financeiro/admin/sincronizar`    | Administrador; `{ id }` com auditoria                                                                                                                         |
| `POST /api/financeiro/admin/operacao`       | Administrador; `{ id, acao: "cancelar" \| "estornar", justificativa }`                                                                                        |
| `POST /api/financeiro/admin/reprocessar`    | Administrador; recoloca webhooks em `falha` na fila                                                                                                           |
| `POST /api/financeiro/webhook`              | Público assinado; `data.id` numérico (`payment`) ou `ORD...` (`order`)                                                                                        |
| `POST /api/financeiro/tarefas`              | Manutenção autenticada por Bearer `MERCADO_PAGO_MAINTENANCE_AUTHORIZATION_SECRET` (`GET` retorna `405`)                                                       |

## Testes automatizados e operação

As suítes financeiras foram restauradas e expandidas para cobrir unitários, rotas HTTP e PostgreSQL 17 descartável (`embedded-postgres`), sem rede externa (`tests/isolamento.mjs`):

- `tests/pagamentos.test.ts`: domínio monetário, contratos e compatibilidade legada Orders.
- `tests/pagamentos-payments.test.ts`: validação estrita do Payment Brick, payload `/v1/payments`, centavos, 3DS allowlist, HMAC numérico e OpenAPI.
- `tests/pagamentos-http.test.ts`: rotas `/api/financeiro/*`, sessão/roles/CSRF, `PAYMENT_NOT_CREATED` (`400`) e validação de filtros/datas (`400`).
- `tests/postgres/pagamentos.test.ts` e `tests/postgres/payments-bricks.test.ts`: transações reais, Pix, cartão, 3DS sem persistir token/`creq`, recuperação de timeout pós-POST por `external_reference`, rejeição definitiva `400` sem bloquear tentativa futura, crash pré-POST, concorrência, isolamento de pedidos históricos Orders, `MP01` (12ª reserva expirada), `MP05` (filtros/ambiente e aprovados sem webhook), RLS e reversões.

Em produção, mantenha agendador externo acionando `POST /api/financeiro/tarefas` (ou `npm run worker:pagamentos`) e o worker de e-mails (`npm run worker:email`), pois `npm start` sobe apenas o servidor HTTP standalone.
