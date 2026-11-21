import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { pino } from "pino";
import { carregarConfiguracoesAmbiente } from "../src/config/configuracoes-ambiente.js";
import { ConexaoTransacoesPostgreSql } from "../src/infrastructure/conexao-transacoes-postgresql.js";
import {
  FalhaEntregaEmailTransacional,
  ServicoEnvioEmailsTransacionaisResend,
} from "../src/infrastructure/envio-emails-transacionais-resend.js";
import { PersistenciaWorkerEmailsSupabase } from "../src/infrastructure/persistencia-worker-emails-supabase.js";
import { criarAtendedorComunicacao } from "../src/http/rotas-comunicacao-next.js";
import { criarAtendedorHttp } from "../src/http/atender-requisicao-api-next.js";
import { gerarDocumentoOpenApi } from "../src/http/documentacao-openapi.js";

const loggerSilencioso = pino({ level: "silent" });
const segredoCronValido = "segredo-manutencao-emails-com-32-bytes-123456";

function criarAmbienteTeste(overrides: Record<string, string> = {}) {
  return carregarConfiguracoesAmbiente(
    {
      NODE_ENV: "production",
      FRONTEND_APPLICATION_URL: "https://app.example.test",
      BACKEND_CORS_ALLOWED_ORIGINS: "https://app.example.test",
      BACKEND_LOG_LEVEL: "silent",
      RESEND_API_KEY: "re_test_fixture_key",
      RESEND_SENDER_EMAIL_ADDRESS: "nao-responda@sisoaprova.com.br",
      RESEND_SENDER_DISPLAY_NAME: "Siso Aprova",
      RESEND_WEBHOOK_SIGNING_SECRET:
        "whsec_" + Buffer.from("segredo-svix-resend-webhook-teste-32b").toString("base64"),
      TRANSACTIONAL_EMAIL_WORKER_ENABLED: "true",
      TRANSACTIONAL_EMAIL_MAINTENANCE_AUTHORIZATION_SECRET: segredoCronValido,
      ...overrides,
    },
    { supabase: true },
  );
}

function criarEmailReservado(overrides: Record<string, unknown> = {}) {
  return {
    idEmailTransacional: randomUUID(),
    tipo_evento: "WELCOME_EMAIL",
    idUsuario: randomUUID(),
    email_destinatario: "estudante@example.test",
    assunto: "Boas-vindas ao Siso Aprova",
    dados_template: JSON.stringify({ nome: "Maria Silva" }),
    link_protegido: null,
    validade_link_em: null,
    quantidade_tentativas: 1,
    maximo_tentativas: 5,
    chave_idempotencia: "WELCOME_EMAIL/" + randomUUID(),
    identificador_processamento: randomUUID(),
    ...overrides,
  };
}

test("renderizarConteudoEmail formata saudação sem vírgula solta e valida chave legada apenas com link_protegido", () => {
  const ambiente = criarAmbienteTeste({ AUTHENTICATION_LEGACY_TOKEN_SIGNING_KEY: "" });
  const servico = new ServicoEnvioEmailsTransacionaisResend(
    new ConexaoTransacoesPostgreSql(ambiente),
    ambiente,
  );

  for (const nomeVazio of ["", "   "]) {
    const conteudoSemNome = servico.renderizarConteudoEmail(
      criarEmailReservado({ dados_template: JSON.stringify({ nome: nomeVazio }) }) as any,
    );
    assert(conteudoSemNome.text.startsWith("Olá!\n\n"));
    assert(!conteudoSemNome.text.startsWith(",\n\n"));
    assert(conteudoSemNome.html.includes("<p>Olá!</p>"));
  }

  const conteudoComNome = servico.renderizarConteudoEmail(
    criarEmailReservado({
      tipo_evento: "SUBSCRIPTION_EXPIRING",
      dados_template: JSON.stringify({ nome: "  João <Teste>  " }),
    }) as any,
  );
  assert(conteudoComNome.text.startsWith("Olá, João <Teste>!\n\n"));
  assert(conteudoComNome.html.includes("<p>Olá, João &lt;Teste&gt;!</p>"));
  assert(conteudoComNome.text.includes("https://app.example.test/estudante/minha-assinatura"));

  assert.throws(
    () =>
      servico.renderizarConteudoEmail(
        criarEmailReservado({ link_protegido: "link-cifrado-legado" }) as any,
      ),
    (erro: unknown) =>
      erro instanceof FalhaEntregaEmailTransacional &&
      erro.message === "chave_legada_indisponivel" &&
      erro.permanent === false,
  );
});

