import test from "node:test";
import { producaoExigeIp, limitarAutenticacao, LimitesSqlite } from "../src/security/rate-limit.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { opcoesCookieSessaoSupabase } from "../src/utils/supabase/opcoes-cookie-sessao.js";
import { carregarConfiguracoesAmbiente } from "../src/config/configuracoes-ambiente.js";
import { atenderAutenticacaoSupabaseNext as atender } from "../src/http/autenticacao-supabase-next.js";
import {
  ServicoEnvioEmailsTransacionaisResend,
  tiposEventoEmailTransacional,
} from "../src/infrastructure/envio-emails-transacionais-resend.js";
import { ConexaoTransacoesPostgreSql } from "../src/infrastructure/conexao-transacoes-postgresql.js";

const origem = "https://app.example.test";
const pessoa = {
  nomeCompleto: "Pessoa Exemplo",
  dataNascimento: "1990-01-01",
  cpf: "52998224725",
  cep: "01001000",
  logradouro: "Teste",
  numero: "1",
  bairro: "Teste",
  cidade: "Teste",
  uf: "SP",
  complemento: null,
};

test("cookies production: HTTP loopback e proxy HTTPS; origens irmãs", () => {
  const anterior = { node: process.env.NODE_ENV, frontend: process.env.FRONTEND_APPLICATION_URL };
  try {
    process.env.NODE_ENV = "production";
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      process.env.FRONTEND_APPLICATION_URL = `http://${host}:5173`;
      assert.deepEqual(opcoesCookieSessaoSupabase(), {
        httpOnly: true,
        path: "/",
        secure: false,
        sameSite: "lax",
      });
    }
    process.env.FRONTEND_APPLICATION_URL = origem;
    const seguro = {
      httpOnly: true,
      path: "/",
      secure: true,
      sameSite: "none",
      name: "__Host-sisoaprova-auth-token",
      partitioned: true,
    };
    assert.deepEqual(opcoesCookieSessaoSupabase(), seguro);
    assert.equal(opcoesCookieSessaoSupabase(new Request("http://localhost:3000")).secure, false);
    assert.deepEqual(
      opcoesCookieSessaoSupabase(
        new Request("http://localhost:3000", { headers: { "x-forwarded-proto": "https" } }),
      ),
      seguro,
    );
    assert.equal(
      opcoesCookieSessaoSupabase(
        new Request(origem, { headers: { origin: "http://127.0.0.1:5173" } }),
      ).secure,
      true,
    );
    assert.deepEqual(
      opcoesCookieSessaoSupabase(new Request("http://untrusted.example.test")),
      seguro,
    );
    for (const host of ["localhost", "127.0.0.1"]) {
      const c = carregarConfiguracoesAmbiente(
        { FRONTEND_APPLICATION_URL: `http://${host}:5173` },
        { supabase: true },
      );
      assert.equal(c.origins.length, 2);
      assert(c.origins.includes("http://localhost:5173"));
      assert(c.origins.includes("http://127.0.0.1:5173"));
    }
  } finally {
    for (const [key, value] of [
      ["NODE_ENV", anterior.node],
      ["FRONTEND_APPLICATION_URL", anterior.frontend],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
});

function fixture() {
  const config = carregarConfiguracoesAmbiente(
    {
      FRONTEND_APPLICATION_URL: origem,
      RESEND_API_KEY: "fixture",
      RESEND_SENDER_EMAIL_ADDRESS: "teste@example.test",
      TRANSACTIONAL_EMAIL_WORKER_ENABLED: "false",
    },
    { supabase: true },
  );
  const enviados: any[] = [];
  const registros: any[] = [];
  const service = new ServicoEnvioEmailsTransacionaisResend(
    new ConexaoTransacoesPostgreSql(config),
    config,
    async (_url, init) => {
      enviados.push(JSON.parse(init!.body as string));
      return Response.json({ id: "resend-fixture" });
    },
    {
      executar: async (_nome: any, dados: any) => {
        registros.push(dados);
        throw new Error("migration ausente");
      },
    } as any,
  );
  const gerados: any[] = [];
  let protecao = true;
  let estado = "verificacao_pendente";
  const admin: any = {
    auth: {
      admin: {
        generateLink: async (dados: any) => {
          gerados.push(dados);
          return {
            data: { user: { id: randomUUID() }, properties: { hashed_token: "hash/fixture" } },
            error: null,
          };
        },
      },
    },
    rpc: async () => ({ data: protecao, error: null }),
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { nome_completo: "Pessoa Exemplo", estado_cadastro: estado },
            error: null,
          }),
        }),
      }),
    }),
  };
  const chamadas: string[] = [];
  const supabase: any = {
    auth: {
      signUp: async () => {
        chamadas.push("signup");
        return { data: { user: { id: randomUUID() }, session: null }, error: null };
      },
      resetPasswordForEmail: async () => {
        chamadas.push("recovery");
        return { error: null };
      },
      resend: async () => {
        chamadas.push("resend");
        return { error: null };
      },
      verifyOtp: async (dados: any) => {
        chamadas.push(dados.type);
        return { error: null };
      },
      exchangeCodeForSession: async () => {
        chamadas.push("codigo");
        return { error: null };
      },
    },
  };
  const opcoes = {
    criarAdmin: () => admin,
    enviarEmailAutenticacao: (dados: any) => service.enviarEmailAutenticacaoImediato(dados),
    enviarBoasVindas: async () => {
      chamadas.push("welcome");
    },
  };
  const call = (acao: string, dados: any, opts: any = opcoes) =>
    atender("POST", "/api/Autenticacao/" + acao, supabase, async () => dados, origem, opts);
  return {
    service,
    enviados,
    registros,
    gerados,
    chamadas,
    call,
    supabase,
    opcoes,
    admin,
    setProtecao: (v: boolean) => (protecao = v),
    setEstado: (v: string) => (estado = v),
  };
}

