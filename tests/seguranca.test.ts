import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LimitesSqlite, ipConfiavel, limitarAutenticacao } from "../src/security/rate-limit.js";
import { possuiAmrRecuperacao, restringirRecuperacao } from "../src/security/sessoes.js";
import { validarSenha } from "../src/security/senhas.js";
import { cabecalhosSeguranca, redacaoLogs } from "../src/security/headers.mjs";
import { atenderAutenticacaoSupabaseNext as auth } from "../src/http/autenticacao-supabase-next.js";
import {
  operacoesDadosContaUsuarios,
  mascararPessoa,
} from "../src/application/dados-conta-usuarios-administracao.service.js";
import { classificarErroAplicacao } from "../src/domain/erros-validacoes-respostas-api.js";
import { gerarDocumentoOpenApi } from "../src/http/documentacao-openapi.js";
const user = { id: "teste-user", email: "exemplo@example.test" };
function cliente(overrides: any = {}) {
  const perfil = {
    idUsuario: user.id,
    idPessoa: "pessoa",
    nome_completo: "Pessoa Teste",
    email: user.email,
    tipo: "estudante",
    estado_cadastro: "ativo",
    cadastro_completo: true,
    criado_em: "2026-01-01",
    ultimo_acesso_em: null,
  };
  return {
    auth: {
      getUser: async () => ({ data: { user }, error: null }),
      getSession: async () => ({
        data: { session: { access_token: "token-fixture", expires_at: 2000000000 } },
        error: null,
      }),
      getClaims: async () => ({ data: { claims: { amr: [{ method: "password" }] } }, error: null }),
      signOut: async () => ({ error: null }),
      refreshSession: async () => ({ data: { user, session: { expires_in: 3600 } }, error: null }),
      signInWithPassword: async () => ({
        data: {
          user,
          session: {
            expires_in: 3600,
            access_token: "nao-devolver",
            refresh_token: "nao-devolver",
          },
        },
        error: null,
      }),
      updateUser: async () => ({ error: null }),
      ...overrides,
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: perfil, error: null }) }) }),
    }),
  } as any;
}
const request = (xff?: string) =>
  new Request("https://api.example.test/api", { headers: xff ? { "x-forwarded-for": xff } : {} });
const erroStatus = (s: number) => (e: any) => e.status === s;
for (const amr of [["recovery"], [{ method: "recovery" }]])
  test("recovery reconhecido e bloqueia API financeira/alias", async () => {
    const c = cliente({ getClaims: async () => ({ data: { claims: { amr } }, error: null }) });
    assert(possuiAmrRecuperacao(amr));
    for (const caminho of [
      "/api/financeiro/planos",
      "/api/Usuario/listar",
      "/api/Autenticacao/renovar-sessao",
      "/api/Navegador/confirmar-sessao",
    ])
      await assert.rejects(() => restringirRecuperacao(c, caminho), erroStatus(403));
    assert(await restringirRecuperacao(c, "/api/Navegador/redefinir-senha"));
  });
