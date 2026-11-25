import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { pix, configPayments, pedidoPayments } from "./fixtures-payments.js";
import {
  ClienteMercadoPago,
  ErroPagamentoNaoCriado,
} from "../src/infrastructure/cliente-mercado-pago.js";
import { ClientePaymentsMercadoPago } from "../src/infrastructure/cliente-payments-mercado-pago.js";
import { ServicoPagamentosAssinaturas } from "../src/application/pagamentos-assinaturas.service.js";
import { paymentFixture } from "./fixtures-payments.js";

process.env.FRONTEND_APPLICATION_URL = "https://app.example.test";
process.env.BACKEND_LOG_LEVEL = "silent";
process.env.MERCADO_PAGO_PUBLIC_KEY = "TEST-public-fixture";
const { criarAtendedorFinanceiro, validarFiltrosFinanceiros, validarPlanoComercial } =
  await import("../src/http/rotas-financeiro-next.js");
function cliente(tipo = "estudante", autenticado = true) {
  return {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({
        data: { user: autenticado ? { id: pedidoPayments.id_pessoa } : null },
        error: null,
      }),
    },
    from(t: string) {
      const q: any = {
        select: () => q,
        eq: () => q,
        order: () =>
          Promise.resolve({
            data: [{ id: pedidoPayments.id, valor: 19.9, moeda: "BRL" }],
            error: null,
          }),
        single: async () => ({
          data:
            t === "usuarios"
              ? { tipo, estado_cadastro: "ativo", cadastro_completo: true }
              : {
                  ...pedidoPayments,
                  id_pagamento_mp: null,
                  status_pagamento_mp: null,
                  detalhe_pagamento_mp: null,
                },
          error: null,
        }),
      };
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}
const req = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("https://api.example.test/api/financeiro/" + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
const dependencias = {
  criarAdmin: () => ({ rpc: async () => ({ data: true, error: null }) }) as any,
  criarServico: () =>
    ({
      iniciarCheckout: async () => pedidoPayments,
      repo: { obterPedido: async () => pedidoPayments, executar: async () => true },
      sincronizar: async () => pedidoPayments,
    }) as any,
  agendar: ((cb: () => Promise<void>) => void cb) as any,
};
test("Financeiro: catálogo/config públicos e sessão/roles/CSRF obrigatórios", async () => {
  const anon = criarAtendedorFinanceiro((() => cliente("estudante", false)) as any, dependencias);
  const config = await anon(req("configuracao"));
  assert.equal(config.status, 200);
  assert.equal(config.headers.get("cache-control"), "no-store");
  assert(!JSON.stringify(await config.json()).includes(configPayments.accessToken));
  assert.equal((await anon(req("planos"))).status, 200);
  for (const path of [
    "acesso",
    "minha-assinatura",
    "pedido?id=" + pedidoPayments.id,
    "admin/painel",
  ])
    assert.equal((await anon(req(path))).status, 401);
  const aluno = criarAtendedorFinanceiro((() => cliente()) as any, dependencias);
  assert.equal((await aluno(req("admin/painel"))).status, 403);
  assert.equal(
    (await aluno(req("checkout", "POST", { idPlano: pedidoPayments.id_plano, pagamento: pix })))
      .status,
    403,
  );
  const h = {
    origin: "https://app.example.test",
    "x-siso-aprova-client": "web",
    "x-idempotency-key": randomUUID(),
  };
  const ok = await aluno(
    req("checkout", "POST", { idPlano: pedidoPayments.id_plano, pagamento: pix }, h),
  );
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.webhook_confirmado, false);
  assert.equal(
    (
      await aluno(
        req(
          "checkout",
          "POST",
          { idPlano: pedidoPayments.id_plano, pagamento: pix, valor: 0.01 },
          h,
        ),
      )
    ).status,
    400,
  );
  assert.equal((await aluno(req("tarefas"))).status, 405);
  assert.equal((await aluno(req("tarefas", "POST"))).status, 401);
  const alunoFalha = criarAtendedorFinanceiro((() => cliente()) as any, {
    ...dependencias,
    criarServico: () =>
      ({
        iniciarCheckout: async () => {
          throw new ErroPagamentoNaoCriado();
        },
      }) as any,
  });
  const naoCriado = await alunoFalha(
    req("checkout", "POST", { idPlano: pedidoPayments.id_plano, pagamento: pix }, h),
  );
  assert.equal(naoCriado.status, 400);
  const corpoNaoCriado = await naoCriado.json();
  assert.equal(corpoNaoCriado.code, "PAYMENT_NOT_CREATED");
  assert.equal(corpoNaoCriado.retryable, true);
});
test("Financeiro valida PUT id, datas reais, intervalo e ambiente400", () => {
  for (const query of ["de=2026-02-30", "ate=x", "ambiente=outro", "de=2026-12-01&ate=2026-01-01"])
    assert.throws(() => validarFiltrosFinanceiros(new URL("https://api.example.test/?" + query)));
  assert.deepEqual(
    validarFiltrosFinanceiros(new URL("https://api.example.test/?ambiente=teste&de=2026-02-28")),
    { ambiente: "teste" },
  );
  assert.throws(() => validarPlanoComercial({}, true));
});
test("POST sincronizar respeita rejeitado sem search, GET por id com rate-limit 429 e search ambíguo 409", async () => {
  const h = {
    origin: "https://app.example.test",
    "x-siso-aprova-client": "web",
  };
  const chamadasMp: string[] = [];
  let pedidoAtual = {
    ...pedidoPayments,
    idPagamentoMp: null as string | null,
    status: "rejeitado" as const,
    statusPagamentoMp: "rejected",
    status_detail: "creation_rejected",
  };
  let ultimoSync = 0;
  let resultadosSearch = [paymentFixture(), paymentFixture()];
  const mp = new ClientePaymentsMercadoPago(configPayments, async (url) => {
    const caminho = new URL(String(url)).pathname;
    chamadasMp.push(caminho);
    if (caminho === "/v1/payments/search") return Response.json({ results: resultadosSearch });
    return Response.json(paymentFixture());
  });
  const repo = {
    obterPedido: async () => pedidoAtual,
    executar: async (op: string) => {
      if (op === "limitar_sincronizacao") {
        if (Date.now() - ultimoSync < 10_000) {
          const erro = new Error("Aguarde alguns segundos antes de consultar novamente");
          (erro as any).code = "P0429";
          throw erro;
        }
        ultimoSync = Date.now();
        return true;
      }
      return pedidoAtual;
    },
  } as any;
  const servicoReal = new ServicoPagamentosAssinaturas(
    repo,
    new ClienteMercadoPago({ ...configPayments, accessToken: "APP_USR-fixture" }),
    mp,
  );
  const atendedor = criarAtendedorFinanceiro((() => cliente()) as any, {
    ...dependencias,
    criarServico: () => servicoReal,
  });

  // (a) pedido payments rejeitado sem idPagamentoMp -> 200 sem /v1/payments/search
  const rRejeitado = await atendedor(req("sincronizar", "POST", { id: pedidoPayments.id }, h));
  assert.equal(rRejeitado.status, 200);
  assert.equal((await rRejeitado.json()).data.status, "rejeitado");
  assert.equal(chamadasMp.length, 0);

  // (b) pedido payments com idPagamentoMp -> GET /v1/payments/{id} (zero /search) e 2ª chamada <10s -> 429
  ultimoSync = 0;
  const idFixture = String(paymentFixture().id);
  pedidoAtual = {
    ...pedidoPayments,
    idPagamentoMp: idFixture,
    status: "pendente",
    statusPagamentoMp: "pending",
    status_detail: "pending_waiting_transfer",
  };
  const rComId1 = await atendedor(req("sincronizar", "POST", { id: pedidoPayments.id }, h));
  assert.equal(rComId1.status, 200);
  assert.deepEqual(chamadasMp, [`/v1/payments/${idFixture}`]);
  const rComId2 = await atendedor(req("sincronizar", "POST", { id: pedidoPayments.id }, h));
  assert.equal(rComId2.status, 429);
  assert.deepEqual(chamadasMp, [`/v1/payments/${idFixture}`]);

  // (c) múltiplos resultados em /v1/payments/search -> 409
  ultimoSync = 0;
  chamadasMp.length = 0;
  pedidoAtual = {
    ...pedidoPayments,
    idPagamentoMp: null,
    status: "pendente",
    statusPagamentoMp: null,
    status_detail: null,
  };
  const rMultiplos = await atendedor(req("sincronizar", "POST", { id: pedidoPayments.id }, h));
  assert.equal(rMultiplos.status, 409);
  assert.deepEqual(chamadasMp, ["/v1/payments/search"]);
});