test("marca em cinco templates, link direto validado sem chave legada", () => {
  const f = fixture();
  for (const tipo of tiposEventoEmailTransacional) {
    const e: any = {
      tipo_evento: tipo,
      dados_template: '{"nome":"João <Teste>"}',
      link_protegido: null,
    };
    const html = f.service.renderizarConteudoEmail(e).html;
    for (const valor of [
      "siso-aprova-icon-badge-180.png",
      ">Siso</span>",
      ">Aprova</span>",
      "#3b2d82",
      "#7749c6",
      "<p>Olá, João &lt;Teste&gt;!</p>",
    ])
      assert(html.includes(valor));
    assert.throws(() =>
      f.service.renderizarConteudoEmail(e, "https://outro.example/autenticacao/x"),
    );
    assert.throws(() => f.service.renderizarConteudoEmail(e, origem + "/fora"));
  }
});

test("cadastro, recuperação e reenvio enviam HTML Resend com token_hash sem worker; registro opcional", async () => {
  const f = fixture();
  await f.call("cadastrar-estudante", {
    email: " Pessoa@Example.test ",
    senha: "SenhaForte123!",
    pessoa,
  });
  await f.call("solicitar-recuperacao-senha", { email: "pessoa@example.test" });
  await f.call("reenviar-confirmacao", { email: "pessoa@example.test" });
  assert.deepEqual(
    f.gerados.map((x) => x.type),
    ["signup", "recovery", "magiclink"],
  );
  assert.equal(f.enviados.length, 3);
  assert.equal(f.registros.length, 3);
  for (const email of f.enviados) {
    assert(email.html.includes("token_hash=hash%2Ffixture"));
    assert(email.html.includes("siso-aprova-icon-badge-180.png"));
  }
  for (const registro of f.registros) {
    assert(!JSON.stringify(registro).includes("hash/fixture"));
    assert(!("link" in registro));
  }
  assert.deepEqual(f.chamadas, []);
});

test("fallback Auth sem callbacks ou sem proteção; conta ativa não reenvia", async () => {
  const f = fixture();
  await f.call(
    "cadastrar-estudante",
    { email: "pessoa@example.test", senha: "SenhaForte123!", pessoa },
    {},
  );
  await f.call("solicitar-recuperacao-senha", { email: "pessoa@example.test" }, {});
  await f.call("reenviar-confirmacao", { email: "pessoa@example.test" }, {});
  f.setProtecao(false);
  await f.call("reenviar-confirmacao", { email: "pessoa@example.test" });
  f.setEstado("ativo");
  await f.call("reenviar-confirmacao", { email: "pessoa@example.test" });
  assert.deepEqual(f.chamadas, ["signup", "recovery", "resend", "resend"]);
  assert.equal(f.gerados.length, 0);
});