test("enviarEmailResend e processarEmailReservado higienizam remetente, aplicam Idempotency-Key e classificam erros 4xx/429/5xx", async () => {
  const requisicoesResend: Array<{
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  let respostaAtual: () => Promise<Response> = async () => Response.json({ id: "re_msg_123" });

  const ambiente = criarAmbienteTeste({
    RESEND_SENDER_DISPLAY_NAME: "  Siso\r\n<Aprova>  ",
    RESEND_SENDER_EMAIL_ADDRESS: "  nao-responda@sisoaprova.com.br  ",
  });
  const operacoesPersistidas: Array<{ op: string; dados: Record<string, unknown> }> = [];
  const persistencia = new PersistenciaWorkerEmailsSupabase({
    rpc: async (_fn: string, args: { p_operacao: string; p_dados: Record<string, unknown> }) => {
      operacoesPersistidas.push({ op: args.p_operacao, dados: args.p_dados });
      if (args.p_operacao === "listarFluxos") {
        return {
          data: {
            rows: [
              {
                tipo_evento: "WELCOME_EMAIL",
                habilitado: true,
                atualizado_em: new Date().toISOString(),
              },
            ],
            rowCount: 1,
          },
          error: null,
        };
      }
      if (args.p_operacao === "consultarReservaEmail") {
        return { data: { rows: [{ exists: true }], rowCount: 1 }, error: null };
      }
      return { data: { rows: [], rowCount: 1 }, error: null };
    },
  } as any);

  const servico = new ServicoEnvioEmailsTransacionaisResend(
    new ConexaoTransacoesPostgreSql(ambiente),
    ambiente,
    async (_url, init) => {
      requisicoesResend.push({
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return respostaAtual();
    },
    persistencia,
  );

  const email = criarEmailReservado();
  const resultadoAceito = await servico.processarEmailReservado(
    email as any,
    loggerSilencioso,
    new AbortController().signal,
  );
  assert.equal(resultadoAceito, "aceito");
  assert.equal(requisicoesResend[0]?.headers["Idempotency-Key"], email.chave_idempotencia);
  assert.equal(requisicoesResend[0]?.body.from, "Siso Aprova <nao-responda@sisoaprova.com.br>");

  // Display name vazio após sanitização usa apenas o endereço
  const ambienteSemNome = criarAmbienteTeste({ RESEND_SENDER_DISPLAY_NAME: " <\r\n> " });
  const servicoSemNome = new ServicoEnvioEmailsTransacionaisResend(
    new ConexaoTransacoesPostgreSql(ambienteSemNome),
    ambienteSemNome,
    async (_url, init) => {
      requisicoesResend.push({
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({ id: "re_msg_124" });
    },
    persistencia,
  );
  await servicoSemNome.enviarEmailResend(email as any);
  assert.equal(requisicoesResend.at(-1)?.body.from, "nao-responda@sisoaprova.com.br");

  // 422 -> falha definitiva
  operacoesPersistidas.length = 0;
  respostaAtual = async () => new Response("Unprocessable", { status: 422 });
  const resultado422 = await servico.processarEmailReservado(
    email as any,
    loggerSilencioso,
    new AbortController().signal,
  );
  assert.equal(resultado422, "falha");
  const falha422 = operacoesPersistidas.find((item) => item.op === "marcarFalhaProcessamentoEmail");
  assert.equal(falha422?.dados.status, "falha");
  assert.equal(falha422?.dados.definitiva, true);
  assert.equal(falha422?.dados.proxima, null);
  assert.equal(falha422?.dados.erro, "resend_http_422");

  // 429, 503 e resposta sem id -> pendente retentável
  for (const [fnResposta, codigoEsperado] of [
    [async () => new Response("Rate limit", { status: 429 }), "resend_http_429"],
    [async () => new Response("Unavailable", { status: 503 }), "resend_http_503"],
    [async () => Response.json({}), "resend_resposta_ambigua"],
  ] as const) {
    operacoesPersistidas.length = 0;
    respostaAtual = fnResposta;
    const res = await servico.processarEmailReservado(
      email as any,
      loggerSilencioso,
      new AbortController().signal,
    );
    assert.equal(res, "falha");
    const falha = operacoesPersistidas.find((item) => item.op === "marcarFalhaProcessamentoEmail");
    assert.equal(falha?.dados.status, "pendente");
    assert.equal(falha?.dados.definitiva, false);
    assert(falha?.dados.proxima instanceof Date);
    assert.equal(falha?.dados.erro, codigoEsperado);
  }
});

test("POST /api/comunicacao/tarefas valida CORS, 405, Bearer SHA-256, worker desabilitado, 503 e resumo seguro", async () => {
  let ambienteAtual = criarAmbienteTeste();
  let ciclosExecutados = 0;

  const atendedor = criarAtendedorComunicacao({
    carregarAmbiente: () => ambienteAtual,
    criarServico: () => ({
      executarCicloWorker: async (_logger, _signal, maintenance) => {
        ciclosExecutados += 1;
        assert.equal(maintenance, true);
        return {
          reservados: 3,
          aceitos: 2,
          falhas: 1,
          cancelados: 0,
          devolvidos: 0,
          manutencaoExecutada: true,
        };
      },
    }),
  });

  // OPTIONS com origem permitida -> 200 e origem não permitida -> 403
  const rOptionsOk = await atendedor(
    new Request("https://api.example.test/api/comunicacao/tarefas", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.test" },
    }),
  );
  assert.equal(rOptionsOk.status, 200);
  assert.equal(rOptionsOk.headers.get("access-control-allow-origin"), "https://app.example.test");

  const rOptionsBloq = await atendedor(
    new Request("https://api.example.test/api/comunicacao/tarefas", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.test" },
    }),
  );
  assert.equal(rOptionsBloq.status, 403);

  // Método != POST -> 405 com Allow: POST
  const rGet = await atendedor(
    new Request("https://api.example.test/api/comunicacao/tarefas", { method: "GET" }),
  );
  assert.equal(rGet.status, 405);
  assert.equal(rGet.headers.get("allow"), "POST");

  // Rota desconhecida -> 404
  const r404 = await atendedor(
    new Request("https://api.example.test/api/comunicacao/inexistente", { method: "POST" }),
  );
  assert.equal(r404.status, 404);

  // Autenticação ausente, sem prefixo Bearer, errada ou segredo curto -> 401
  for (const authHeader of ["", segredoCronValido, "Bearer token-incorreto"]) {
    const r401 = await atendedor(
      new Request("https://api.example.test/api/comunicacao/tarefas", {
        method: "POST",
        headers: authHeader ? { Authorization: authHeader } : {},
      }),
    );
    assert.equal(r401.status, 401);
  }

  ambienteAtual = criarAmbienteTeste({
    TRANSACTIONAL_EMAIL_MAINTENANCE_AUTHORIZATION_SECRET: "curto",
  });
  const rSegredoCurto = await atendedor(
    new Request("https://api.example.test/api/comunicacao/tarefas", {
      method: "POST",
      headers: { Authorization: "Bearer curto" },
    }),
  );
  assert.equal(rSegredoCurto.status, 401);

  // Worker desabilitado -> 200 com habilitado: false e contadores zerados sem executar ciclo
  ambienteAtual = criarAmbienteTeste({ TRANSACTIONAL_EMAIL_WORKER_ENABLED: "false" });
  const rDesabilitado = await atendedor(
    new Request("https://api.example.test/api/comunicacao/tarefas", {
      method: "POST",
      headers: { Authorization: "Bearer " + segredoCronValido },
    }),
  );
  assert.equal(rDesabilitado.status, 200);
  const corpoDesabilitado = await rDesabilitado.json();
  assert.deepEqual(corpoDesabilitado.data, {
    habilitado: false,
    reservados: 0,
    aceitos: 0,
    falhas: 0,
    cancelados: 0,
    devolvidos: 0,
    manutencaoExecutada: false,
  });
  assert.equal(ciclosExecutados, 0);

  // Worker habilitado mas sem RESEND_API_KEY -> 503
  ambienteAtual = criarAmbienteTeste({ RESEND_API_KEY: "" });
  const r503 = await atendedor(
    new Request("https://api.example.test/api/comunicacao/tarefas", {
      method: "POST",
      headers: { Authorization: "Bearer " + segredoCronValido },
    }),
  );
  assert.equal(r503.status, 503);

  // Worker habilitado e configurado -> 200 com contadores seguros
  ambienteAtual = criarAmbienteTeste();
  const rSucesso = await atendedor(
    new Request("https://api.example.test/api/comunicacao/tarefas", {
      method: "POST",
      headers: { Authorization: "Bearer " + segredoCronValido },
    }),
  );
  assert.equal(rSucesso.status, 200);
  const textoSucesso = await rSucesso.text();
  assert(!textoSucesso.includes("re_test_fixture_key"));
  assert(!textoSucesso.includes(segredoCronValido));
  const corpoSucesso = JSON.parse(textoSucesso);
  assert.deepEqual(corpoSucesso.data, {
    habilitado: true,
    reservados: 3,
    aceitos: 2,
    falhas: 1,
    cancelados: 0,
    devolvidos: 0,
    manutencaoExecutada: true,
  });
  assert.equal(ciclosExecutados, 1);

  // OpenAPI documenta POST /api/comunicacao/tarefas e agendadorComunicacaoBearerAuth
  const doc = gerarDocumentoOpenApi();
  assert(doc.paths["/api/comunicacao/tarefas"]?.post);
  assert(
    (doc.components.securitySchemes as Record<string, unknown>).agendadorComunicacaoBearerAuth,
  );
});

test("POST /api/ResendWebhook/registrar-evento-entrega valida assinatura Svix e persiste evento via RPC", async () => {
  const ambiente = criarAmbienteTeste();
  const servicoEmails = new ServicoEnvioEmailsTransacionaisResend(
    new ConexaoTransacoesPostgreSql(ambiente),
    ambiente,
  );
  const eventosRegistrados: Array<Record<string, unknown>> = [];
  const atendedorHttp = criarAtendedorHttp(undefined, {
    emails: servicoEmails,
    criarAdmin: () =>
      ({
        rpc: async (fn: string, params: Record<string, unknown>) => {
          assert.equal(fn, "registrar_evento_resend_backend");
          eventosRegistrados.push(params);
          return { data: null, error: null };
        },
      }) as any,
  });

  const svixId = "msg_svix_123";
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    type: "email.delivered",
    data: { email_id: "re_email_999" },
  });
  const chaveRaw = Buffer.from(ambiente.email.webhookSecret.slice(6), "base64");
  const assinatura =
    "v1," +
    createHmac("sha256", chaveRaw).update(`${svixId}.${svixTimestamp}.${payload}`).digest("base64");

  const rValido = await atendedorHttp(
    new Request("https://api.example.test/api/ResendWebhook/registrar-evento-entrega", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": assinatura,
        "x-forwarded-for": "203.0.113.55",
      },
      body: payload,
    }),
    { params: Promise.resolve({ path: ["ResendWebhook", "registrar-evento-entrega"] }) },
  );
  assert.equal(rValido.status, 200);
  assert.deepEqual(eventosRegistrados, [
    {
      p_webhook: svixId,
      p_idmensagem: "re_email_999",
      p_evento: "email.delivered",
    },
  ]);

  const rInvalido = await atendedorHttp(
    new Request("https://api.example.test/api/ResendWebhook/registrar-evento-entrega", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": "v1,assinaturaInvalida==",
        "x-forwarded-for": "203.0.113.55",
      },
      body: payload,
    }),
    { params: Promise.resolve({ path: ["ResendWebhook", "registrar-evento-entrega"] }) },
  );
  assert.equal(rInvalido.status, 401);
});
