import { cookiesParaResposta } from "../security/cookies.js";
import { lerBytesLimitados } from "../security/corpo.js";
import { aplicarCabecalhos, redacaoLogs } from "../security/headers.mjs";
import { restringirRecuperacao } from "../security/sessoes.js";
import {
  ipConfiavel,
  exigirIp,
  limitarAutenticacao,
  limitesAplicacao,
} from "../security/rate-limit.js";
import { reautenticarSenha } from "../utils/supabase/server.js";
import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { pino } from "pino";
import { ServicoAutenticacaoContasSessoes } from "../application/autenticacao-contas-sessoes.service.js";
import { importarProva } from "../application/importacao-prova.service.js";
import { criarServicosAplicacaoApi } from "../application/composicao-servicos-api.js";
import { carregarConfiguracoesAmbiente } from "../config/configuracoes-ambiente.js";
import routes from "../contracts/rotas-publicas-api.json" with { type: "json" };
import {
  classificarErroAplicacao,
  criarRespostaErro,
  criarRespostaSucesso,
  ErroRegraNegocioHttp,
  estruturaBancoAusente,
  obterCodigoErroAplicacao,
} from "../domain/erros-validacoes-respostas-api.js";
import { criarDespachoOperacoesApi } from "./despacho-operacoes-rotas-api.js";
import {
  atenderRotaAdicionalNext,
  correspondeRotaAdicional,
} from "./atender-rotas-adicionais-next.js";
import {
  atenderAutenticacaoSupabaseNext,
  correspondeRotaAutenticacaoSupabase,
} from "./autenticacao-supabase-next.js";
import { gerarDocumentoOpenApi } from "./documentacao-openapi.js";
import { ClienteAnaliseQuestoesOpenAI } from "../infrastructure/cliente-analise-questoes-openai.js";
import { ClienteAutenticacaoGoogle } from "../infrastructure/cliente-autenticacao-google.js";
import {
  ConexaoTransacoesPostgreSql,
  type IdentidadeUsuarioAutenticado,
} from "../infrastructure/conexao-transacoes-postgresql.js";
import { ServicoEnvioEmailsTransacionaisResend } from "../infrastructure/envio-emails-transacionais-resend.js";
import { RepositorioContasSessoesPostgreSql } from "../infrastructure/repositorio-contas-sessoes-postgresql.js";
import { criarClienteSupabaseRequisicao } from "../utils/supabase/server.js";
import { temCookieSessaoSupabase } from "../utils/supabase/opcoes-cookie-sessao.js";
import { RepositorioConsultasNegocioSupabase } from "../infrastructure/repositorio-consultas-supabase.js";
import { ServicoComunicacaoSupabase } from "../infrastructure/comunicacao-supabase.js";
import { criarClienteSupabaseAdministrativo } from "../utils/supabase/admin.js";

const config = carregarConfiguracoesAmbiente(process.env, { supabase: true });
const logger = pino({
  level: config.logLevel,
  redact: redacaoLogs,
});
const db = new ConexaoTransacoesPostgreSql(config);
const emails = new ServicoEnvioEmailsTransacionaisResend(db, config, fetch);
const auth = new ServicoAutenticacaoContasSessoes(
  config,
  new RepositorioContasSessoesPostgreSql(db),
  emails,
  new ClienteAutenticacaoGoogle(config, fetch),
);
const openai = new ClienteAnaliseQuestoesOpenAI(config, fetch);
const documentoOpenApi = gerarDocumentoOpenApi();
const limitarRequisicoes = (chave: string, limite: number) =>
  limitesAplicacao.consumir(chave, limite);

type MetodoHttp = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
type ContextoNext = { params: Promise<{ path: string[] }> };
type CookiePendente = {
  nome: string;
  valor: string;
  opcoes: Record<string, unknown>;
};