test("claims inválidas falham fechadas", async () => {
  await assert.rejects(
    () =>
      restringirRecuperacao(
        cliente({ getClaims: async () => ({ data: null, error: {} }) }),
        "/api/Usuario/listar",
      ),
    erroStatus(401),
  );
});
test("XFF livre não confiável em trust0; hops/IPv6 validados", () => {
  assert.equal(ipConfiavel(request("203.0.113.1"), 0), null);
  assert.equal(ipConfiavel(request("texto"), 1), null);
  assert.equal(ipConfiavel(request("203.0.113.1"), 2), null);
  assert.equal(ipConfiavel(request("forjado,2001:db8::1"), 1), "2001:db8::1");
});
test("dev trust0 aceita contas distintas e normaliza email", () => {
  const store = new LimitesSqlite(":memory:");
  for (let i = 0; i < 10; i++)
    limitarAutenticacao(request("spoof"), 0, " A@example.test ", store, false);
  assert.throws(
    () => limitarAutenticacao(request(), 0, "a@EXAMPLE.test", store, false),
    erroStatus(429),
  );
  assert.doesNotThrow(() => limitarAutenticacao(request(), 0, "b@example.test", store, false));
  store.fechar();
});
test("produção trust0/semIP retorna503, não um balde global", () => {
  const store = new LimitesSqlite(":memory:");
  assert.throws(
    () => limitarAutenticacao(request(), 0, "a@example.test", store, true),
    erroStatus(503),
  );
  store.fechar();
});
test("limite porIP adicional limita contas alternadas", () => {
  const store = new LimitesSqlite(":memory:");
  for (let i = 0; i < 30; i++)
    limitarAutenticacao(request("203.0.113.4"), 1, `conta${i}@example.test`, store, true);
  assert.throws(
    () => limitarAutenticacao(request("203.0.113.4"), 1, "outra@example.test", store, true),
    erroStatus(429),
  );
  store.fechar();
});
test("store persiste reabertura, expira e limita capacidade", () => {
  const pasta = mkdtempSync(join(tmpdir(), "rate-test-"));
  const f = join(pasta, "db.sqlite");
  let agora = 1000;
  let s = new LimitesSqlite(f, () => agora, 1);
  s.consumir("a", 1);
  s.fechar();
  s = new LimitesSqlite(f, () => agora, 1);
  assert.throws(() => s.consumir("a", 1), erroStatus(429));
  assert.throws(() => s.consumir("b", 1), erroStatus(503));
  agora += 60001;
  assert.doesNotThrow(() => s.consumir("b", 1));
  s.fechar();
  rmSync(pasta, { recursive: true });
});
test("logout verifica usuário antes da revogação e não ignora falha", async () => {
  let chamada = false;
  await assert.rejects(
    () =>
      auth(
        "POST",
        "/api/Autenticacao/sair-sessao",
        cliente({ getUser: async () => ({ data: { user: null }, error: {} }) }),
        async () => ({}),
        undefined,
        {
          bearerToken: "fixture",
          revogarBearer: async () => {
            chamada = true;
          },
        },
      ),
    erroStatus(401),
  );
  assert(!chamada);
  await assert.rejects(
    () =>
      auth(
        "POST",
        "/api/Navegador/sair-sessao",
        cliente({ signOut: async () => ({ error: {} }) }),
        async () => ({}),
      ),
    erroStatus(503),
  );
});
test("logout Bearer revoga explicitamente; falha propaga sem200", async () => {
  let chamada = false;
  const r = await auth(
    "POST",
    "/api/Autenticacao/sair-sessao",
    cliente(),
    async () => ({}),
    undefined,
    {
      bearerToken: "fixture",
      revogarBearer: async () => {
        chamada = true;
      },
    },
  );
  assert(chamada && r.success);
  await assert.rejects(() =>
    auth("POST", "/api/Autenticacao/sair-sessao", cliente(), async () => ({}), undefined, {
      bearerToken: "fixture",
      revogarBearer: async () => {
        throw new Error("falha-fixture");
      },
    }),
  );
});
test("senha Bearer recusa antes de update", async () => {
  let update = false;
  await assert.rejects(
    () =>
      auth(
        "POST",
        "/api/Autenticacao/atualizar-senha",
        cliente({
          updateUser: async () => {
            update = true;
            return { error: null };
          },
        }),
        async () => ({ senha: "Exemplo seguro123", senhaAtual: "atual" }),
        undefined,
        { bearerToken: "fixture" },
      ),
    erroStatus(400),
  );
  assert(!update);
});
test("senha atual obrigatória e falha reauth não atualiza", async () => {
  let update = false;
  const c = cliente({
    updateUser: async () => {
      update = true;
      return { error: null };
    },
  });
  await assert.rejects(
    () =>
      auth("POST", "/api/Navegador/atualizar-senha", c, async () => ({
        senha: "Exemplo seguro123",
      })),
    erroStatus(400),
  );
  await assert.rejects(() =>
    auth(
      "POST",
      "/api/Navegador/atualizar-senha",
      c,
      async () => ({ senha: "Exemplo seguro123", senhaAtual: "atual" }),
      undefined,
      {
        reautenticar: async () => {
          throw new Error("senha-nao-confere");
        },
      },
    ),
  );
  assert(!update);
});
test("troca senha reautentica antes de update e revoga global", async () => {
  const ordem: string[] = [];
  const c = cliente({
    updateUser: async () => {
      ordem.push("update");
      return { error: null };
    },
    signOut: async ({ scope }: any) => {
      ordem.push(scope);
      return { error: null };
    },
  });
  await auth(
    "POST",
    "/api/Navegador/atualizar-senha",
    c,
    async () => ({ senha: "Exemplo seguro123", senhaAtual: "atual" }),
    undefined,
    {
      reautenticar: async () => {
        ordem.push("reauth");
      },
    },
  );
  assert.deepEqual(ordem, ["reauth", "update", "global"]);
});
test("redefinição exige recovery; sucesso encerra global", async () => {
  await assert.rejects(
    () =>
      auth("POST", "/api/Navegador/redefinir-senha", cliente(), async () => ({
        senha: "Exemplo seguro123",
      })),
    erroStatus(403),
  );
  let global = false;
  const c = cliente({
    getClaims: async () => ({ data: { claims: { amr: ["recovery"] } }, error: null }),
    signOut: async ({ scope }: any) => {
      global = scope === "global";
      return { error: null };
    },
  });
  assert(
    (
      await auth("POST", "/api/Navegador/redefinir-senha", c, async () => ({
        senha: "Exemplo seguro123",
      }))
    ).success,
  );
  assert(global);
});
test("login e refresh não devolvem tokens JSON", async () => {
  for (const acao of ["entrar-estudante", "renovar-sessao"]) {
    const r = await auth("POST", "/api/Autenticacao/" + acao, cliente(), async () => ({
      email: user.email,
      senha: "fixture",
    }));
    assert(!JSON.stringify(r).includes("Token"));
  }
});
test("refresh conta inativa revoga e falha", async () => {
  const c = cliente();
  let revoked = false;
  c.from = () => ({
    select: () => ({
      eq: () => ({ single: async () => ({ data: { estado_cadastro: "inativo" }, error: null }) }),
    }),
  });
  c.auth.signOut = async () => {
    revoked = true;
    return { error: null };
  };
  await assert.rejects(
    () => auth("POST", "/api/Autenticacao/renovar-sessao", c, async () => ({})),
    erroStatus(403),
  );
  assert(revoked);
});
test("refresh perfil ausente revoga e falha", async () => {
  const c = cliente();
  let revoked = false;
  c.from = () => ({
    select: () => ({ eq: () => ({ single: async () => ({ data: null, error: {} }) }) }),
  });
  c.auth.signOut = async () => {
    revoked = true;
    return { error: null };
  };
  await assert.rejects(
    () => auth("POST", "/api/Navegador/renovar-sessao", c, async () => ({})),
    erroStatus(403),
  );
  assert(revoked);
});
test("CPF nunca retornado integralmente e omitido é preservado", async () => {
  const pessoa = { cpf: "52998224725" };
  let salvo: any;
  const repo = {
    obterRegistroObrigatorio: async () => ({}),
    executarFuncaoPostgreSqlComContrato: async () => pessoa,
    executarFuncaoPostgreSql: async (_f: any, args: any) => {
      salvo = args.p_pessoa;
    },
  };
  const op = operacoesDadosContaUsuarios({
    repo,
    exigirUsuarioAtivo: async () => ({ idUsuario: "teste" }),
  } as any);
  const dados = {
    nomeCompleto: "Pessoa Exemplo",
    dataNascimento: "1990-01-01",
    cep: "01001000",
    logradouro: "Teste",
    numero: "1",
    bairro: "Teste",
    cidade: "Teste",
    uf: "SP",
    complemento: null,
  };
  const r = await op.atualizarMinhaConta(dados);
  assert.equal(salvo.cpf, pessoa.cpf);
  assert(!JSON.stringify(r).includes(pessoa.cpf));
  assert.match(r.data!.pessoa!.cpf!, /\*/);
  await assert.rejects(
    () => op.atualizarMinhaConta({ ...dados, cpf: "***.***.247-**" }),
    erroStatus(400),
  );
  assert.equal(mascararPessoa(null), null);
});
test("usuários usa paginação/filtros/busca nome OU email", async () => {
  let parametros: any;
  const repo = {
    consultarPaginaRegistros: async (_t: any, _m: any, p: any) => {
      parametros = p;
      return { itens: [], total: 0 };
    },
  };
  const op = operacoesDadosContaUsuarios({
    repo,
    exigirAdministradorAtivo: async () => ({}),
  } as any);
  await op.listarUsuarios({
    pagina: 2,
    quantidadePorPagina: 20,
    busca: "exemplo",
    tipo: "estudante",
    estadoCadastro: "ativo",
    cadastroCompleto: false,
  });
  assert.equal(parametros.offset, 20);
  assert.equal(parametros.limit, 20);
  assert.deepEqual(
    parametros.or.map((f: any) => f.column),
    ["nome_completo", "email"],
  );
  assert.equal(parametros.filters.length, 3);
  await assert.rejects(
    () => op.listarUsuarios({ pagina: 1, quantidadePorPagina: 101, busca: null, tipo: null }),
    erroStatus(400),
  );
});
test("política senha e erros P0001 não vazam mensagem arbitrária", () => {
  for (const senha of ["curta", " EspacosInicio12", "FinalEspacos12 "])
    assert.throws(() => validarSenha(senha));
  assert.equal(validarSenha("Uma frase segura 2026"), "Uma frase segura 2026");
  assert(
    !classificarErroAplicacao({ code: "P0001", message: "segredo-fixture" }).message.includes(
      "segredo-fixture",
    ),
  );
});
test("headers produção/dev e contratos sem refresh no corpo", () => {
  assert(cabecalhosSeguranca(true)["Strict-Transport-Security"]);
  assert(!cabecalhosSeguranca(false)["Strict-Transport-Security"]);
  assert.equal(cabecalhosSeguranca()["X-Frame-Options"], "DENY");
  assert(redacaoLogs.paths.includes("senhaAtual"));
  const d = gerarDocumentoOpenApi();
  assert(!d.paths["/api/financeiro/tarefas"]?.get);
  assert(d.paths["/api/financeiro/tarefas"]?.post);
  assert(!JSON.stringify(d.paths["/api/Autenticacao/renovar-sessao"]).includes("refreshToken"));
});

