import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  ClientePaymentsMercadoPago,
  validarPagamentoBrick,
  validarWebhookPayments,
  desafioSeguro,
  idExatoMercadoPago,
  statusPayment,
} from "../src/infrastructure/cliente-payments-mercado-pago.js";
import {
  carregarMercadoPago,
  configuracaoPublicaMercadoPago,
} from "../src/config/configuracoes-mercado-pago.js";
import {
  configPayments,
  cartao,
  pix,
  pedidoPayments,
  paymentFixture,
} from "./fixtures-payments.js";
import { gerarDocumentoOpenApi } from "../src/http/documentacao-openapi.js";

test("Bricks aceita somente allowlist, CPF/CNPJ e crédito/Pix sem dinheiro do cliente", () => {
  assert.equal(validarPagamentoBrick(cartao).three_d_secure_mode, "optional");
  assert.deepEqual(validarPagamentoBrick(pix), pix);
  for (const p of [
    { ...cartao, transaction_amount: 0.01 },
    { ...cartao, card_number: "PAN-fixture" },
    { ...pix, token: "x" },
    { ...pix, installments: 1 },
    { ...cartao, three_d_secure_mode: "mandatory" },
    { ...cartao, payer: { ...cartao.payer, identification: { type: "OTHER", number: "123" } } },
    { ...cartao, installments: 0 },
    { ...cartao, payer: { ...cartao.payer, password: "x" } },
  ])
    assert.throws(() => validarPagamentoBrick(p));
});
test("Payload deriva valor/itens/referência/descritor do pedido e não depende test_user", async () => {
  const chamadas: string[] = [];
  const mp = new ClientePaymentsMercadoPago(configPayments, async (url) => {
    chamadas.push(String(url));
    return Response.json([
      { id: "master", status: "active", payment_type_id: "credit_card" },
      { id: "debvisa", status: "active", payment_type_id: "debit_card" },
    ]);
  });
  await mp.conferirMetodo(cartao, pedidoPayments);
  await assert.rejects(() =>
    mp.conferirMetodo({ ...cartao, payment_method_id: "debvisa" }, pedidoPayments),
  );
  await assert.rejects(() => mp.conferirMetodo({ ...cartao, installments: 2 }, pedidoPayments));
  const body = mp.montarPagamento(pedidoPayments, cartao);
  assert.equal(body.transaction_amount, 19.9);
  assert.equal(body.external_reference, pedidoPayments.referencia_externa);
  assert.equal(body.statement_descriptor, "SISO APROVA");
  assert.equal(body.additional_info.items[0]!.id, pedidoPayments.id_plano);
  assert.equal(body.additional_info.items[0]!.category_id, "services");
  assert(!chamadas.some((x) => x.includes("users/me")));
});
test("Payments valida centavos, vendedor/aplicação/ambiente, estados e IDs sem arredondar", () => {
  const mp = new ClientePaymentsMercadoPago(configPayments),
    p = paymentFixture();
  assert.equal(mp.validarPagamento(p, pedidoPayments), "aprovado");
  for (const patch of [
    { transaction_amount: 19.91 },
    { transaction_amount: 19.901 },
    { currency_id: "USD" },
    { collector_id: "9" },
    { application_id: "9" },
    { live_mode: true },
    { external_reference: "outro" },
    { date_last_updated: "inválido" },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { payment_type_id: "debit_card" },
    { status: "authorized" },
    { status_detail: "<html>" },
  ])
    assert.throws(() => mp.validarPagamento({ ...p, ...patch }, pedidoPayments));
  assert.equal(
    idExatoMercadoPago("123456789012345678901234567890"),
    "123456789012345678901234567890",
  );
  assert.throws(() => idExatoMercadoPago(Number.MAX_SAFE_INTEGER + 1));
  for (const [raw, status] of Object.entries({
    approved: "aprovado",
    pending: "pendente",
    in_process: "processando",
    rejected: "rejeitado",
    cancelled: "cancelado",
    refunded: "estornado",
    charged_back: "contestado",
    in_mediation: "contestado",
  }))
    assert.equal(statusPayment(raw), status);
});
test("3DS só retorna desafio de pending_challenge com origem exata; sem persistência", () => {
  const p = {
    ...paymentFixture(),
    status: "pending",
    status_detail: "pending_challenge",
    three_ds_info: {
      external_resource_url: "https://acs-public.tp.mastercard.com/api/v1/browser_Challenges",
      creq: "fixture_creq",
    },
  };
  assert(desafioSeguro(p).threeDsInfo);
  assert.deepEqual(desafioSeguro({ ...p, status: "approved" }), {});
  for (const url of [
    "https://evil.invalid/",
    "https://acs-public.tp.mastercard.com:444/",
    "https://user@acs-public.tp.mastercard.com/",
    "http://acs-public.tp.mastercard.com/",
  ]) {
    const r = desafioSeguro({
      ...p,
      three_ds_info: { ...p.three_ds_info, external_resource_url: url },
    });
    assert.equal(r.desafioIndisponivel, true);
    assert(!JSON.stringify(r).includes(url));
    assert(!JSON.stringify(r).includes("fixture_creq"));
  }
});
test("HMAC Payments numérico, segundos/ms, duplicatas e5min com comparação constante", () => {
  const agora = Date.now(),
    rid = "request-fixture",
    id = "123456789012345678901234567890";
  const req = (tempo: string, extra = "") => {
    const v = createHmac("sha256", configPayments.webhookSecret)
      .update(`id:${id};request-id:${rid};ts:${tempo};`)
      .digest("hex");
    return new Request(`https://api.example.test/api/financeiro/webhook?data.id=${id}${extra}`, {
      headers: { "x-request-id": rid, "x-signature": `ts=${tempo},v1=${v}` },
    });
  };
  assert.equal(
    validarWebhookPayments(req(String(agora)), configPayments.webhookSecret, agora).id,
    id,
  );
  assert.equal(
    validarWebhookPayments(
      req(String(Math.floor(agora / 1000))),
      configPayments.webhookSecret,
      agora,
    ).id,
    id,
  );
  assert.throws(() =>
    validarWebhookPayments(req(String(agora - 300001)), configPayments.webhookSecret, agora),
  );
  assert.throws(() =>
    validarWebhookPayments(req(String(agora), "&data.id=1"), configPayments.webhookSecret, agora),
  );
  assert.throws(() => validarWebhookPayments(req(String(agora)), "outro", agora));
});
test("Config pública não contém segredo; teste TEST- e produção APP_USR-; esquemas explícitos", () => {
  const env = {
    MERCADO_PAGO_PUBLIC_KEY: "TEST-public-fixture",
    MERCADO_PAGO_ACCESS_TOKEN: configPayments.accessToken,
    MERCADO_PAGO_WEBHOOK_SIGNING_SECRET: configPayments.webhookSecret,
    MERCADO_PAGO_SELLER_ACCOUNT_ID: "1234",
    MERCADO_PAGO_APPLICATION_ID: "5678",
  };
  assert.equal(carregarMercadoPago(env).ambiente, "teste");
  assert(!JSON.stringify(configuracaoPublicaMercadoPago(env)).includes(configPayments.accessToken));
  assert.throws(() =>
    carregarMercadoPago({ ...env, MERCADO_PAGO_ACCESS_TOKEN: "APP_USR-fixture" }),
  );
  assert.throws(() =>
    carregarMercadoPago({ ...env, MERCADO_PAGO_WEBHOOK_URL: "http://evil.invalid" }),
  );
  const d = gerarDocumentoOpenApi();
  assert(d.components.schemas.FinanceiroPedido);
  assert(d.paths["/api/financeiro/configuracao"].get);
  assert.deepEqual(d.paths["/api/financeiro/checkout"].post.security, [
    { cookieAuth: [] },
    { bearerAuth: [] },
  ]);
});
