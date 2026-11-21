type Schema = Record<string, unknown>;
const str: Schema = { type: "string" },
  uuid: Schema = { type: "string", format: "uuid" },
  dataHora: Schema = { type: "string", format: "date-time" };
const dinheiro: Schema = { type: "string", pattern: "^\\d{1,10}(\\.\\d{1,2})?$" };
const nullable = (s: Schema): Schema => ({ anyOf: [s, { type: "null" }] });
const array = (items: Schema): Schema => ({ type: "array", items });
const objeto = (
  properties: Record<string, Schema>,
  required: string[] = Object.keys(properties),
  extras = true,
): Schema => ({ type: "object", properties, required, additionalProperties: extras });
const estado: Schema = {
  type: "string",
  enum: [
    "pendente",
    "processando",
    "aprovado",
    "rejeitado",
    "cancelado",
    "estornado",
    "contestado",
  ],
};
const booleano: Schema = { type: "boolean" },
  inteiro: Schema = { type: "integer" };
const plano = objeto({
  id: uuid,
  codigo: str,
  nome: str,
  descricao: str,
  valor: dinheiro,
  moeda: { const: "BRL" },
  duracao_meses: { type: "integer", minimum: 1, maximum: 120 },
  beneficios: array(str),
  ordem: inteiro,
  ativo: booleano,
  destaque: booleano,
});
const pedido = objeto(
  {
    id: uuid,
    id_plano: uuid,
    plano_nome: str,
    valor: dinheiro,
    moeda: { const: "BRL" },
    status: estado,
    provedor: { type: "string", enum: ["payments", "orders"] },
    idPagamentoMp: nullable({ type: "string", pattern: "^[0-9]{1,30}$" }),
    statusPagamentoMp: nullable(str),
    status_detail: nullable(str),
    webhook_confirmado: booleano,
    id_order_mp: nullable(str),
    checkout_url: nullable(str),
    criado_em: dataHora,
    expira_em: dataHora,
    duracao_meses: inteiro,
    threeDsInfo: objeto({ externalResourceUrl: { type: "string", format: "uri" }, creq: str }),
    desafioIndisponivel: booleano,
  },
  [
    "id",
    "id_plano",
    "plano_nome",
    "valor",
    "moeda",
    "status",
    "provedor",
    "idPagamentoMp",
    "statusPagamentoMp",
    "status_detail",
    "webhook_confirmado",
    "id_order_mp",
    "checkout_url",
    "criado_em",
    "expira_em",
    "duracao_meses",
  ],
);
const assinatura = objeto({
  id: uuid,
  id_pessoa: uuid,
  id_pedido: uuid,
  id_pagamento: nullable(uuid),
  id_plano: uuid,
  plano_nome: str,
  valor: dinheiro,
  duracao_meses: inteiro,
  beneficios: array(str),
  status: { type: "string", enum: ["pendente", "ativa", "expirada", "cancelada", "suspensa"] },
  inicio_em: nullable(dataHora),
  fim_em: nullable(dataHora),
  cancelamento_em: nullable(dataHora),
  criado_em: dataHora,
  atualizado_em: dataHora,
});
const payment = objeto({
  id: uuid,
  id_pedido: uuid,
  id_pessoa: uuid,
  id_plano: uuid,
  id_order_mp: nullable(str),
  id_pagamento_mp: nullable(str),
  referencia_pagamento_mp: nullable(str),
  valor: dinheiro,
  moeda: { const: "BRL" },
  status: estado,
  metodo: nullable(str),
  parcelas: nullable(inteiro),
  valor_estornado: dinheiro,
  aprovado_em: nullable(dataHora),
  criado_em: dataHora,
  atualizado_em: dataHora,
  detalhe_status: nullable(str),
});
(assinatura.properties as Record<string, Schema>).email = { type: "string", format: "email" };
(payment.properties as Record<string, Schema>).email = { type: "string", format: "email" };
(payment.properties as Record<string, Schema>).plano_nome = { type: "string" };
const historico = objeto({
  id: { type: "integer" },
  id_pessoa: uuid,
  id_assinatura: nullable(uuid),
  tipo: str,
  dados: { type: "object", additionalProperties: true },
  id_administrador: nullable(uuid),
  chave: nullable(str),
  criado_em: dataHora,
});
const aviso = objeto({
  id: uuid,
  id_pessoa: uuid,
  id_assinatura: uuid,
  dias: inteiro,
  fim_em: dataHora,
  mensagem: str,
  criado_em: dataHora,
});
const evento = objeto(
  {
    chave: str,
    recurso: str,
    provedor: { enum: ["orders", "payments"] },
    ambiente: { enum: ["teste", "producao"] },
    status: { enum: ["falha"] },
    tentativas: inteiro,
    erro: nullable(str),
    recebido_em: dataHora,
  },
  ["chave", "recurso", "status", "tentativas"],
);
const painel = objeto({
  ambiente: { enum: ["teste", "producao"] },
  pagina: inteiro,
  planos: array(plano),
  pagamentos: array(payment),
  assinaturas: array(assinatura),
  historico: array(historico),
  eventosFalhos: array(evento),
  cancelamentos: array(historico),
  aprovadosSemWebhook: array(pedido),
  checkoutsInconclusivos: array(pedido),
  indicadores: objeto({
    bruto: dinheiro,
    estornos: dinheiro,
    contestado: dinheiro,
    liquidoEstimado: dinheiro,
    pendentes: inteiro,
    aprovados: inteiro,
    rejeitados: inteiro,
  }),
  ativos: inteiro,
  porPlano: array(objeto({ plano_nome: str, quantidade: inteiro })),
  vencendo: inteiro,
  renovacoes: inteiro,
});
const pagamentoBrick = objeto(
  {
    payment_method_id: { type: "string", pattern: "^[a-z0-9_]{1,60}$" },
    token: { type: "string", minLength: 1, maxLength: 512, writeOnly: true },
    installments: { type: "integer", minimum: 1, maximum: 12 },
    issuer_id: { type: "string", pattern: "^[0-9]{1,30}$" },
    three_d_secure_mode: { const: "optional" },
    payer: objeto(
      {
        email: { type: "string", format: "email", maxLength: 254 },
        identification: objeto(
          {
            type: { enum: ["CPF", "CNPJ"] },
            number: { type: "string", pattern: "^(?:[0-9]{11}|[0-9]{14})$" },
          },
          undefined,
          false,
        ),
        first_name: { type: "string", minLength: 1, maxLength: 100 },
        last_name: { type: "string", minLength: 1, maxLength: 100 },
      },
      ["email", "identification"],
      false,
    ),
  },
  ["payment_method_id", "payer"],
  false,
);
pagamentoBrick.description =
  "Crédito: token e installments obrigatórios, issuer_id opcional; servidor define3DS optional. Pix: payment_method_id=pix, sem token/parcelas/emissor/3DS. Outros meios recusados. Nunca enviar PAN/CVV/valor/itens.";