test("AMR malformado não é tratado como sessão normal", async () => {
  const c = cliente({
    getClaims: async () => ({ data: { claims: { amr: { method: "recovery" } } }, error: null }),
  });
  await assert.rejects(() => restringirRecuperacao(c, "/api/Usuario/listar"), erroStatus(401));
});
test("store falha fechada em arquivo sem acesso utilizável e compartilha conexões", () => {
  const invalido = new LimitesSqlite("/dev/null/limites.sqlite");
  assert.throws(() => invalido.consumir("a", 1), erroStatus(503));
  const pasta = mkdtempSync(join(tmpdir(), "rate-share-"));
  const f = join(pasta, "db.sqlite");
  const a = new LimitesSqlite(f);
  const b = new LimitesSqlite(f);
  a.consumir("compartilhado", 2);
  b.consumir("compartilhado", 2);
  assert.throws(() => a.consumir("compartilhado", 2), erroStatus(429));
  a.fechar();
  b.fechar();
  rmSync(pasta, { recursive: true });
});
test("IPv6 equivalente não burla identidade e email inválido não consome conta", () => {
  assert.equal(
    ipConfiavel(request("2001:0db8:0:0:0:0:0:1"), 1),
    ipConfiavel(request("2001:db8::1"), 1),
  );
  const store = new LimitesSqlite(":memory:");
  assert.throws(
    () => limitarAutenticacao(request(), 0, "sem-email", store, false),
    erroStatus(400),
  );
  store.fechar();
});
test("revogação após senha ou refresh falha sem200", async () => {
  const c = cliente({
    getClaims: async () => ({ data: { claims: { amr: ["recovery"] } }, error: null }),
    signOut: async () => ({ error: {} }),
  });
  await assert.rejects(
    () =>
      auth("POST", "/api/Navegador/redefinir-senha", c, async () => ({
        senha: "Exemplo seguro123",
      })),
    erroStatus(503),
  );
});
test("CPF novo válido substitui; inválido é rejeitado; resposta continua mascarada", async () => {
  let salvo: any;
  const repo = {
    obterRegistroObrigatorio: async () => ({}),
    executarFuncaoPostgreSqlComContrato: async () => ({ cpf: salvo?.cpf ?? "52998224725" }),
    executarFuncaoPostgreSql: async (_f: any, args: any) => {
      salvo = args.p_pessoa;
    },
  };
  const op = operacoesDadosContaUsuarios({
    repo,
    exigirUsuarioAtivo: async () => ({ idUsuario: "teste" }),
  } as any);
  const dados = {
    nomeCompleto: "Pessoa Exemplo",
    dataNascimento: "1990-01-01",
    cep: "01001000",
    logradouro: "Teste",
    numero: "1",
    bairro: "Teste",
    cidade: "Teste",
    uf: "SP",
    complemento: null,
    cpf: "11111111111",
  };
  await assert.rejects(() => op.atualizarMinhaConta(dados), erroStatus(400));
  const r = await op.atualizarMinhaConta({ ...dados, cpf: "52998224725" });
  assert.equal(salvo.cpf, "52998224725");
  assert(!JSON.stringify(r).includes(salvo.cpf));
});
test("P0001 mapeia somente mensagens conhecidas e status compatíveis", () => {
  assert.equal(
    classificarErroAplicacao({
      code: "P0001",
      message: "Você atingiu o limite de 20 interações com IA por dia.",
    }).status,
    429,
  );
  assert.equal(
    classificarErroAplicacao({
      code: "P0001",
      message: "Esta questão já está sendo analisada. Aguarde e consulte novamente.",
    }).status,
    409,
  );
  assert.equal(
    classificarErroAplicacao({ code: "P0001", message: "limite de 20 segredo arbitrario" }).status,
    400,
  );
});

