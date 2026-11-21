import test from "node:test";
import assert from "node:assert/strict";
import { cookiesParaResposta } from "../src/security/cookies.js";
process.env.NODE_ENV = "production";
process.env.FRONTEND_APPLICATION_URL = "https://front.example.test";
process.env.BACKEND_TRUSTED_PROXY_HOP_COUNT = "1";
process.env.BACKEND_LOG_LEVEL = "silent";
const user = { id: "usuario-fixture", email: "fixture@example.test" };
const cookie = {
  nome: "__Host-sisoaprova-auth-token",
  valor: "NOVO_TOKEN_FIXTURE_NAO_EMITIR",
  opcoes: { path: "/", httpOnly: true, secure: true, sameSite: "none", maxAge: 3600 },
};
const req = (path: string) =>
  new Request("https://api.example.test" + path, {
    method: "POST",
    headers: {
      Origin: "https://front.example.test",
      "X-Siso-Aprova-Client": "web",
      "x-forwarded-for": "203.0.113.90",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
function factory(registrar: any, limpeza: boolean) {
  return {
    auth: {
      getUser: async () => ({ data: { user }, error: null }),
      getSession: async () => ({
        data: { session: { access_token: "token-fixture" } },
        error: null,
      }),
      getClaims: async () => ({ data: { claims: { amr: ["password"] } }, error: null }),
      refreshSession: async () => {
        registrar([cookie], {});
        return { data: { user, session: { expires_in: 3600 } }, error: null };
      },
      signOut: async () => {
        if (limpeza)
          registrar([{ ...cookie, valor: "", opcoes: { ...cookie.opcoes, maxAge: 0 } }], {});
        return { error: { message: "erro-fixture" } };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: { estado_cadastro: "convite_pendente" }, error: null }),
        }),
      }),
    }),
  } as any;
}
for (const limpeza of [false, true])
  test(`handler refresh inativo+revogação falha não publica sessão (limpezaSDK=${limpeza})`, async () => {
    const { criarAtendedorHttp } = await import("../src/http/atender-requisicao-api-next.js");
    const handle = criarAtendedorHttp((_req, registrar) => factory(registrar, limpeza));
    const r = await handle(req("/api/Autenticacao/renovar-sessao"), {
      params: Promise.resolve({ path: [] }),
    });
    assert.equal(r.status, 503);
    const set = r.headers.get("set-cookie") ?? "";
    assert(!set.includes(cookie.valor));
    assert(set.includes(cookie.nome + "="));
    assert(/Max-Age=0/i.test(set));
    assert(!(await r.json()).success);
  });
test("financeiro descarta credencial atualizada ao falhar autorização", async () => {
  const { criarAtendedorFinanceiro } = await import("../src/http/rotas-financeiro-next.js");
  const handle = criarAtendedorFinanceiro((_req, registrar) => {
    const c = factory(registrar, false);
    c.auth.getSession = async () => {
      registrar([cookie], {});
      return { data: { session: { access_token: "token-fixture" } }, error: null };
    };
    return c;
  });
  const r = await handle(req("/api/financeiro/pedido") as any);
  assert.equal(r.status, 403);
  const set = r.headers.get("set-cookie") ?? "";
  assert(!set.includes(cookie.valor));
  assert(/Max-Age=0/i.test(set));
});
test("política de cookies mantém emissão só no sucesso e limpeza em falhas", () => {
  assert.equal(cookiesParaResposta([cookie], 200)[0]!.valor, cookie.valor);
  const erro = cookiesParaResposta([cookie], 500)[0]!;
  assert.equal(erro.valor, "");
  assert.equal(erro.opcoes.maxAge, 0);
  assert.equal(erro.opcoes.path, "/");
});