async function lerCorpoJson(requisicao: Request, limite = 10 * 1024 * 1024): Promise<unknown> {
  const tamanhoDeclarado = Number(requisicao.headers.get("content-length") ?? "0");
  if (tamanhoDeclarado > limite) {
    throw new ErroRegraNegocioHttp("A requisição excede o tamanho permitido.", 413);
  }

  const bytes = await lerBytesLimitados(requisicao, limite);
  if (bytes.byteLength > limite) {
    throw new ErroRegraNegocioHttp("A requisição excede o tamanho permitido.", 413);
  }
  if (!bytes.byteLength) return undefined;

  if (!requisicao.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ErroRegraNegocioHttp("Envie um objeto JSON válido.", 415);
  }

  try {
    const dados: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (dados === null || typeof dados !== "object") throw new Error("JSON inválido");
    return dados;
  } catch {
    throw new ErroRegraNegocioHttp("Envie um objeto JSON válido.");
  }
}

function consultarParametros(url: URL) {
  const consulta: Record<string, string | string[]> = {};
  for (const [chave, valor] of url.searchParams) {
    const atual = consulta[chave];
    consulta[chave] =
      atual === undefined ? valor : Array.isArray(atual) ? [...atual, valor] : [atual, valor];
  }
  return consulta;
}

function responder(
  conteudo: unknown,
  status: number,
  requisicao: Request,
  identificador: string,
  cookiesPendentes: CookiePendente[],
) {
  const origem = requisicao.headers.get("origin");
  const resposta = NextResponse.json(conteudo, { status });
  if (status === 429) resposta.headers.set("Retry-After", "60");
  resposta.headers.set("Cache-Control", "no-store");
  resposta.headers.set("X-Request-Id", identificador);
  resposta.headers.set("X-Content-Type-Options", "nosniff");
  resposta.headers.set("Vary", "Origin");
  if (origem && config.origins.includes(origem)) {
    resposta.headers.set("Access-Control-Allow-Origin", origem);
    resposta.headers.set("Access-Control-Allow-Credentials", "true");
  }

  for (const cookie of cookiesParaResposta(cookiesPendentes, status)) {
    resposta.cookies.set(cookie.nome, cookie.valor, cookie.opcoes);
  }

  aplicarCabecalhos(resposta);
  return resposta;
}

async function processarWebhook(
  requisicao: Request,
  servicoEmails: Pick<ServicoEnvioEmailsTransacionaisResend, "validarAssinaturaWebhook"> = emails,
  criarAdmin: typeof criarClienteSupabaseAdministrativo = criarClienteSupabaseAdministrativo,
) {
  const bytes = await lerBytesLimitados(requisicao, 65536);
  if (
    bytes.length > 65536 ||
    !servicoEmails.validarAssinaturaWebhook(
      requisicao.headers.get("svix-id") ?? "",
      requisicao.headers.get("svix-timestamp") ?? "",
      requisicao.headers.get("svix-signature") ?? "",
      bytes,
    )
  ) {
    throw new ErroRegraNegocioHttp("Assinatura do webhook inválida.", 401);
  }
  let evento: { type?: unknown; data?: { email_id?: unknown } };
  try {
    evento = JSON.parse(bytes.toString());
  } catch {
    throw new ErroRegraNegocioHttp("Evento inválido.");
  }
  if (typeof evento.type !== "string" || typeof evento.data?.email_id !== "string") {
    throw new ErroRegraNegocioHttp("Evento inválido.");
  }
  if (evento.type.trim() && evento.data.email_id.trim()) {
    const { error } = await criarAdmin().rpc("registrar_evento_resend_backend", {
      p_webhook: requisicao.headers.get("svix-id")!,
      p_idmensagem: evento.data.email_id,
      p_evento: evento.type,
    });
    if (error) throw error;
  }
  return criarRespostaSucesso({ recebido: true }, "Evento recebido.");
}

