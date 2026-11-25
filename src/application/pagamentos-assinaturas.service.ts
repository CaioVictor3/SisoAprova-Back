import {
  ClientePaymentsMercadoPago,
  desafioSeguro,
  type PagamentoBrick,
  type PaymentMercadoPago,
} from "../infrastructure/cliente-payments-mercado-pago.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { ErroRegraNegocioHttp } from "../domain/erros-validacoes-respostas-api.js";
import { centavos, type PedidoPagamento } from "../domain/pagamentos-assinaturas.js";
import {
  ClienteMercadoPago,
  ErroPagamentoNaoCriado,
} from "../infrastructure/cliente-mercado-pago.js";
import { RepositorioPagamentosSupabase } from "../infrastructure/repositorio-pagamentos-supabase.js";

export class ServicoPagamentosAssinaturas {
  constructor(
    readonly repo: RepositorioPagamentosSupabase,
    readonly mercadoPago: ClienteMercadoPago,
    readonly payments?: ClientePaymentsMercadoPago,
  ) {}
  async iniciarCheckout(pessoa: string, plano: string, chave: string, pagamento: PagamentoBrick) {
    const mp = this.exigirPayments();
    const pedido = await this.repo.executar<PedidoPagamento>("criar_pedido_payments", {
      pessoa,
      plano,
      chave,
      ambiente: mp.config.ambiente,
    });
    if (pedido.provedor !== "payments") return pedido; // historical Orders must never be converted or charged again.
    if (pedido.idPagamentoMp) return this.sincronizar(pedido);
    if (["rejeitado", "cancelado"].includes(pedido.status)) return pedido;
    await mp.conferirMetodo(pagamento, pedido);
    const reserva = await this.repo.executar<{ reserva: string } | null>("reservar_payment", {
      id: pedido.id,
    });
    if (!reserva) return this.recuperarPayment(pedido);
    try {
      const p = await mp.criarPagamento(pedido, pagamento);
      mp.validarPagamento(p, pedido);
      const vinculado = await this.repo.executar<PedidoPagamento>("vincular_payment", {
        id: pedido.id,
        pagamento: String(p.id),
      });
      return await this.aplicarPayment(vinculado, p, false);
    } catch (erro) {
      // Never persist token/formData, nor create a fresh payment after an uncertain POST.
      await this.repo.executar(
        erro instanceof ErroPagamentoNaoCriado ? "falhar_payment" : "ambiguo_payment",
        { id: pedido.id, reserva: reserva.reserva },
      );
      throw erro;
    }
  }
  private exigirPayments() {
    if (!this.payments) throw new ErroRegraNegocioHttp("Pagamentos indisponíveis.", 503);
    return this.payments;
  }
  async recuperarPayment(pedido: PedidoPagamento, webhook = false) {
    const mp = this.exigirPayments(),
      payment = await mp.buscarPagamento(pedido);
    if (!payment)
      throw new ErroRegraNegocioHttp(
        "Pagamento em conciliação. Consulte este pedido novamente; não inicie uma nova cobrança.",
        409,
      );
    mp.validarPagamento(payment, pedido);
    const vinculado = await this.repo.executar<PedidoPagamento>("vincular_payment", {
      id: pedido.id,
      pagamento: String(payment.id),
    });
    return this.aplicarPayment(vinculado, payment, webhook);
  }
  async aplicarPayment(pedido: PedidoPagamento, payment: PaymentMercadoPago, webhook = false) {
    const status = this.exigirPayments().validarPagamento(payment, pedido);
    const cents =
      payment.transaction_amount_refunded === undefined ? 0 : payment.transaction_amount_refunded;
    const resultado = await this.repo.executar<PedidoPagamento>("aplicar_payment", {
      id: pedido.id,
      pagamento: String(payment.id),
      status,
      status_mp: payment.status,
      versao: payment.date_last_updated,
      valor: pedido.valor,
      moeda: "BRL",
      detalhe: payment.status_detail,
      metodo: payment.payment_method_id,
      parcelas: payment.installments ?? null,
      estornado: payment.status === "refunded" ? pedido.valor : cents.toFixed(2),
      webhook,
    });
    return { ...resultado, ...desafioSeguro(payment) };
  }
  async completarCheckout(pedido: PedidoPagamento) {
    if (pedido.provedor === "payments") return this.sincronizar(pedido);
    if (pedido.id_order_mp) return this.sincronizar(pedido);
    throw new ErroRegraNegocioHttp(
      "Pedido histórico Orders sem identificação no provedor. Solicite análise do suporte; nenhuma cobrança será criada.",
      409,
    );
  }
  async sincronizar(pedido: PedidoPagamento, webhook = false) {
    if (pedido.provedor === "payments") {
      if (!pedido.idPagamentoMp) {
        if (["rejeitado", "cancelado"].includes(pedido.status)) return pedido;
        return this.recuperarPayment(pedido, webhook);
      }
      return this.aplicarPayment(
        pedido,
        await this.exigirPayments().obterPagamento(pedido.idPagamentoMp),
        webhook,
      );
    }
    if (!pedido.id_order_mp) return pedido;
    const order = await this.mercadoPago.obterOrder(pedido.id_order_mp);
    let status = this.mercadoPago.validarOrder(order, pedido);
    if ((order.transactions?.chargebacks?.length ?? 0) > 0) status = "contestado";
    const pagamento =
      order.transactions?.payments?.find(
        (p) => p.status === "processed" || p.status === "charged_back" || p.status === "refunded",
      ) ?? order.transactions?.payments?.at(-1);
    const somaEstornos = (order.transactions?.refunds ?? [])
      .filter((r) => r.status === "processed")
      .reduce((s, r) => s + centavos(r.amount), 0n);
    const estornado =
      status === "estornado"
        ? centavos(pedido.valor)
        : somaEstornos > centavos(pedido.valor)
          ? centavos(pedido.valor)
          : somaEstornos;
    const resultado = await this.repo.executar<PedidoPagamento>("aplicar_order", {
      id: pedido.id,
      order: order.id,
      status,
      versao: order.last_updated_date,
      valor: order.total_amount,
      moeda: order.currency,
      detalhe: order.status_detail,
      pagamento: pagamento?.id ?? null,
      referencia_pagamento: pagamento?.reference?.id ?? null,
      metodo: pagamento?.payment_method?.id ?? null,
      parcelas: pagamento?.payment_method?.installments ?? null,
      estornado: `${estornado / 100n}.${String(estornado % 100n).padStart(2, "0")}`,
      webhook,
    });
    return resultado;
  }
  async processarFila(limite = 5) {
    const eventos = await this.repo.executar<
      { chave: string; recurso: string; reserva: string; provedor?: string }[]
    >("reservar_eventos", { limite });
    let processados = 0;
    for (const evento of eventos) {
      let erro: string | null = null;
      try {
        if (evento.provedor === "payments") {
          const payment = await this.exigirPayments().obterPagamento(evento.recurso);
          const pedido = await this.repo.executar<PedidoPagamento | null>("pedido_referencia", {
            referencia: payment.external_reference,
          });
          if (!pedido) throw new Error("Pagamento ainda não vinculado.");
          this.exigirPayments().validarPagamento(payment, pedido);
          const vinculado = await this.repo.executar<PedidoPagamento>("vincular_payment", {
            id: pedido.id,
            pagamento: String(payment.id),
          });
          await this.aplicarPayment(vinculado, payment, true);
        } else {
          const pedido = await this.repo.executar<PedidoPagamento | null>("pedido_order", {
            order: evento.recurso,
          });
          if (!pedido) throw new Error("Order ainda não vinculada.");
          await this.sincronizar(pedido, true);
        }
        processados++;
      } catch {
        // Stable code, never payloads, bearer tokens, signatures or payer details.
        erro = "falha_consulta_ou_validacao_order";
      }
      await this.repo.executar("concluir_evento", {
        chave: evento.chave,
        reserva: evento.reserva,
        erro,
      });
    }
    return { recebidos: eventos.length, processados, falhas: eventos.length - processados };
  }
  async executarManutencao() {
    const inicio = Date.now();
    await this.repo.executar("manutencao");
    const fila = await this.processarFila(3);
    const pedidos = await this.repo.executar<PedidoPagamento[]>("conciliar", { limite: 3 });
    let conciliados = 0;
    let consultados = 0;
    for (const pedido of pedidos) {
      // Leave time for the current operation and response on bounded serverless invocations.
      if (Date.now() - inicio > 60_000) break;
      consultados++;
      try {
        if (pedido.id_order_mp || pedido.provedor === "payments") await this.sincronizar(pedido);
        else await this.completarCheckout(pedido);
        conciliados++;
      } catch {
        /* Durable inbox and the next scheduled reconciliation recover failures. */
      } finally {
        await this.repo.executar("marcar_consulta", { id: pedido.id });
      }
    }
    return { ...fila, conciliados, consultados };
  }
  async operacaoAdministrativa(
    id: string,
    administrador: string,
    acao: "cancelar" | "estornar",
    justificativa: string,
  ) {
    if (
      process.env.MERCADO_PAGO_FINANCIAL_OPERATIONS_ENABLED !== "true" ||
      (this.mercadoPago.config.ambiente === "producao" &&
        process.env.MERCADO_PAGO_PRODUCTION_OPERATIONS_AUTHORIZED !== "true")
    )
      throw new ErroRegraNegocioHttp(
        "Operações financeiras precisam ser habilitadas pelo responsável pela conta.",
        403,
      );
    // Deterministic UUID per order + operation, persisted in the audit before contacting the provider.
    const pedido = await this.repo.obterPedido(id);
    if (!pedido.id_order_mp && !pedido.idPagamentoMp)
      throw new ErroRegraNegocioHttp("Pedido sem pagamento confirmado.");
    await this.sincronizar(pedido);
    const hash = createHash("sha256").update(`${acao}:${pedido.id}`).digest("hex");
    const chave = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    await this.repo.executar("operacao_financeira", {
      id,
      administrador,
      acao,
      justificativa,
      chave,
    });
    if (pedido.provedor === "payments") {
      if (acao === "cancelar")
        await this.exigirPayments().cancelarPagamento(pedido.idPagamentoMp!, chave);
      else await this.exigirPayments().estornarPagamento(pedido.idPagamentoMp!, chave);
    } else if (acao === "cancelar")
      await this.mercadoPago.cancelarOrder(pedido.id_order_mp!, chave);
    else await this.mercadoPago.estornarOrder(pedido.id_order_mp!, chave);
    return this.sincronizar(await this.repo.obterPedido(id));
  }
}