test("produção bloqueia docs e conserva headers em health/erro sem serviços", async () => {
  const anterior = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  process.env.BACKEND_LOG_LEVEL = "silent";
  try {
    const { GET } = await import("../src/app/api/docs/[[...arquivo]]/route.js");
    const docs = await GET(new Request("https://api.example.test/api/docs"), {
      params: Promise.resolve({}),
    });
    assert.equal(docs.status, 404);
    assert.equal(docs.headers.get("x-frame-options"), "DENY");
    assert(docs.headers.get("strict-transport-security"));
    assert.match(docs.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const { atenderRequisicaoApiNext } = await import("../src/http/atender-requisicao-api-next.js");
    const contexto = { params: Promise.resolve({ path: [] }) };
    const health = await atenderRequisicaoApiNext(
      new Request("https://api.example.test/api/health"),
      contexto,
    );
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-frame-options"), "DENY");
    assert(health.headers.get("strict-transport-security"));
    const doc = await atenderRequisicaoApiNext(
      new Request("https://api.example.test/api/openapi.json"),
      contexto,
    );
    assert.equal(doc.status, 404);
    assert(doc.headers.get("content-security-policy"));
  } finally {
    process.env.NODE_ENV = anterior;
  }
});

test("importação rejeita imagem HTTP e aceita HTTPS sem executar banco", async () => {
  const { prepararImportacaoProva } =
    await import("../src/application/importacao-prova.service.js");
  const entrada = (imagemUrl: string) => ({
    aplicar: false,
    arquivo: {
      idProva: "11111111-1111-4111-8111-111111111111",
      idTemaPadrao: "22222222-2222-4222-8222-222222222222",
      questoes: [
        {
          numero: 1,
          enunciado: "Questão de exemplo?",
          tipo: "multipla_escolha",
          dificuldade: "media",
          fonte: "Exemplo",
          imagemUrl,
          alternativas: [
            { letra: "A", texto: "Uma alternativa" },
            { letra: "B", texto: "Outra alternativa" },
          ],
          gabarito: "A",
        },
      ],
    },
  });
  assert.throws(
    () => prepararImportacaoProva(entrada("http://imagem.example.test/q.png")),
    /HTTPS/,
  );
  assert.doesNotThrow(() => prepararImportacaoProva(entrada("https://imagem.example.test/q.png")));
});

test("filtro verificacao_pendente/cadastroCompleto=false segue contrato real", async () => {
  let parametros: any;
  const repo = {
    consultarPaginaRegistros: async (_t: any, _m: any, p: any) => {
      parametros = p;
      return { itens: [], total: 0 };
    },
  };
  const op = operacoesDadosContaUsuarios({
    repo,
    exigirAdministradorAtivo: async () => ({}),
  } as any);
  await op.listarUsuarios({
    pagina: 1,
    quantidadePorPagina: 20,
    busca: null,
    tipo: null,
    estadoCadastro: "verificacao_pendente",
    cadastroCompleto: false,
  });
  assert(
    parametros.filters.some(
      (f: any) => f.column === "estado_cadastro" && f.value === "verificacao_pendente",
    ),
  );
  assert(
    parametros.filters.some((f: any) => f.column === "cadastro_completo" && f.value === false),
  );
  await assert.rejects(
    () =>
      op.listarUsuarios({
        pagina: 1,
        quantidadePorPagina: 20,
        busca: null,
        tipo: null,
        estadoCadastro: "inventado",
      }),
    erroStatus(400),
  );
});

test("corpo sem content-length é interrompido no limite sem aguardar cancelamento remoto", async () => {
  const { lerBytesLimitados } = await import("../src/security/corpo.js");
  let cancelou = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(33));
    },
    cancel() {
      cancelou = true;
      return new Promise(() => {});
    },
  });
  const req = new Request("https://api.example.test/test", {
    method: "POST",
    body,
    duplex: "half",
  } as any);
  await assert.rejects(() => lerBytesLimitados(req, 32), erroStatus(413));
  assert(cancelou);
  const ok = await lerBytesLimitados(
    new Request("https://api.example.test/test", { method: "POST", body: "exemplo" }),
    32,
  );
  assert.equal(ok.toString(), "exemplo");
});
test("imagem HTTPS não aceita credenciais e importação manteve allowlist", async () => {
  const { validarUrlImagem } = await import("../src/security/imagens.js");
  assert.throws(() => validarUrlImagem("https://usuario:senha@example.test/img"), erroStatus(400));
  assert.throws(() => validarUrlImagem("data:image/png;base64,fixture"), erroStatus(400));
  assert.doesNotThrow(() => validarUrlImagem(null));
  assert.doesNotThrow(() => validarUrlImagem("https://example.test/img"));
});

