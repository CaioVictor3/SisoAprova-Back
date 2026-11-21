import {
  ClientePaymentsMercadoPago,
  validarPagamentoBrick,
  validarWebhookPayments,
} from "../infrastructure/cliente-payments-mercado-pago.js";
import { cookiesParaResposta } from "../security/cookies.js";
import { lerBytesLimitados } from "../security/corpo.js";
import { aplicarCabecalhos, redacaoLogs } from "../security/headers.mjs";
import { restringirRecuperacao } from "../security/sessoes.js";
import { ipConfiavel, exigirIp, limitesAplicacao } from "../security/rate-limit.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { pino } from "pino";
import { after, NextResponse, type NextRequest } from "next/server";
import {
  carregarMercadoPago,
  configuracaoPublicaMercadoPago,
  configuracaoOrdersLegada,
} from "../config/configuracoes-mercado-pago.js";
import { carregarConfiguracoesAmbiente } from "../config/configuracoes-ambiente.js";
import {
  consultarMinhaAssinatura,
  apresentarPedidoFinanceiro,
  ServicoPagamentosAssinaturas,
} from "../application/pagamentos-assinaturas.service.js";
import {
  classificarErroAplicacao,
  criarRespostaErro,
  criarRespostaSucesso,
  ErroRegraNegocioHttp,
  obterCodigoErroAplicacao,
} from "../domain/erros-validacoes-respostas-api.js";
import { decimalMonetario } from "../domain/pagamentos-assinaturas.js";
import {
  ClienteMercadoPago,
  validarAssinaturaMercadoPago,
} from "../infrastructure/cliente-mercado-pago.js";
import { RepositorioPagamentosSupabase } from "../infrastructure/repositorio-pagamentos-supabase.js";
import { criarClienteSupabaseAdministrativo } from "../utils/supabase/admin.js";
import {
  criarClienteSupabaseRequisicao,
  type CookieSupabasePendente,
} from "../utils/supabase/server.js";

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const ambiente = carregarConfiguracoesAmbiente(process.env, { supabase: true });
const loggerFinanceiro = pino({
  name: "financeiro",
  level: ambiente.logLevel,
  redact: redacaoLogs,
});
export function identificadorFinanceiro(valor: unknown) {
  if (typeof valor !== "string" || !uuid.test(valor))
    throw new ErroRegraNegocioHttp("Identificador inválido.");
  return valor;
}
function texto(valor: unknown, limite: number, minimo = 1) {
  if (typeof valor !== "string" || valor.trim().length < minimo || valor.length > limite)
    throw new ErroRegraNegocioHttp("Confira os campos informados.");
  return valor.trim();
}
async function corpoJson(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 16384)
    throw new ErroRegraNegocioHttp("Requisição muito grande.", 413);
  const bytes = await lerBytesLimitados(req, 16384);
  if (bytes.byteLength > 16384) throw new ErroRegraNegocioHttp("Requisição muito grande.", 413);
  try {
    const valor: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!valor || typeof valor !== "object" || Array.isArray(valor)) throw new Error();
    return valor as Record<string, unknown>;
  } catch {
    throw new ErroRegraNegocioHttp("Envie um objeto JSON válido.");
  }
}
export function validarPlanoComercial(dados: Record<string, unknown>, exigirId = false) {
  if (exigirId) identificadorFinanceiro(dados.id);
  let valor: string;
  try {
    valor = decimalMonetario(dados.valor);
  } catch {
    throw new ErroRegraNegocioHttp(
      "Informe um valor monetário válido com até duas casas decimais.",
    );
  }
  const meses = dados.duracao_meses;
  const ordem = dados.ordem;
  if (
    valor === "0.00" ||
    typeof meses !== "number" ||
    !Number.isInteger(meses) ||
    meses < 1 ||
    meses > 120 ||
    typeof ordem !== "number" ||
    !Number.isInteger(ordem) ||
    ordem < 0 ||
    ordem > 1000 ||
    typeof dados.ativo !== "boolean" ||
    typeof dados.destaque !== "boolean" ||
    !Array.isArray(dados.beneficios) ||
    dados.beneficios.length > 30
  )
    throw new ErroRegraNegocioHttp("Confira o valor e as condições do plano.");
  return {
    id: dados.id == null ? null : identificadorFinanceiro(dados.id),
    codigo: texto(dados.codigo, 60),
    nome: texto(dados.nome, 100),
    descricao: typeof dados.descricao === "string" ? dados.descricao.slice(0, 2000) : "",
    valor,
    duracao_meses: meses,
    ordem,
    ativo: dados.ativo,
    destaque: dados.destaque,
    beneficios: dados.beneficios.map((b) => texto(b, 250)),
  };
}
function servico() {
  const config = carregarMercadoPago();
  return new ServicoPagamentosAssinaturas(
    new RepositorioPagamentosSupabase(criarClienteSupabaseAdministrativo()),
    new ClienteMercadoPago(configuracaoOrdersLegada(config)),
    new ClientePaymentsMercadoPago(config),
  );
}
function validarAgendador(req: Request) {
  const secreto = process.env.MERCADO_PAGO_MAINTENANCE_AUTHORIZATION_SECRET ?? "";
  const recebido = req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
  if (
    secreto.length < 32 ||
    !timingSafeEqual(
      createHash("sha256").update(secreto).digest(),
      createHash("sha256").update(recebido).digest(),
    )
  )
    throw new ErroRegraNegocioHttp("Agendador não autorizado.", 401);
}