function envelope(data: Schema, success = true): Schema {
  return objeto({
    success: { const: success },
    message: str,
    statusCode: inteiro,
    data: success ? data : { type: "null" },
  });
}
export function completarDocumentacaoFinanceira(
  paths: Record<string, any>,
  schemas: Record<string, unknown>,
) {
  const config = objeto({
    publicKey: str,
    ambiente: { enum: ["teste", "producao"] },
    maxParcelas: { type: "integer", minimum: 1, maximum: 12 },
    meiosPagamento: { type: "array", items: { enum: ["credit_card", "pix"] } },
  });
  const meus = objeto({
    premium: booleano,
    assinaturas: array(assinatura),
    pedidos: array(pedido),
    pagamentos: array(payment),
    historico: array(historico),
    avisos: array(aviso),
    renovacaoAutomatica: { const: false },
  });
  const outputs: Record<string, Schema> = {
    configuracao: config,
    planos: array(plano),
    acesso: objeto({ premium: booleano, vigenciaAte: nullable(dataHora) }),
    "minha-assinatura": meus,
    checkout: pedido,
    pedido,
    sincronizar: pedido,
    cancelamento: objeto({ recebido: booleano, mensagem: str }),
    "admin/painel": painel,
    "admin/planos": plano,
    "admin/sincronizar": pedido,
    "admin/operacao": pedido,
    "admin/reprocessar": { type: "boolean" },
    webhook: objeto({ recebido: booleano }),
    tarefas: objeto({
      recebidos: inteiro,
      processados: inteiro,
      falhas: inteiro,
      conciliados: inteiro,
      consultados: inteiro,
    }),
  };
  const nomeados: Record<string, Schema> = {
    FinanceiroPlano: plano,
    FinanceiroPedido: pedido,
    FinanceiroAssinatura: assinatura,
    FinanceiroPagamento: payment,
    FinanceiroHistorico: historico,
    FinanceiroAviso: aviso,
    FinanceiroPainel: painel,
    FinanceiroConfiguracao: config,
    FinanceiroMinhaAssinatura: meus,
    FinanceiroPagamentoBrick: pagamentoBrick,
  };
  Object.assign(schemas, nomeados);
  const ref = (nome: string) => ({ $ref: "#/components/schemas/" + nome });
  Object.assign(outputs, {
    configuracao: ref("FinanceiroConfiguracao"),
    planos: array(ref("FinanceiroPlano")),
    checkout: ref("FinanceiroPedido"),
    pedido: ref("FinanceiroPedido"),
    sincronizar: ref("FinanceiroPedido"),
    "admin/sincronizar": ref("FinanceiroPedido"),
    "admin/operacao": ref("FinanceiroPedido"),
    "admin/planos": ref("FinanceiroPlano"),
    "admin/painel": ref("FinanceiroPainel"),
    "minha-assinatura": ref("FinanceiroMinhaAssinatura"),
  });
  for (const [rota, output] of Object.entries(outputs)) {
    const path = "/api/financeiro/" + rota;
    if (rota === "configuracao")
      paths[path] = {
        get: {
          operationId: "Financeiro_configuracao_get",
          tags: ["Financeiro"],
          description: "Configuração pública segura do Payment Brick/Status Screen",
        },
      };
    for (const [metodo, op] of Object.entries(paths[path]) as [string, Record<string, any>][]) {
      op.security = ["configuracao", "planos", "webhook"].includes(rota)
        ? []
        : rota === "tarefas"
          ? [{ agendadorBearerAuth: [] }]
          : [{ cookieAuth: [] }, { bearerAuth: [] }];
      op.responses = {
        200: {
          description:
            "Operação concluída; aprovação financeira não substitui confirmação assinada para Premium",
          content: { "application/json": { schema: envelope(output) } },
        },
      };
      for (const code of [400, 401, 403, 404, 405, 409, 413, 429, 500, 502, 503])
        op.responses[code] = {
          description:
            code === 409
              ? "Conflito/reserva ou pagamento ainda em conciliação; não criar outra cobrança"
              : "Operação recusada",
          content: { "application/json": { schema: envelope({}, false) } },
          ...(code === 429 ? { headers: { "Retry-After": { schema: inteiro } } } : {}),
        };
      if (["post", "put"].includes(metodo) && !["webhook", "tarefas"].includes(rota)) {
        op.description =
          (op.description ?? "") +
          " Sessão por cookies exige Origin permitido e X-Siso-Aprova-Client:web (ou alias X-Concursa-Client:web); Bearer autorizado dispensaCSRF.";
        op.parameters = [
          ...(op.parameters ?? []),
          { in: "header", name: "X-Siso-Aprova-Client", required: false, schema: { const: "web" } },
          {
            in: "header",
            name: "Origin",
            required: false,
            schema: { type: "string", format: "uri" },
          },
        ];
      }
      if (rota === "checkout")
        op.requestBody = {
          required: true,
          content: {
            "application/json": {
              schema: objeto({ idPlano: uuid, pagamento: pagamentoBrick }, undefined, false),
            },
          },
        };
      if (rota === "admin/painel")
        op.parameters = [
          ...(op.parameters ?? []),
          {
            in: "query",
            name: "ambiente",
            required: false,
            schema: { enum: ["teste", "producao"] },
            description:
              "Padrão: ambiente financeiro atual; aplicado às listas e indicadores. Status é o estado financeiro do pedido para todas as coleções; datas de/ate referem-se à criação do pedido.",
          },
        ];
      if (rota === "planos") op.description = "Catálogo público ativo; moedaBRL e preço do banco";
      if (rota === "webhook")
        op.description =
          "Payments: data.id numérico1–30 e tópicopayment; histórico Orders: ORD/ORDTST e tópicoorder. HMAC obrigatório, janela5min, consulta ao provedor e inbox durável antes do200.";
    }
  }
}