export function criarAtendedorHttp(
  criarCliente = criarClienteSupabaseRequisicao,
  dependencias: {
    criarAdmin?: typeof criarClienteSupabaseAdministrativo;
    emails?: Pick<ServicoEnvioEmailsTransacionaisResend, "validarAssinaturaWebhook">;
  } = {},
) {
  return async function atenderRequisicaoApiNext(requisicao: Request, _contexto: ContextoNext) {
    const identificador = randomUUID();
    const url = new URL(requisicao.url);
    const caminho = url.pathname;
    const metodo = requisicao.method.toUpperCase() as MetodoHttp;
    const cookiesPendentes: CookiePendente[] = [];
    const inicio = Date.now();
    let status = 200;

    try {
      const origem = requisicao.headers.get("origin");
      if (metodo === "OPTIONS") {
        if (origem && !config.origins.includes(origem)) {
          throw new ErroRegraNegocioHttp("Origem da solicitação não autorizada.", 403);
        }
        const resposta = new NextResponse(null, { status: 204 });
        resposta.headers.set("Cache-Control", "no-store");
        resposta.headers.set("X-Request-Id", identificador);
        resposta.headers.set("Vary", "Origin");
        if (origem && config.origins.includes(origem)) {
          resposta.headers.set("Access-Control-Allow-Origin", origem);
          resposta.headers.set("Access-Control-Allow-Credentials", "true");
        }
        resposta.headers.set(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-Concursa-Client, X-Siso-Aprova-Client, X-Idempotency-Key",
        );
        resposta.headers.set(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        );
        return resposta;
      }

      if (caminho === "/api/health/ready" && metodo === "GET") {
        const { error } = await criarClienteSupabaseAdministrativo()
          .from("usuarios")
          .select("idUsuario", { head: true })
          .limit(1);
        if (error) throw error;
        return responder(
          criarRespostaSucesso(
            { status: "ready", banco: "supabase-data-api" },
            "Conexão com o Supabase verificada.",
          ),
          200,
          requisicao,
          identificador,
          cookiesPendentes,
        );
      }
      if (caminho === "/api/health" && metodo === "GET") {
        return responder(
          criarRespostaSucesso(
            {
              status: "healthy",
              aplicacao: "Siso Aprova",
              runtime: "next",
              bancoConfigurado: !!(
                process.env.SUPABASE_PROJECT_URL && process.env.SUPABASE_PUBLISHABLE_API_KEY
              ),
            },
            "API em execução.",
          ),
          200,
          requisicao,
          identificador,
          cookiesPendentes,
        );
      }
      if (caminho === "/api/openapi.json" && metodo === "GET") {
        if (config.production) throw new ErroRegraNegocioHttp("Endpoint não encontrado.", 404);
        return responder(documentoOpenApi, 200, requisicao, identificador, cookiesPendentes);
      }

      const mutacao = !["GET", "HEAD"].includes(metodo);
      const tokenBearer = requisicao.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
      const possuiCookieSupabase = temCookieSessaoSupabase(requisicao.headers.get("cookie"));
      if (
        mutacao &&
        !tokenBearer &&
        (caminho.toLowerCase().startsWith("/api/navegador") ||
          caminho.toLowerCase().startsWith("/api/autenticacao") ||
          possuiCookieSupabase)
      ) {
        const clientHeader =
          requisicao.headers.get("X-Siso-Aprova-Client") ??
          requisicao.headers.get("X-Concursa-Client");
        if (clientHeader !== "web" || !origem || !config.origins.includes(origem)) {
          throw new ErroRegraNegocioHttp("Origem da solicitação não autorizada.", 403);
        }
      }

      if (caminho === "/api/ResendWebhook/registrar-evento-entrega" && metodo === "POST") {
        const ipWebhook = ipConfiavel(requisicao, config.trustProxy);
        if (!ipWebhook && config.production) exigirIp(requisicao, config.trustProxy);
        if (ipWebhook) limitarRequisicoes("webhook-resend:" + ipWebhook, 600);
        return responder(
          await processarWebhook(
            requisicao,
            dependencias.emails ?? emails,
            dependencias.criarAdmin ?? criarClienteSupabaseAdministrativo,
          ),
          200,
          requisicao,
          identificador,
          cookiesPendentes,
        );
      }

      if (correspondeRotaAutenticacaoSupabase(metodo, caminho)) {
        let corpoAuth: unknown;
        let corpoAuthLido = false;
        const lerAuth = async () => {
          if (!corpoAuthLido) {
            corpoAuth = await lerCorpoJson(requisicao, 16_384);
            corpoAuthLido = true;
          }
          return corpoAuth;
        };
        const sensivelEmail =
          /\/(entrar-estudante|entrar-administrador|cadastrar-estudante|solicitar-recuperacao-senha|reenviar-confirmacao)$/.test(
            caminho,
          );
        if (metodo !== "GET" && sensivelEmail) {
          const dados = (await lerAuth()) as { email?: unknown };
          limitarAutenticacao(requisicao, config.trustProxy, dados?.email);
        }
        const cabecalhosSessao: Record<string, string> = {};
        const supabase = criarCliente(requisicao as NextRequest, (valores, cabecalhos) => {
          cookiesPendentes.push(...valores);
          Object.assign(cabecalhosSessao, cabecalhos);
        });
        await restringirRecuperacao(supabase, caminho, tokenBearer);
        if (metodo !== "GET" && !sensivelEmail) {
          const identidade = await supabase.auth.getUser();
          const ip = ipConfiavel(requisicao, config.trustProxy);
          if (identidade.data.user && !identidade.error)
            limitarRequisicoes("auth-user:" + identidade.data.user.id, 30);
          else if (ip) limitarRequisicoes("auth-ip:" + ip, 30);
          else if (config.production) exigirIp(requisicao, config.trustProxy);
          else {
            const dados = (await lerAuth()) as {
              token?: unknown;
              codigo?: unknown;
            };
            const identidade = dados?.token ?? dados?.codigo;
            if (
              typeof identidade === "string" &&
              identidade.length >= 8 &&
              identidade.length <= 2000
            )
              limitarRequisicoes("auth-dev-token:" + identidade, 10);
            // iniciar OAuth em dev não possui conta/IP antes do provedor. Sem cota global.
          }
        }
        const dados = await atenderAutenticacaoSupabaseNext(
          metodo,
          caminho,
          supabase,
          lerAuth,
          origem && config.origins.includes(origem) ? origem : config.auth.clientUrl || undefined,
          {
            bearerToken: tokenBearer,
            reautenticar: reautenticarSenha,
            revogarBearer: async (token) => {
              const resultado = await criarClienteSupabaseAdministrativo().auth.admin.signOut(
                token,
                "global",
              );
              if (resultado.error)
                throw new ErroRegraNegocioHttp("Não foi possível revogar a sessão.", 503);
            },
          },
        );
        const resposta = responder(dados, 200, requisicao, identificador, cookiesPendentes);
        Object.entries(cabecalhosSessao).forEach(([nome, valor]) =>
          resposta.headers.set(nome, valor),
        );
        return resposta;
      }

      const rota = routes.find((item) => item.path === caminho && item.method === metodo);
      const rotaAdicional = correspondeRotaAdicional(caminho);
      const rotaImportacao = caminho === "/api/administracao/provas/importar" && metodo === "POST";
      if (!rota && !rotaAdicional && !rotaImportacao) {
        throw new ErroRegraNegocioHttp("Endpoint não encontrado.", 404);
      }

      const supabase = criarCliente(requisicao as NextRequest, (valores) => {
        cookiesPendentes.push(...valores);
      });
      await restringirRecuperacao(supabase, caminho, tokenBearer);
      let usuario: IdentidadeUsuarioAutenticado = { id: "", sessionId: "", token: "" };
      const autenticado = await supabase.auth.getUser();
      if (!autenticado.error && autenticado.data.user) {
        usuario = { id: autenticado.data.user.id, sessionId: "", token: "supabase-auth" };
      }
      if (!rota?.anonymous && !usuario.id) {
        throw new ErroRegraNegocioHttp("Entre na sua conta para continuar.", 401);
      }
      const repositorioSupabase = new RepositorioConsultasNegocioSupabase(supabase, usuario);
      if (rotaImportacao) {
        limitarRequisicoes("importacao:" + usuario.id, 30);
        const resposta = await importarProva(repositorioSupabase, () => lerCorpoJson(requisicao));
        return responder(resposta, 200, requisicao, identificador, cookiesPendentes);
      }

      if (
        rotaAdicional ||
        [
          "AnaliseQuestao",
          "Assunto",
          "Banca",
          "Concurso",
          "Disciplina",
          "Estudo",
          "Prova",
          "Questao",
          "Simulado",
          "Tentativa",
        ].includes(rota?.controller ?? "")
      ) {
        const acesso = await supabase.rpc("tem_acesso_premium");
        if (acesso.error) {
          if (!estruturaBancoAusente(acesso.error) || !usuario.id) throw acesso.error;
          // O catálogo administrativo pode ser usado antes da instalação dos pagamentos.
          const administrador = await supabase.rpc("eh_administrador");
          if (administrador.error) throw administrador.error;
          if (administrador.data !== true) throw acesso.error;
        } else if (acesso.data !== true) {
          throw new ErroRegraNegocioHttp(
            "Escolha um plano Premium para acessar os recursos de estudo.",
            403,
            "PREMIUM_INATIVO",
          );
        }
      }

      const enderecoCliente = () =>
        usuario.id ||
        ipConfiavel(requisicao, config.trustProxy) ||
        (config.production ? exigirIp(requisicao, config.trustProxy) : null);
      if (rota?.controller === "Autenticacao" || rota?.controller === "Navegador") {
        const id = enderecoCliente();
        if (id) limitarRequisicoes("auth:" + id, 10);
      } else if (rota?.controller === "Cep") {
        const id = enderecoCliente();
        // Dev direto não possui peer: restringir CEP por valor consultado, nunca inventar IP.
        limitarRequisicoes(
          "cep:" + (id ?? url.searchParams.get("cep")?.replace(/\D/g, "") ?? "invalido"),
          30,
        );
      } else if (rotaAdicional) {
        const id = enderecoCliente();
        if (id) limitarRequisicoes("adicional:" + id, caminho.startsWith("/api/ia/") ? 30 : 90);
      }

      const consulta = consultarParametros(url);
      if (rotaAdicional && !rota) {
        const adicional = await atenderRotaAdicionalNext(
          requisicao,
          caminho,
          usuario,
          db,
          openai,
          () => lerCorpoJson(requisicao),
          repositorioSupabase,
        );
        if (!adicional.encontrada) {
          throw new ErroRegraNegocioHttp("Endpoint não encontrado.", 404);
        }
        return responder(adicional.resposta, 200, requisicao, identificador, cookiesPendentes);
      }

      if (!rota) {
        throw new ErroRegraNegocioHttp("Endpoint não encontrado.", 404);
      }
      const corpo = rota.binding === "query" ? undefined : await lerCorpoJson(requisicao);
      const respostaDados = await (async () => {
        const servicos = criarServicosAplicacaoApi(
          db,
          auth,
          openai,
          usuario,
          requisicao.signal,
          repositorioSupabase,
          new ServicoComunicacaoSupabase(supabase),
        );
        const despacho = criarDespachoOperacoesApi(servicos, rota.binding === "query");
        const manipulador = despacho[rota.path as keyof typeof despacho];
        if (!manipulador) throw new Error("Endpoint sem implementação.");
        const entrada = rota.binding === "query" ? consulta : corpo;
        if (entrada === undefined) {
          throw new ErroRegraNegocioHttp(
            "Confira os campos informados e envie uma requisição válida.",
          );
        }
        return manipulador(entrada);
      })();

      return responder(respostaDados, 200, requisicao, identificador, cookiesPendentes);
    } catch (erro) {
      const classificado = classificarErroAplicacao(erro);
      status = classificado.status;
      logger.warn(
        {
          requestId: identificador,
          status,
          errorCode: obterCodigoErroAplicacao(erro),
          errorType: erro instanceof Error ? erro.name : "Unknown",
        },
        "Requisição recusada",
      );
      const resposta = responder(
        {
          ...criarRespostaErro(status, classificado.message),
          ...(erro instanceof ErroRegraNegocioHttp && erro.code ? { code: erro.code } : {}),
        },
        status,
        requisicao,
        identificador,
        cookiesPendentes,
      );
      if (status === 401) resposta.headers.set("WWW-Authenticate", "Bearer");
      return resposta;
    } finally {
      logger.info(
        {
          requestId: identificador,
          method: metodo,
          path: caminho,
          status,
          durationMs: Date.now() - inicio,
        },
        "HTTP",
      );
    }
  };
}
export const atenderRequisicaoApiNext = criarAtendedorHttp();