test("política preserva fronteira8–128 conforme decisão coordenada", () => {
  assert.equal(validarSenha("Frase#8a"), "Frase#8a");
  assert.throws(() => validarSenha("Frase#7"));
  assert.equal(validarSenha("x".repeat(128)).length, 128);
  assert.throws(() => validarSenha("x".repeat(129)));
  assert.equal(validarSenha("12345678"), "12345678");
});

test("Swagger dev mantém CSP própria e headers globais não cobrem /api/docs", async () => {
  const { atenderDocumentacaoSwagger } = await import("../src/http/interface-swagger.js");
  const csp = (await atenderDocumentacaoSwagger([])).headers.get("content-security-policy") ?? "";
  for (const diretiva of [
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ])
    assert(csp.includes(diretiva), diretiva);
  const { default: config } = await import("../next.config.js");
  const regras = await config.headers!();
  assert.equal(regras.length, 1);
  const padrao = new RegExp(`^${regras[0]!.source}$`);
  for (const rota of ["/", "/api/health", "/api/openapi.json", "/api/docsx", "/swagger"])
    assert(padrao.test(rota), rota);
  for (const rota of ["/api/docs", "/api/docs/swagger-ui.css", "/api/docs/swagger-initializer.js"])
    assert(!padrao.test(rota), rota);
});