export function criarAtendedorFinanceiro(
  criarCliente = criarClienteSupabaseRequisicao,
  dependencias: {
    criarAdmin?: typeof criarClienteSupabaseAdministrativo;
    criarServico?: typeof servico;
    agendar?: typeof after;
  } = {},
) {
  return async function atenderFinanceiro(req: NextRequest) {
    const requestId = randomUUID();
    const caminho = new URL(req.url).pathname.replace(/\/$/, "");
    const url = new URL(req.url);
    const origem = req.headers.get("origin");
    const origens = ambiente.origins;
    const cookies: CookieSupabasePendente[] = [];
    const cabecalhosSessao: Record<string, string> = {};
    function responder(dados: unknown, status = 200) {
      const resposta = NextResponse.json(dados, { status });
      if (status === 429) resposta.headers.set("Retry-After", "60");
      if (status === 405) resposta.headers.set("Allow", "POST");
      resposta.headers.set("Cache-Control", "no-store");
      resposta.headers.set("X-Request-Id", requestId);
      resposta.headers.set("X-Content-Type-Options", "nosniff");
      resposta.headers.set("Vary", "Origin");
      if (origem && origens.includes(origem)) {
        resposta.headers.set("Access-Control-Allow-Origin", origem);
        resposta.headers.set("Access-Control-Allow-Credentials", "true");
      }
      for (const c of cookiesParaResposta(cookies, status))
        resposta.cookies.set(c.nome, c.valor, c.opcoes);
      for (const [nome, valor] of Object.entries(cabecalhosSessao))
        resposta.headers.set(nome, valor);
      aplicarCabecalhos(resposta);
      return resposta;
    }
    try {
      if (req.method === "OPTIONS") {
        if (origem && !origens.includes(origem))
          throw new ErroRegraNegocioHttp("Origem não autorizada.", 403);
        const resposta = responder(criarRespostaSucesso({}, "OK"));
        resposta.headers.set(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-Concursa-Client, X-Siso-Aprova-Client, X-Idempotency-Key",
        );
        resposta.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
        aplicarCabecalhos(resposta);
        return resposta;
      }
      if (caminho === "/api/financeiro/configuracao" && req.method === "GET")
        return responder(
          criarRespostaSucesso(configuracaoPublicaMercadoPago(), "Configuração de pagamento."),
        );
      if (caminho === "/api/financeiro/webhook" && req.method === "POST") {
        const ip = ipConfiavel(req, ambiente.trustProxy);
        if (!ip && ambiente.production) exigirIp(req, ambiente.trustProxy);
        if (ip) limitesAplicacao.consumir("webhook-mp:" + ip, 600);
        const config = carregarMercadoPago();
        const tipo = url.searchParams.get("type");
        const payment = /^\d{1,30}$/.test(url.searchParams.get("data.id") ?? "");
        if (tipo && tipo !== (payment ? "payment" : "order"))
          throw new ErroRegraNegocioHttp("Tópico inválido.", 401);
        const evento = payment
          ? validarWebhookPayments(req, config.webhookSecret)
          : validarAssinaturaMercadoPago(
              req,
              process.env.MERCADO_PAGO_ORDERS_WEBHOOK_SIGNING_SECRET ?? config.webhookSecret,
            );
        await corpoJson(req); // bounded envelope; no financial field from the body is trusted.
        const pagamentos = (dependencias.criarServico ?? servico)();
        await pagamentos.repo.executar("receber_webhook", {
          chave: evento.chave,
          order: evento.id,
          provedor: payment ? "payments" : "orders",
          ambiente: config.ambiente,
        });
        (dependencias.agendar ?? after)(async () => {
          try {
            await pagamentos.processarFila(2);
          } catch {
            /* persisted event remains recoverable */
          }
        });
        return responder(criarRespostaSucesso({ recebido: true }, "Evento recebido."));
      }
      if (caminho === "/api/financeiro/tarefas" && req.method !== "POST")
        throw new ErroRegraNegocioHttp("Método não permitido.", 405);
      if (caminho === "/api/financeiro/tarefas" && req.method === "POST") {
        validarAgendador(req);
        return responder(
          criarRespostaSucesso(
            await (dependencias.criarServico ?? servico)().executarManutencao(),
            "Manutenção financeira concluída.",
          ),
        );
      }
      if (
        !["GET", "HEAD"].includes(req.method) &&
        !req.headers.get("authorization")?.match(/^Bearer /i)
      ) {
        const clientHeader =
          req.headers.get("x-siso-aprova-client") ?? req.headers.get("x-concursa-client");
        if (clientHeader !== "web" || !origem || !origens.includes(origem))
          throw new ErroRegraNegocioHttp("Origem da solicitação não autorizada.", 403);
      }
      const cliente = criarCliente(req, (valores, headers) => {
        cookies.push(...valores);
        Object.assign(cabecalhosSessao, headers);
      });
      await restringirRecuperacao(
        cliente,
        caminho,
        req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1],
      );
      if (caminho === "/api/financeiro/planos" && req.method === "GET") {
        const { data, error } = await cliente
          .from("planos_comerciais")
          .select(
            "id,codigo,nome,descricao,valor,moeda,duracao_meses,ativo,destaque,ordem,beneficios",
          )
          .eq("ativo", true)
          .order("ordem");
        if (error) throw error;
        return responder(
          criarRespostaSucesso(
            data.map((p) => ({ ...p, valor: String(p.valor) })),
            "Planos disponíveis.",
          ),
        );
      }
      const auth = await cliente.auth.getUser();
      if (auth.error || !auth.data.user)
        throw new ErroRegraNegocioHttp("Entre na sua conta para continuar.", 401);
      const pessoa = auth.data.user.id;
      const { data: usuario, error: erroUsuario } = await cliente
        .from("usuarios")
        .select("tipo,estado_cadastro,cadastro_completo")
        .eq("idUsuario", pessoa)
        .single();
      if (erroUsuario || usuario.estado_cadastro !== "ativo")
        throw new ErroRegraNegocioHttp("Conta indisponível.", 403);
      const admin = caminho.startsWith("/api/financeiro/admin/");
      if (admin && usuario.tipo !== "administrador")
        throw new ErroRegraNegocioHttp("Você não possui permissão para esta operação.", 403);
      if (!admin && usuario.tipo !== "estudante")
        throw new ErroRegraNegocioHttp("Esta operação é destinada a estudantes.", 403);
      if (req.method !== "GET") {
        await new RepositorioPagamentosSupabase(
          (dependencias.criarAdmin ?? criarClienteSupabaseAdministrativo)(),
        ).executar("limitar_requisicao", {
          chave: `${admin ? "admin" : "estudante"}:${pessoa}`,
          limite: admin ? 30 : 10,
        });
      }
      let dados: unknown;
      if (caminho === "/api/financeiro/acesso" && req.method === "GET") {
        const { data: vigenciaAte, error } = await cliente.rpc("vigencia_acesso_premium");
        if (error) throw error;
        dados = { premium: vigenciaAte != null, vigenciaAte };
      } else if (caminho === "/api/financeiro/minha-assinatura" && req.method === "GET") {
        dados = await consultarMinhaAssinatura(cliente);
      } else if (caminho === "/api/financeiro/checkout" && req.method === "POST") {
        const corpo = await corpoJson(req);
        if (Object.keys(corpo).some((k) => !["idPlano", "pagamento"].includes(k)))
          throw new ErroRegraNegocioHttp("Envie o plano e os dados do pagamento.");
        dados = await (dependencias.criarServico ?? servico)().iniciarCheckout(
          pessoa,
          identificadorFinanceiro(corpo.idPlano),
          identificadorFinanceiro(req.headers.get("x-idempotency-key")),
          validarPagamentoBrick(corpo.pagamento),
        );
      } else if (caminho === "/api/financeiro/pedido" && req.method === "GET") {
        const { data, error } = await cliente
          .from("pedidos_pagamento")
          .select(
            "id,id_plano,plano_nome,valor,moeda,status,id_order_mp,checkout_url,criado_em,expira_em,duracao_meses,provedor,id_pagamento_mp,status_pagamento_mp,detalhe_pagamento_mp,webhook_confirmado",
          )
          .eq("id", identificadorFinanceiro(url.searchParams.get("id")))
          .eq("id_pessoa", pessoa)
          .single();
        if (error || !data) throw new ErroRegraNegocioHttp("Pedido não encontrado.", 404);
        dados = apresentarPedidoFinanceiro(data);
        if (
          data.provedor === "payments" &&
          data.status_pagamento_mp === "pending" &&
          data.detalhe_pagamento_mp === "pending_challenge"
        ) {
          const pagamentos = (dependencias.criarServico ?? servico)();
          dados = await pagamentos.sincronizar(await pagamentos.repo.obterPedido(data.id));
        }
      } else if (caminho === "/api/financeiro/sincronizar" && req.method === "POST") {
        const corpo = await corpoJson(req);
        const pagamentos = (dependencias.criarServico ?? servico)();
        const pedido = await pagamentos.repo.obterPedido(identificadorFinanceiro(corpo.id));
        if (pedido.id_pessoa !== pessoa)
          throw new ErroRegraNegocioHttp("Pedido não encontrado.", 404);
        if (pedido.provedor === "orders" && !pedido.id_order_mp)
          dados = await pagamentos.completarCheckout(pedido);
        else {
          await pagamentos.repo.executar("limitar_sincronizacao", { id: pedido.id });
          dados = await pagamentos.sincronizar(pedido);
        }
      } else if (caminho === "/api/financeiro/cancelamento" && req.method === "POST") {
        const corpo = await corpoJson(req);
        const repo = new RepositorioPagamentosSupabase(
          (dependencias.criarAdmin ?? criarClienteSupabaseAdministrativo)(),
        );
        dados = await repo.executar("solicitar_cancelamento", {
          pessoa,
          id: identificadorFinanceiro(corpo.id),
          justificativa: texto(corpo.justificativa, 2000, 10),
        });
      } else if (caminho === "/api/financeiro/admin/painel" && req.method === "GET") {
        const pagina = Number(url.searchParams.get("pagina") ?? "1");
        if (!Number.isInteger(pagina) || pagina < 1 || pagina > 100000)
          throw new ErroRegraNegocioHttp("Página inválida.");
        const filtros = validarFiltrosFinanceiros(url);
        dados = await new RepositorioPagamentosSupabase(
          (dependencias.criarAdmin ?? criarClienteSupabaseAdministrativo)(),
        ).executar("painel", {
          ...filtros,
          administrador: pessoa,
          pagina,
          pessoa: url.searchParams.get("pessoa")
            ? identificadorFinanceiro(url.searchParams.get("pessoa"))
            : null,
          plano: url.searchParams.get("plano")
            ? identificadorFinanceiro(url.searchParams.get("plano"))
            : null,
          status: url.searchParams.get("status"),
          de: url.searchParams.get("de"),
          ate: url.searchParams.get("ate"),
          vencimento: url.searchParams.get("vencimento"),
        });
      } else if (
        caminho === "/api/financeiro/admin/planos" &&
        ["POST", "PUT"].includes(req.method)
      ) {
        dados = await new RepositorioPagamentosSupabase(
          (dependencias.criarAdmin ?? criarClienteSupabaseAdministrativo)(),
        ).executar("salvar_plano", {
          ...validarPlanoComercial(await corpoJson(req), req.method === "PUT"),
          administrador: pessoa,
        });
      } else if (caminho === "/api/financeiro/admin/reprocessar" && req.method === "POST") {
        dados = await new RepositorioPagamentosSupabase(
          (dependencias.criarAdmin ?? criarClienteSupabaseAdministrativo)(),
        ).executar("reprocessar_eventos", { administrador: pessoa });
      } else if (caminho === "/api/financeiro/admin/sincronizar" && req.method === "POST") {
        const corpo = await corpoJson(req);
        const pagamentos = (dependencias.criarServico ?? servico)();
        const id = identificadorFinanceiro(corpo.id);
        await pagamentos.repo.executar("auditar", {
          administrador: pessoa,
          acao: "sincronizar",
          id,
        });
        dados = await pagamentos.sincronizar(await pagamentos.repo.obterPedido(id));
      } else if (caminho === "/api/financeiro/admin/operacao" && req.method === "POST") {
        const corpo = await corpoJson(req);
        if (corpo.acao !== "cancelar" && corpo.acao !== "estornar")
          throw new ErroRegraNegocioHttp("Operação inválida.");
        dados = await (dependencias.criarServico ?? servico)().operacaoAdministrativa(
          identificadorFinanceiro(corpo.id),
          pessoa,
          corpo.acao,
          texto(corpo.justificativa, 2000, 10),
        );
      } else throw new ErroRegraNegocioHttp("Endpoint não encontrado.", 404);
      return responder(criarRespostaSucesso(dados, "Operação concluída."));
    } catch (erro) {
      const resultado = classificarErroAplicacao(erro);
      loggerFinanceiro.warn(
        {
          requestId,
          path: caminho,
          status: resultado.status,
          errorCode: obterCodigoErroAplicacao(erro),
          errorType: erro instanceof Error ? erro.name : "DatabaseError",
        },
        "Operação financeira recusada",
      );
      return responder(
        {
          ...criarRespostaErro(resultado.status, resultado.message),
          ...(obterCodigoErroAplicacao(erro) === "PAYMENT_NOT_CREATED"
            ? { code: "PAYMENT_NOT_CREATED", retryable: true }
            : {}),
        },
        resultado.status,
      );
    }
  };
}
export const atenderFinanceiro = criarAtendedorFinanceiro();

export function validarFiltrosFinanceiros(url: URL) {
  const ambiente = url.searchParams.get("ambiente");
  if (ambiente !== null && !["teste", "producao"].includes(ambiente))
    throw new ErroRegraNegocioHttp("Ambiente inválido.", 400);
  const datas: Record<string, string | null> = {};
  for (const k of ["de", "ate", "vencimento"]) {
    const d = url.searchParams.get(k);
    datas[k] = d;
    if (
      d !== null &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        !Number.isFinite(Date.parse(d)) ||
        new Date(d).toISOString().slice(0, 10) !== d)
    )
      throw new ErroRegraNegocioHttp("Data inválida.", 400);
  }
  if (datas.de && datas.ate && datas.de > datas.ate)
    throw new ErroRegraNegocioHttp("Intervalo de datas inválido.", 400);
  const status = url.searchParams.get("status");
  if (
    status !== null &&
    ![
      "pendente",
      "processando",
      "aprovado",
      "rejeitado",
      "cancelado",
      "estornado",
      "contestado",
    ].includes(status)
  )
    throw new ErroRegraNegocioHttp("Status inválido.", 400);
  return { ambiente };
}
