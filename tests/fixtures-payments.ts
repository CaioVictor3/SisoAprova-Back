import type { ConfiguracaoMercadoPago } from "../src/config/configuracoes-mercado-pago.js";
import type { PedidoPagamento } from "../src/domain/pagamentos-assinaturas.js";
import type {
  PaymentMercadoPago,
  PagamentoBrick,
} from "../src/infrastructure/cliente-payments-mercado-pago.js";
export const configPayments: ConfiguracaoMercadoPago = {
  accessToken: "TEST-fixture-sem-credencial",
  publicKey: "TEST-public-fixture",
  webhookSecret: "assinatura-fixture-sem-valor-123456",
  sellerId: "1234",
  applicationId: "5678",
  ambiente: "teste",
  retornoUrl: "",
  maxParcelas: 6,
  timeoutMs: 1000,
};
export const pix: PagamentoBrick = {
  payment_method_id: "pix",
  payer: {
    email: "fixture@example.invalid",
    identification: { type: "CPF", number: "12345678909" },
  },
};
export const cartao: PagamentoBrick = {
  ...pix,
  payment_method_id: "master",
  token: "token-fixture-efemero",
  installments: 1,
};
export const pedidoPayments: PedidoPagamento = {
  id: "11111111-1111-4111-8111-111111111111",
  id_pessoa: "22222222-2222-4222-8222-222222222222",
  id_plano: "33333333-3333-4333-8333-333333333333",
  plano_nome: "Mensal",
  duracao_meses: 1,
  beneficios: [],
  valor: "19.90",
  moeda: "BRL",
  status: "pendente",
  chave_idempotencia: "44444444-4444-4444-8444-444444444444",
  referencia_externa: "fixture-ref",
  id_order_mp: null,
  checkout_url: null,
  criado_em: new Date().toISOString(),
  expira_em: new Date().toISOString(),
  ambiente: "teste",
  provedor: "payments",
  idPagamentoMp: null,
  statusPagamentoMp: null,
  status_detail: null,
  webhook_confirmado: false,
};
export function paymentFixture(p: PedidoPagamento = pedidoPayments): PaymentMercadoPago {
  return {
    id: "1234567890",
    status: "approved",
    status_detail: "accredited",
    transaction_amount: Number(p.valor),
    currency_id: "BRL",
    external_reference: p.referencia_externa,
    live_mode: false,
    collector_id: "1234",
    application_id: "5678",
    date_last_updated: new Date().toISOString(),
    payment_method_id: "master",
    payment_type_id: "credit_card",
    installments: 1,
  };
}