test("landing pública funciona sem Supabase e só mostra Swagger fora de produção", async () => {
  const anterior = process.env.NODE_ENV;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: pagina, metadata } = await import("../src/app/page.js");
  const { proxy, config } = await import("../src/proxy.js");
  try {
    assert.equal(config.matcher, "/");
    assert.equal(metadata.title, "Siso Aprova API");
    for (const ambiente of ["production", "development"]) {
      process.env.NODE_ENV = ambiente;
      const resposta = proxy();
      assert.equal(resposta.headers.get("x-middleware-next"), "1");
      assert.equal(resposta.headers.get("set-cookie"), null);
      const html = renderToStaticMarkup(pagina());
      assert.match(html, /<h1>Siso Aprova API<\/h1>/);
      assert.match(html, /A API está em funcionamento\./);
      assert.doesNotMatch(html, /<script|<style|Supabase|Next\.js|production|development/);
      if (ambiente === "production") {
        assert.equal(
          html,
          "<main><h1>Siso Aprova API</h1><p>A API está em funcionamento.</p></main>",
        );
        assert.doesNotMatch(html, /href=|Swagger|swagger|openapi|api\//);
      } else {
        assert.match(html, /href="\/swagger"/);
      }
    }
  } finally {
    process.env.NODE_ENV = anterior;
  }
});
