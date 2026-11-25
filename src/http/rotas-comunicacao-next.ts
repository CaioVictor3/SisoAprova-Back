import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { pino } from "pino";
import {
  carregarConfiguracoesAmbiente,
  type ConfiguracoesAmbiente,
} from "../config/configuracoes-ambiente.js";
import {
  classificarErroAplicacao,
  criarRespostaErro,
  criarRespostaSucesso,
  ErroRegraNegocioHttp,
  obterCodigoErroAplicacao,
} from "../domain/erros-validacoes-respostas-api.js";
import { ConexaoTransacoesPostgreSql } from "../infrastructure/conexao-transacoes-postgresql.js";
import {
  ServicoEnvioEmailsTransacionaisResend,
  type ResumoCicloWorkerEmails,
} from "../infrastructure/envio-emails-transacionais-resend.js";
import { PersistenciaWorkerEmailsSupabase } from "../infrastructure/persistencia-worker-emails-supabase.js";
import type { HttpFetch } from "../infrastructure/seguranca-requisicoes-https.js";
import { aplicarCabecalhos, redacaoLogs } from "../security/headers.mjs";
import { criarClienteSupabaseAdministrativo } from "../utils/supabase/admin.js";

const ambienteInicial = carregarConfiguracoesAmbiente(process.env, { supabase: true });
const loggerComunicacao = pino({
  name: "comunicacao",
  level: ambienteInicial.logLevel,
  redact: redacaoLogs,
});

function validarAgendadorComunicacao(req: Request, segredo: string) {
  const cabecalho = req.headers.get("authorization") ?? "";
  const temPrefixoBearer = /^Bearer /i.test(cabecalho);
  const recebido = temPrefixoBearer ? cabecalho.replace(/^Bearer /i, "") : "";
  const hashEsperado = createHash("sha256").update(segredo).digest();
  const hashRecebido = createHash("sha256").update(recebido).digest();
  const igual = timingSafeEqual(hashEsperado, hashRecebido);
  if (segredo.length < 32 || !temPrefixoBearer || !recebido || !igual) {
    throw new ErroRegraNegocioHttp("Agendador não autorizado.", 401);
  }
}

function criarServicoPadrao(
  ambiente: ConfiguracoesAmbiente,
  criarAdmin: typeof criarClienteSupabaseAdministrativo,
  clienteHttp: HttpFetch,
) {
  return new ServicoEnvioEmailsTransacionaisResend(
    new ConexaoTransacoesPostgreSql(ambiente),
    ambiente,
    clienteHttp,
    new PersistenciaWorkerEmailsSupabase(criarAdmin()),
  );
}

export function criarAtendedorComunicacao(
  dependencias: {
    carregarAmbiente?: () => ConfiguracoesAmbiente;
    criarAdmin?: typeof criarClienteSupabaseAdministrativo;
    clienteHttp?: HttpFetch;
    criarServico?: (
      ambiente: ConfiguracoesAmbiente,
    ) => Pick<ServicoEnvioEmailsTransacionaisResend, "executarCicloWorker">;
  } = {},
) {
  return async function atenderComunicacao(req: NextRequest | Request) {
    const requestId = randomUUID();
    const caminho = new URL(req.url).pathname.replace(/\/$/, "");
    const origem = req.headers.get("origin");
    let origens = ambienteInicial.origins;

    function responder(dados: unknown, status = 200) {
      const resposta = NextResponse.json(dados, { status });
      if (status === 429) resposta.headers.set("Retry-After", "60");
      if (status === 405) resposta.headers.set("Allow", "POST");
      if (status === 401) resposta.headers.set("WWW-Authenticate", "Bearer");
      resposta.headers.set("Cache-Control", "no-store");
      resposta.headers.set("X-Request-Id", requestId);
      resposta.headers.set("X-Content-Type-Options", "nosniff");
      resposta.headers.set("Vary", "Origin");
      if (origem && origens.includes(origem)) {
        resposta.headers.set("Access-Control-Allow-Origin", origem);
        resposta.headers.set("Access-Control-Allow-Credentials", "true");
      }
      aplicarCabecalhos(resposta);
      return resposta;
    }

    try {
      const ambiente = (
        dependencias.carregarAmbiente ??
        (() => carregarConfiguracoesAmbiente(process.env, { supabase: true }))
      )();
      origens = ambiente.origins;

      if (req.method === "OPTIONS") {
        if (origem && !origens.includes(origem)) {
          throw new ErroRegraNegocioHttp("Origem não autorizada.", 403);
        }
        const resposta = responder(criarRespostaSucesso({}, "OK"));
        resposta.headers.set(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, X-Concursa-Client, X-Siso-Aprova-Client, X-Idempotency-Key",
        );
        resposta.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
        aplicarCabecalhos(resposta);
        return resposta;
      }

      if (caminho !== "/api/comunicacao/tarefas") {
        throw new ErroRegraNegocioHttp("Endpoint não encontrado.", 404);
      }

      if (req.method !== "POST") {
        throw new ErroRegraNegocioHttp("Método não permitido.", 405);
      }

      validarAgendadorComunicacao(req, ambiente.email.maintenanceSecret);

      if (!ambiente.email.worker) {
        const resumoDesabilitado: ResumoCicloWorkerEmails & { habilitado: boolean } = {
          habilitado: false,
          reservados: 0,
          aceitos: 0,
          falhas: 0,
          cancelados: 0,
          devolvidos: 0,
          manutencaoExecutada: false,
        };
        return responder(
          criarRespostaSucesso(resumoDesabilitado, "Worker de e-mails transacionais desabilitado."),
        );
      }

      if (
        !ambiente.email.key.trim() ||
        !ambiente.email.from.trim() ||
        !ambiente.auth.clientUrl ||
        !ambiente.origins.includes(ambiente.auth.clientUrl)
      ) {
        throw new ErroRegraNegocioHttp(
          "O envio de e-mails transacionais não está configurado.",
          503,
        );
      }

      const servico = (
        dependencias.criarServico ??
        ((amb) =>
          criarServicoPadrao(
            amb,
            dependencias.criarAdmin ?? criarClienteSupabaseAdministrativo,
            dependencias.clienteHttp ?? fetch,
          ))
      )(ambiente);

      const resumo = await servico.executarCicloWorker(loggerComunicacao, req.signal, true);

      return responder(
        criarRespostaSucesso(
          {
            habilitado: true,
            reservados: resumo.reservados,
            aceitos: resumo.aceitos,
            falhas: resumo.falhas,
            cancelados: resumo.cancelados,
            devolvidos: resumo.devolvidos,
            manutencaoExecutada: resumo.manutencaoExecutada,
          },
          "Manutenção de e-mails transacionais concluída.",
        ),
      );
    } catch (erro) {
      const resultado = classificarErroAplicacao(erro);
      loggerComunicacao.warn(
        {
          requestId,
          path: caminho,
          status: resultado.status,
          errorCode: obterCodigoErroAplicacao(erro),
          errorType: erro instanceof Error ? erro.name : "DatabaseError",
        },
        "Operação de comunicação recusada",
      );
      return responder(criarRespostaErro(resultado.status, resultado.message), resultado.status);
    }
  };
}

export const atenderComunicacao = criarAtendedorComunicacao();
