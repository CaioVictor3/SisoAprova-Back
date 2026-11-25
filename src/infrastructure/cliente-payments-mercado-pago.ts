import { createHmac, timingSafeEqual } from "node:crypto";
import { ClienteMercadoPago } from "./cliente-mercado-pago.js";
import {
  centavos,
  type PedidoPagamento,
  type StatusPagamento,
} from "../domain/pagamentos-assinaturas.js";
import { ErroRegraNegocioHttp } from "../domain/erros-validacoes-respostas-api.js";

export interface PagamentoBrick {
  payment_method_id: string;
  token?: string;
  installments?: number;
  issuer_id?: string;
  payer: {
    email: string;
    identification: { type: "CPF" | "CNPJ"; number: string };
    first_name?: string;
    last_name?: string;
  };
  three_d_secure_mode?: "optional";
}
export interface PaymentMercadoPago {
  id: number | string;
  status: string;
  status_detail: string;
  transaction_amount: number;
  transaction_amount_refunded?: number;
  currency_id: string;
  external_reference: string;
  live_mode: boolean;
  collector_id: number | string;
  application_id?: string | number;
  date_last_updated: string;
  payment_method_id: string;
  payment_type_id: string;
  installments?: number;
  three_ds_info?: { external_resource_url?: string; creq?: string };
}
const invalido = () => new ErroRegraNegocioHttp("Confira os dados do pagamento.", 400);
function objeto(v: unknown, campos: string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !campos.includes(k))
  )
    throw invalido();
  return v as Record<string, unknown>;
}
function texto(v: unknown, regex: RegExp, max: number) {
  if (typeof v !== "string" || v.length > max || !regex.test(v)) throw invalido();
  return v;
}
export function validarPagamentoBrick(v: unknown): PagamentoBrick {
  const p = objeto(v, [
    "payment_method_id",
    "token",
    "installments",
    "issuer_id",
    "payer",
    "three_d_secure_mode",
  ]);
  const method = texto(p.payment_method_id, /^[a-z0-9_]{1,60}$/, 60);
  const payer = objeto(p.payer, ["email", "identification", "first_name", "last_name"]);
  const ident = objeto(payer.identification, ["type", "number"]);
  if (!["CPF", "CNPJ"].includes(String(ident.type))) throw invalido();
  const numero = texto(ident.number, /^\d+$/, 14);
  if (numero.length !== (ident.type === "CPF" ? 11 : 14)) throw invalido();
  const email = texto(payer.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, 254);
  const base: PagamentoBrick = {
    payment_method_id: method,
    payer: { email, identification: { type: ident.type as "CPF" | "CNPJ", number: numero } },
  };
  for (const campo of ["first_name", "last_name"] as const)
    if (payer[campo] !== undefined) base.payer[campo] = texto(payer[campo], /^.{1,100}$/u, 100);
  if (method === "pix") {
    if (
      p.token !== undefined ||
      p.installments !== undefined ||
      p.issuer_id !== undefined ||
      p.three_d_secure_mode !== undefined
    )
      throw invalido();
  } else {
    base.token = texto(p.token, /^[a-zA-Z0-9_-]+$/, 512);
    if (
      typeof p.installments !== "number" ||
      !Number.isInteger(p.installments) ||
      p.installments < 1 ||
      p.installments > 12
    )
      throw invalido();
    base.installments = p.installments;
    if (p.issuer_id !== undefined) base.issuer_id = texto(p.issuer_id, /^\d{1,30}$/, 30);
    if (p.three_d_secure_mode !== undefined && p.three_d_secure_mode !== "optional")
      throw invalido();
    base.three_d_secure_mode = "optional";
  }
  return base;
}
export function statusPayment(status: string): StatusPagamento {
  switch (status) {
    case "approved":
      return "aprovado";
    case "pending":
      return "pendente";
    case "in_process":
      return "processando";
    case "rejected":
      return "rejeitado";
    case "cancelled":
      return "cancelado";
    case "refunded":
      return "estornado";
    case "charged_back":
    case "in_mediation":
      return "contestado";
    default:
      throw new Error("Estado financeiro não reconhecido.");
  }
}
export function centavosPayments(v: unknown): bigint {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 9999999999.99)
    throw new Error("Valor inválido.");
  const cents = Math.round(v * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(v * 100 - cents) > 0.0001)
    throw new Error("Valor inválido.");
  return BigInt(cents);
}
export const ORIGENS_DESAFIO_3DS = ["https://acs-public.tp.mastercard.com"] as const;
export function desafioSeguro(payment: PaymentMercadoPago) {
  if (payment.status !== "pending" || payment.status_detail !== "pending_challenge") return {};
  const url = payment.three_ds_info?.external_resource_url,
    creq = payment.three_ds_info?.creq;
  try {
    if (
      typeof url !== "string" ||
      typeof creq !== "string" ||
      !/^[a-zA-Z0-9_=-]{1,16384}$/.test(creq)
    )
      throw new Error();
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      !ORIGENS_DESAFIO_3DS.includes(u.origin as (typeof ORIGENS_DESAFIO_3DS)[number])
    )
      throw new Error();
    return { threeDsInfo: { externalResourceUrl: u.href, creq } };
  } catch {
    return { desafioIndisponivel: true };
  }
}
export function validarWebhookPayments(req: Request, secret: string, agora = Date.now()) {
  const url = new URL(req.url),
    id = url.searchParams.get("data.id") ?? "",
    rid = req.headers.get("x-request-id") ?? "";
  const partes = (req.headers.get("x-signature") ?? "").split(",").map((p) => p.trim().split("="));
  const ts = partes.filter((p) => p[0] === "ts"),
    vs = partes.filter((p) => p[0] === "v1");
  const tempo = ts[0]?.[1] ?? "",
    sig = vs[0]?.[1] ?? "";
  const erro = () => new ErroRegraNegocioHttp("Assinatura do webhook inválida.", 401);
  if (
    !secret ||
    !/^\d{1,30}$/.test(id) ||
    url.searchParams.getAll("data.id").length !== 1 ||
    !/^[\w-]{1,200}$/.test(rid) ||
    ts.length !== 1 ||
    vs.length !== 1 ||
    !/^(?:\d{10}|\d{13})$/.test(tempo) ||
    !/^[a-f0-9]{64}$/i.test(sig)
  )
    throw erro();
  if (Math.abs(agora - Number(tempo) * (tempo.length === 10 ? 1000 : 1)) > 300000) throw erro();
  const mac = createHmac("sha256", secret)
    .update(`id:${id};request-id:${rid};ts:${tempo};`)
    .digest();
  if (!timingSafeEqual(mac, Buffer.from(sig, "hex"))) throw erro();
  return {
    id,
    chave: createHmac("sha256", secret)
      .update(`payments:${id}:${rid}:${tempo}:${sig.toLowerCase()}`)
      .digest("hex"),
  };
}
export function idExatoMercadoPago(id: unknown): string {
  if (typeof id === "number" && (!Number.isSafeInteger(id) || id < 0))
    throw new Error("Identificador financeiro inválido.");
  if ((typeof id !== "number" && typeof id !== "string") || !/^\d{1,30}$/.test(String(id)))
    throw new Error("Identificador financeiro inválido.");
  return String(id);
}
export class ClientePaymentsMercadoPago extends ClienteMercadoPago {
  async conferirMetodo(p: PagamentoBrick, pedido: PedidoPagamento) {
    if (p.payment_method_id === "pix") return;
    const methods =
      await this.solicitar<{ id: string; payment_type_id: string; status: string }[]>(
        "/v1/payment_methods",
      );
    if (
      !methods.some(
        (m) =>
          m.id === p.payment_method_id &&
          m.payment_type_id === "credit_card" &&
          m.status === "active",
      )
    )
      throw invalido();
    if (p.installments! > (pedido.duracao_meses === 1 ? 1 : this.config.maxParcelas))
      throw invalido();
  }
  montarPagamento(pedido: PedidoPagamento, p: PagamentoBrick) {
    const valor = Number(pedido.valor);
    if (centavosPayments(valor) !== centavos(pedido.valor)) throw new Error("Valor inválido.");
    return {
      ...p,
      transaction_amount: valor,
      external_reference: pedido.referencia_externa,
      description: `Siso Aprova — ${pedido.plano_nome}`,
      statement_descriptor: "SISO APROVA",
      additional_info: {
        items: [
          {
            id: pedido.id_plano,
            title: `Siso Aprova ${pedido.plano_nome}`,
            quantity: 1,
            unit_price: valor,
            category_id: "services",
          },
        ],
      },
      ...(this.config.webhookUrl ? { notification_url: this.config.webhookUrl } : {}),
      ...(p.payment_method_id !== "pix" ? { three_d_secure_mode: "optional" } : {}),
    };
  }
  criarPagamento(pedido: PedidoPagamento, p: PagamentoBrick) {
    return this.solicitar<PaymentMercadoPago>(
      "/v1/payments",
      "POST",
      this.montarPagamento(pedido, p),
      pedido.chave_idempotencia,
    );
  }
  obterPagamento(id: string) {
    id = idExatoMercadoPago(id);
    return this.solicitar<PaymentMercadoPago>(`/v1/payments/${id}`);
  }
  async buscarPagamento(pedido: PedidoPagamento) {
    const r = await this.solicitar<{ results: PaymentMercadoPago[] }>(
      `/v1/payments/search?external_reference=${encodeURIComponent(pedido.referencia_externa)}&sort=date_created&criteria=desc`,
    );
    if (!Array.isArray(r.results) || r.results.length > 1)
      throw new ErroRegraNegocioHttp("Conciliação inconclusiva.", 409);
    if (!r.results[0]) return null;
    return this.obterPagamento(idExatoMercadoPago(r.results[0].id));
  }
  cancelarPagamento(id: string, chave: string) {
    id = idExatoMercadoPago(id);
    return this.solicitar(`/v1/payments/${id}`, "PUT", { status: "cancelled" }, chave);
  }
  estornarPagamento(id: string, chave: string) {
    id = idExatoMercadoPago(id);
    return this.solicitar(`/v1/payments/${id}/refunds`, "POST", {}, chave);
  }
  validarPagamento(p: PaymentMercadoPago, pedido: PedidoPagamento) {
    const id = idExatoMercadoPago(p.id),
      collector = idExatoMercadoPago(p.collector_id);
    if (p.application_id != null) idExatoMercadoPago(p.application_id);
    if (
      !/^\d{1,30}$/.test(id) ||
      (pedido.idPagamentoMp != null && String(p.id) !== pedido.idPagamentoMp) ||
      p.external_reference !== pedido.referencia_externa ||
      p.currency_id !== "BRL" ||
      pedido.moeda !== "BRL" ||
      centavosPayments(p.transaction_amount) !== centavos(pedido.valor) ||
      collector !== this.config.sellerId ||
      (p.application_id != null && String(p.application_id) !== this.config.applicationId) ||
      p.live_mode !== (this.config.ambiente === "producao") ||
      pedido.ambiente !== this.config.ambiente ||
      !Number.isFinite(Date.parse(p.date_last_updated)) ||
      !/^[a-z0-9_]{1,100}$/.test(p.status_detail) ||
      !(
        p.payment_type_id === "credit_card" ||
        (p.payment_type_id === "bank_transfer" && p.payment_method_id === "pix")
      )
    )
      throw new Error("Pagamento não corresponde ao pedido e ambiente.");
    if (
      p.transaction_amount_refunded !== undefined &&
      centavosPayments(p.transaction_amount_refunded) > centavos(pedido.valor)
    )
      throw new Error("Estorno inválido.");
    return statusPayment(p.status);
  }
}