test("confirmar aceita email, recovery, PKCE e subtipo legado; boas-vindas toleram falha", async () => {
  const f = fixture();
  await f.call("confirmar-email", { token: "email:hash" });
  await f.call("confirmar-email", { token: "recovery:hash" });
  await f.call("confirmar-email", { token: "codigo:hash" });
  assert.deepEqual(f.chamadas, ["email", "welcome", "recovery", "codigo", "welcome"]);
  f.supabase.auth.verifyOtp = async (d: any) => ({
    error: d.type === "signup" ? null : { message: "fixture" },
  });
  await f.call(
    "confirmar-email",
    { token: "signup:hash" },
    {
      ...f.opcoes,
      enviarBoasVindas: async () => {
        throw new Error("fila");
      },
    },
  );
});

test("recovery não revela conta ausente; 429 e falha do provedor preservados", async () => {
  const f = fixture();
  for (const status of [404, 422, 429, 500]) {
    f.admin.auth.admin.generateLink = async () => ({ error: { status } });
    if (status < 429) await f.call("solicitar-recuperacao-senha", { email: "pessoa@example.test" });
    else
      await assert.rejects(
        () => f.call("solicitar-recuperacao-senha", { email: "pessoa@example.test" }),
        (e: any) => e.status === (status === 429 ? 429 : 503),
      );
  }
  assert.equal(f.enviados.length, 0);
});