export async function consultarMinhaAssinatura(cliente: SupabaseClient) {
  const resultados = await Promise.all([
    cliente.rpc("tem_acesso_premium"),
    cliente.from("assinaturas").select("*").order("criado_em", { ascending: false }).limit(100),
    cliente
      .from("pedidos_pagamento")
      .select(
        "id,id_plano,plano_nome,valor,moeda,status,id_order_mp,checkout_url,criado_em,expira_em,duracao_meses,provedor,id_pagamento_mp,status_pagamento_mp,detalhe_pagamento_mp,webhook_confirmado",
      )
      .order("criado_em", { ascending: false })
      .limit(100),
    cliente.from("pagamentos").select("*").order("criado_em", { ascending: false }).limit(100),
    cliente
      .from("historico_assinaturas")
      .select("*")
      .order("criado_em", { ascending: false })
      .limit(100),
    cliente
      .from("avisos_assinatura")
      .select("*")
      .order("criado_em", { ascending: false })
      .limit(10),
  ]);
  for (const r of resultados) if (r.error) throw r.error;
  const monetarios = (registros: Record<string, unknown>[] | null) =>
    registros?.map((r) => ({
      ...r,
      ...(r.valor === undefined ? {} : { valor: String(r.valor) }),
      ...(r.valor_estornado === undefined ? {} : { valor_estornado: String(r.valor_estornado) }),
    })) ?? [];
  return {
    premium: resultados[0]!.data === true,
    assinaturas: monetarios(resultados[1]!.data),
    pedidos: monetarios(resultados[2]!.data).map(apresentarPedidoFinanceiro),
    pagamentos: monetarios(resultados[3]!.data),
    historico: resultados[4]!.data,
    avisos: resultados[5]!.data,
    renovacaoAutomatica: false,
  };
}

export function apresentarPedidoFinanceiro(r: Record<string, unknown>) {
  const { id_pagamento_mp, status_pagamento_mp, detalhe_pagamento_mp, ...dados } = r;
  return {
    ...dados,
    valor: String(r.valor),
    provedor: r.provedor ?? "orders",
    idPagamentoMp: id_pagamento_mp ?? null,
    statusPagamentoMp: status_pagamento_mp ?? null,
    status_detail: detalhe_pagamento_mp ?? null,
    webhook_confirmado: r.webhook_confirmado === true,
  };
}