test("HTTP: quatro fluxos integram Admin/Resend e confirmação grava cookies", async () => {
  const keys = {
    FRONTEND_APPLICATION_URL: origem,
    BACKEND_LOG_LEVEL: "silent",
    RESEND_API_KEY: "fixture",
    RESEND_SENDER_EMAIL_ADDRESS: "fixture@example.test",
    SUPABASE_SERVER_SECRET_API_KEY: "fixture-admin",
  };
  const anteriores = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  Object.assign(process.env, keys);
  try {
    const { criarAtendedorHttp } = await import("../src/http/atender-requisicao-api-next.js");
    const f = fixture();
    f.supabase.auth.getSession = async () => ({ data: { session: null }, error: null });
    f.supabase.auth.getUser = async () => ({ data: { user: null }, error: null });
    const atendedor = criarAtendedorHttp(
      ((_req: any, registrar: any) => {
        f.supabase.auth.verifyOtp = async () => {
          registrar(
            [
              {
                nome: "sb-fixture-auth-token",
                valor: "fixture",
                opcoes: { httpOnly: true, path: "/" },
              },
            ],
            {},
          );
          return { error: null };
        };
        return f.supabase;
      }) as any,
      {
        criarAdmin: () => f.admin,
        emailsAutenticacao: {
          enviarEmailAutenticacaoImediato: (dados: any) =>
            f.service.enviarEmailAutenticacaoImediato(dados),
          executarCicloWorker: async () => ({
            reservados: 0,
            aceitos: 0,
            falhas: 0,
            cancelados: 0,
            devolvidos: 0,
            manutencaoExecutada: false,
          }),
        },
      },
    );
    for (const [acao, dados] of [
      ["cadastrar-estudante", { email: "http1@example.test", senha: "SenhaForte123!", pessoa }],
      ["solicitar-recuperacao-senha", { email: "http2@example.test" }],
      ["reenviar-confirmacao", { email: "http3@example.test" }],
      ["confirmar-email", { token: "email:fixture-http-token" }],
    ] as const) {
      const response = await atendedor(
        new Request("http://localhost:3000/api/Autenticacao/" + acao, {
          method: "POST",
          headers: {
            origin: origem,
            "content-type": "application/json",
            "X-Siso-Aprova-Client": "web",
          },
          body: JSON.stringify(dados),
        }),
        { params: Promise.resolve({ path: [] }) },
      );
      assert.equal(response.status, 200, await response.text());
      if (acao === "confirmar-email")
        assert(response.headers.get("set-cookie")?.includes("HttpOnly"));
    }
    assert.equal(f.enviados.length, 3);
  } finally {
    for (const [key, value] of Object.entries(anteriores)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("produção local sem proxy limita por conta e não exige IP indisponível", () => {
  const nomes = ["NODE_ENV", "FRONTEND_APPLICATION_URL", "BACKEND_CORS_ALLOWED_ORIGINS"];
  const anterior = nomes.map((nome) => process.env[nome]);
  const store = new LimitesSqlite(":memory:");
  try {
    process.env.NODE_ENV = "production";
    delete process.env.BACKEND_CORS_ALLOWED_ORIGINS;
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      process.env.FRONTEND_APPLICATION_URL = `http://${host}:5173`;
      const req = new Request(`http://${host}:3000/api/Navegador/entrar-estudante`);
      assert.equal(producaoExigeIp(req, 0), false);
      for (let i = 0; i < 10; i++) limitarAutenticacao(req, 0, `${host}@example.test`, store);
      assert.throws(
        () => limitarAutenticacao(req, 0, `${host}@example.test`, store),
        (e: any) => e.status === 429,
      );
    }
    process.env.FRONTEND_APPLICATION_URL = "http://localhost:5173";
    for (const host of ["localhost", "0.0.0.0"]) {
      for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
        const req = new Request(`http://${host}:3000/api`, {
          headers: { "x-forwarded-proto": "http", "x-forwarded-for": ip },
        });
        assert.equal(producaoExigeIp(req, 0), false, `${host} ${ip}`);
      }
    }
  } finally {
    store.fechar();
    nomes.forEach((nome, i) => {
      if (anterior[i] === undefined) delete process.env[nome];
      else process.env[nome] = anterior[i];
    });
  }
});

test("produção falha fechada fora do loopback estrito; Origin forjado não dispensa IP nem rebaixa cookie HTTPS", () => {
  const nomes = ["NODE_ENV", "FRONTEND_APPLICATION_URL", "BACKEND_CORS_ALLOWED_ORIGINS"];
  const anterior = nomes.map((nome) => process.env[nome]);
  const store = { consumir: () => assert.fail("Não deve consumir cota quando a rede é inválida") };
  const local = "http://localhost:3000/api/Navegador/entrar-estudante";
  try {
    process.env.NODE_ENV = "production";
    const casos = [
      { frontend: "https://app.example.test", url: local },
      { frontend: "", url: local },
      { frontend: "inválido", url: local },
      { frontend: "http://localhost:5173", url: "https://api.example.test/api" },
      { frontend: "http://localhost:5173", url: "http://externo.example.test/api" },
      { frontend: "http://localhost:5173", url: local, proxy: 1 },
      { frontend: "http://localhost:5173", url: local, headers: { "x-forwarded-proto": "https" } },
      { frontend: "http://localhost:5173", url: local, headers: { "x-forwarded-proto": "" } },
      { frontend: "http://localhost:5173", url: local, headers: { "x-forwarded-for": "" } },
      {
        frontend: "http://localhost:5173",
        url: local,
        headers: { "x-forwarded-for": "127.0.0.1, 127.0.0.1" },
      },
      {
        frontend: "http://localhost:5173",
        url: local,
        headers: { "x-forwarded-proto": "http,https" },
      },
      {
        frontend: "http://localhost:5173",
        url: local,
        headers: { "x-forwarded-for": "198.51.100.20" },
      },
      {
        frontend: "http://localhost:5173",
        url: local,
        cors: "http://localhost:5173,https://app.example.test",
      },
      { frontend: "http://localhost:5173", url: local, cors: "inválido" },
    ];
    for (const caso of casos) {
      process.env.FRONTEND_APPLICATION_URL = caso.frontend;
      process.env.BACKEND_CORS_ALLOWED_ORIGINS = caso.cors ?? "";
      const req = new Request(caso.url, {
        headers: { origin: "http://localhost:5173", ...caso.headers },
      });
      assert.equal(producaoExigeIp(req, caso.proxy ?? 0), true, JSON.stringify(caso));
      assert.throws(
        () => limitarAutenticacao(req, caso.proxy ?? 0, "conta@example.test", store),
        (e: any) => e.status === 503 && e.code === "IP_UNAVAILABLE",
      );
      assert.equal(producaoExigeIp(req, caso.proxy ?? 0, false), false);
    }
    process.env.FRONTEND_APPLICATION_URL = "https://app.example.test";
    const cookie = opcoesCookieSessaoSupabase(
      new Request("https://api.example.test/api", { headers: { origin: "http://localhost:5173" } }),
    );
    assert.equal(cookie.name, "__Host-sisoaprova-auth-token");
    assert.equal(cookie.secure, true);
    assert.equal(cookie.sameSite, "none");
    assert.equal(cookie.partitioned, true);
  } finally {
    nomes.forEach((nome, i) => {
      if (anterior[i] === undefined) delete process.env[nome];
      else process.env[nome] = anterior[i];
    });
  }
});
