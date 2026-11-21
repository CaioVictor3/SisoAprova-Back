import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cluster } from "./cluster-postgresql-descartavel.js";
import { ServicoPagamentosAssinaturas } from "../../src/application/pagamentos-assinaturas.service.js";
import {
  ClienteMercadoPago,
  ErroPagamentoNaoCriado,
} from "../../src/infrastructure/cliente-mercado-pago.js";
import {
  ClientePaymentsMercadoPago,
  type PaymentMercadoPago,
} from "../../src/infrastructure/cliente-payments-mercado-pago.js";
import { configPayments, pix, cartao } from "../fixtures-payments.js";
import type { PedidoPagamento } from "../../src/domain/pagamentos-assinaturas.js";

test(
  "Bricks Payments em PostgreSQL real: concorrência,crash,webhook,RLS e filtros",
  { timeout: 180000 },
  async (t) => {
    const c = await cluster();
    try {
      const aluno = randomUUID(),
        outro = randomUUID(),
        admin = randomUUID();
      for (const id of [aluno, outro, admin]) {
        await c.admin.query(
          "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
          [id, id + "@example.invalid"],
        );
        await c.admin.query(
          'update public.usuarios set cadastro_completo=true where "idUsuario"=$1',
          [id],
        );
      }
      await c.admin.query(`update public.usuarios set tipo='administrador' where "idUsuario"=$1`, [
        admin,
      ]);
      const planos = (
        await c.admin.query("select * from public.planos_comerciais order by duracao_meses")
      ).rows;
      const rpc = async <T = any>(op: string, d: Record<string, unknown> = {}) =>
        (
          await c.admin.query("select public.operar_financeiro_backend($1,$2::jsonb) v", [
            op,
            JSON.stringify(d),
          ])
        ).rows[0].v as T;
      const criar = (pessoa = aluno, chave = randomUUID(), plano = planos[0].id) =>
        rpc<PedidoPagamento>("criar_pedido_payments", { pessoa, chave, plano, ambiente: "teste" });
      const repo = {
        executar: rpc,
        obterPedido: (id: string) => rpc<PedidoPagamento>("pedido", { id }),
      } as any;
      const recursos = new Map<string, PaymentMercadoPago>();
      let seq = 1000,
        posts = 0,
        searches = 0,
        gets = 0,
        duplicarSearch = false,
        timeoutDepois = false,
        rejeitarCriacao400 = false,
        pendingChallenge = false;
      const http: typeof fetch = async (url, init) => {
        const u = new URL(String(url));
        if (u.pathname === "/v1/payment_methods")
          return Response.json([
            { id: "master", payment_type_id: "credit_card", status: "active" },
          ]);
        if (u.pathname === "/v1/payments/search") {
          searches++;
          const matches = [...recursos.values()].filter(
            (p) => p.external_reference === u.searchParams.get("external_reference"),
          );
          return Response.json({
            results: duplicarSearch && matches[0] ? [matches[0], matches[0]] : matches,
          });
        }
        if (init?.method === "POST" && u.pathname === "/v1/payments") {
          posts++;
          if (rejeitarCriacao400) return new Response("{}", { status: 400 });
          const body = JSON.parse(String(init.body));
          const p: PaymentMercadoPago = {
            id: String(++seq),
            status: "pending",
            status_detail: pendingChallenge ? "pending_challenge" : "pending_waiting_transfer",
            transaction_amount: body.transaction_amount,
            external_reference: body.external_reference,
            currency_id: "BRL",
            collector_id: "1234",
            application_id: "5678",
            live_mode: false,
            date_last_updated: new Date().toISOString(),
            payment_method_id: body.payment_method_id,
            payment_type_id: body.payment_method_id === "pix" ? "bank_transfer" : "credit_card",
            ...(pendingChallenge
              ? {
                  three_ds_info: {
                    external_resource_url:
                      "https://acs-public.tp.mastercard.com/api/v1/browser_Challenges",
                    creq: "fixture_creq",
                  },
                }
              : {}),
          };
          recursos.set(String(p.id), p);
          if (timeoutDepois) throw new Error("Resposta perdida após aceite simulado");
          return Response.json(p);
        }
        const id = u.pathname.split("/").at(-1)!;
        gets++;
        const p = recursos.get(id);
        if (!p) throw new Error("Recurso fixture ausente");
        return Response.json(p);
      };
      const mp = new ClientePaymentsMercadoPago(configPayments, http);
      const svc = new ServicoPagamentosAssinaturas(
        repo,
        new ClienteMercadoPago({ ...configPayments, accessToken: "APP_USR-legado-fixture" }),
        mp,
      );
      const premium = async (id = aluno) => {
        const conn = await c.admin.connect();
        try {
          await conn.query("begin");
          await conn.query("select set_config('request.jwt.claim.sub',$1,true)", [id]);
          await conn.query("set local role authenticated");
          const v = (await conn.query("select public.tem_acesso_premium() v")).rows[0].v;
          await conn.query("rollback");
          return v;
        } finally {
          conn.release();
        }
      };
      let primeiro: PedidoPagamento;
      await t.test(
        "Pix: preço do banco, confirmação assinada, inbox dedup e período único",
        async () => {
          const chave = randomUUID();
          primeiro = await svc.iniciarCheckout(aluno, planos[0].id, chave, pix);
          assert.equal(primeiro.provedor, "payments");
          assert.equal(primeiro.valor, "19.90");
          assert.equal(primeiro.webhook_confirmado, false);
          assert.equal(await premium(), false);
          assert.equal(
            (await svc.iniciarCheckout(aluno, planos[0].id, chave, pix)).idPagamentoMp,
            primeiro.idPagamentoMp,
          );
          assert.equal(posts, 1);
          const remote = recursos.get(primeiro.idPagamentoMp!)!;
          remote.status = "approved";
          remote.status_detail = "accredited";
          remote.date_last_updated = new Date(Date.now() + 1000).toISOString();
          await svc.sincronizar(primeiro);
          assert.equal(await premium(), false);
          await rpc("receber_webhook", {
            chave: "payment-primeiro",
            order: remote.id,
            provedor: "payments",
            ambiente: "teste",
          });
          await rpc("receber_webhook", {
            chave: "payment-primeiro",
            order: remote.id,
            provedor: "payments",
            ambiente: "teste",
          });
          assert.equal((await svc.processarFila()).processados, 1);
          assert.equal(await premium(), true);
          assert.equal((await svc.processarFila()).processados, 0);
          const p = await repo.obterPedido(primeiro.id);
          assert.equal(p.webhook_confirmado, true);
          assert.equal(p.statusPagamentoMp, "approved");
          assert.equal(
            (
              await c.admin.query(
                "select count(*)::integer n from public.assinaturas where id_pedido=$1 and inicio_em is not null",
                [p.id],
              )
            ).rows[0].n,
            1,
          );
        },
      );
      await t.test(
        "Token/creq não persistem,3DS recupera após reload, sem segunda criação",
        async () => {
          pendingChallenge = true;
          const key = randomUUID();
          const p = await svc.iniciarCheckout(outro, planos[0].id, key, cartao);
          assert(p.threeDsInfo);
          assert((await svc.sincronizar(p)).threeDsInfo);
          assert.equal(posts, 2);
          const serialized = (
            await c.admin.query(
              "select to_jsonb(p)::text v from public.pedidos_pagamento p where id=$1",
              [p.id],
            )
          ).rows[0].v;
          assert(!serialized.includes(cartao.token));
          assert(!serialized.includes("fixture_creq"));
          assert(!serialized.includes(pix.payer.email));
          const remote = recursos.get(p.idPagamentoMp!)!;
          remote.status = "rejected";
          remote.status_detail = "cc_rejected_3ds_challenge";
          remote.date_last_updated = new Date(Date.now() + 1000).toISOString();
          await svc.sincronizar(p);
          pendingChallenge = false;
        },
      );
      await t.test(
        "Timeout depois POST recupera por referência, nunca reenvia token/chave",
        async () => {
          timeoutDepois = true;
          const key = randomUUID();
          await assert.rejects(() => svc.iniciarCheckout(outro, planos[0].id, key, cartao));
          const antes = posts;
          const p = await criar(outro, key);
          assert.equal(
            (
              await c.admin.query(
                "select estado_checkout_mp v from public.pedidos_pagamento where id=$1",
                [p.id],
              )
            ).rows[0].v,
            "ambiguo",
          );
          const recovered = await svc.iniciarCheckout(outro, planos[0].id, key, {
            ...cartao,
            token: "token-novo-proibido",
          });
          assert(recovered.idPagamentoMp);
          assert.equal(posts, antes);
          timeoutDepois = false;
          const remote = recursos.get(recovered.idPagamentoMp!)!;
          remote.status = "rejected";
          remote.status_detail = "cc_rejected_other_reason";
          remote.date_last_updated = new Date(Date.now() + 1000).toISOString();
          await svc.sincronizar(recovered);

          rejeitarCriacao400 = true;
          const keyFalha = randomUUID();
          await assert.rejects(
            () => svc.iniciarCheckout(outro, planos[0].id, keyFalha, cartao),
            (e: unknown) => e instanceof ErroPagamentoNaoCriado,
          );
          rejeitarCriacao400 = false;
          const antesReenvio = posts,
            searchesAntesRejeitado = searches;
          const rejeitado = await svc.iniciarCheckout(outro, planos[0].id, keyFalha, cartao);
          assert.equal(rejeitado.status, "rejeitado");
          assert.equal(rejeitado.statusPagamentoMp, "rejected");
          assert.equal(rejeitado.status_detail, "creation_rejected");
          assert.equal(posts, antesReenvio);
          const syncRejeitado = await svc.sincronizar(rejeitado);
          assert.equal(syncRejeitado.status, "rejeitado");
          assert.equal(searches, searchesAntesRejeitado);

          // Múltiplos resultados em /v1/payments/search -> 409
          timeoutDepois = true;
          const keyMulti = randomUUID();
          await assert.rejects(() => svc.iniciarCheckout(outro, planos[0].id, keyMulti, cartao));
          timeoutDepois = false;
          duplicarSearch = true;
          const pedidoMulti = await criar(outro, keyMulti);
          await assert.rejects(
            () => svc.sincronizar(pedidoMulti),
            (e: any) => e?.status === 409,
          );
          duplicarSearch = false;
          const recuperadoMulti = await svc.sincronizar(pedidoMulti);
          assert(recuperadoMulti.idPagamentoMp);
          const searchesAntesId = searches,
            getsAntesId = gets;
          await rpc("limitar_sincronizacao", { id: recuperadoMulti.id });
          await svc.sincronizar(await repo.obterPedido(recuperadoMulti.id));
          assert.equal(searches, searchesAntesId);
          assert.equal(gets, getsAntesId + 1);
          await assert.rejects(
            () => rpc("limitar_sincronizacao", { id: recuperadoMulti.id }),
            (e: any) => e?.code === "P0429",
          );
          const remoteMulti = recursos.get(recuperadoMulti.idPagamentoMp!)!;
          remoteMulti.status = "cancelled";
          remoteMulti.status_detail = "by_collector";
          remoteMulti.date_last_updated = new Date(Date.now() + 2000).toISOString();
          await svc.sincronizar(await repo.obterPedido(recuperadoMulti.id));
        },
      );
      await t.test(
        "Crash antes POST/lease vencida bloqueia nova cobrança inconclusiva",
        async () => {
          const key = randomUUID(),
            p = await criar(outro, key);
          await rpc("reservar_payment", { id: p.id });
          await c.admin.query(
            "update public.pedidos_pagamento set reserva_ate=now()-interval '1 minute' where id=$1",
            [p.id],
          );
          const antes = posts;
          await assert.rejects(() => svc.iniciarCheckout(outro, planos[0].id, key, cartao));
          await assert.rejects(() => criar(outro, randomUUID(), planos[1].id));
          assert.equal(posts, antes);
          // Explicit local fixture resolving an operation with no provider resource, never product code.
          await c.admin.query(
            "update public.pedidos_pagamento set estado_checkout_mp='concluido',status='cancelado' where id=$1",
            [p.id],
          );
        },
      );
      await t.test("Concorrência reserva única/Orders histórico não é convertido", async () => {
        const key = randomUUID(),
          ps = await Promise.all([criar(outro, key), criar(outro, key), criar(outro)]);
        assert.equal(new Set(ps.map((p) => p.id)).size, 1);
        const reservas = await Promise.all(ps.map((p) => rpc("reservar_payment", { id: p.id })));
        assert.equal(reservas.filter(Boolean).length, 1);
        await c.admin.query(
          "update public.pedidos_pagamento set estado_checkout_mp='concluido',status='cancelado' where id=$1",
          [ps[0]!.id],
        );
        const legado = await rpc<PedidoPagamento>("criar_pedido", {
          pessoa: outro,
          plano: planos[0].id,
          chave: randomUUID(),
          ambiente: "teste",
        });
        const antes = posts;
        const retorno = await svc.iniciarCheckout(outro, planos[0].id, randomUUID(), pix);
        assert.equal(retorno.id, legado.id);
        assert.equal(retorno.provedor, "orders");
        assert.equal(posts, antes);
      });
      await t.test("MP01:12ª reserva expirada vira falha visível e reprocessável", async () => {
        await c.admin.query(
          "insert into financeiro.webhooks(chave,recurso,provedor,ambiente,status,tentativas,reserva,reserva_ate) values('crash12','99999','payments','teste','processando',12,gen_random_uuid(),now()-interval '1 minute')",
        );
        await rpc("reservar_eventos", { limite: 1 });
        const w = (await c.admin.query("select * from financeiro.webhooks where chave='crash12'"))
          .rows[0];
        assert.equal(w.status, "falha");
        assert.equal(w.erro, "reserva_expirada_limite_tentativas");
        assert(
          (await rpc("painel", { administrador: admin })).eventosFalhos.some(
            (e: any) => e.chave === "crash12",
          ),
        );
        await rpc("reprocessar_eventos", { administrador: admin });
        assert.equal(
          (
            await c.admin.query(
              "select tentativas,status from financeiro.webhooks where chave='crash12'",
            )
          ).rows[0].tentativas,
          0,
        );
      });
      await t.test("RLS e RPC privada não permitem leituras/escritas de outro aluno", async () => {
        const conn = await c.admin.connect();
        try {
          await conn.query("begin");
          await conn.query("select set_config('request.jwt.claim.sub',$1,true)", [outro]);
          await conn.query("set local role authenticated");
          const rows = (
            await conn.query("select * from public.pedidos_pagamento where id_pessoa=$1", [aluno])
          ).rows;
          assert.equal(rows.length, 0);
          await assert.rejects(() =>
            conn.query("select public.operar_financeiro_backend('pedido','{}')"),
          );
          await conn.query("rollback");
        } finally {
          conn.release();
        }
      });
      await t.test(
        "MP05: ambiente e filtros iguais em listas/totais/alertas; aprovados sem webhook",
        async () => {
          const p = await criar(aluno);
          await rpc("vincular_payment", { id: p.id, pagamento: "888888" });
          await rpc("aplicar_payment", {
            id: p.id,
            pagamento: "888888",
            status: "aprovado",
            status_mp: "approved",
            valor: p.valor,
            moeda: "BRL",
            detalhe: "accredited",
            versao: new Date(Date.now() + 3000).toISOString(),
            metodo: "pix",
            estornado: "0.00",
            webhook: false,
          });
          const painel = await rpc("painel", {
            administrador: admin,
            pessoa: aluno,
            ambiente: "teste",
            status: "aprovado",
          });
          assert(painel.aprovadosSemWebhook.some((x: any) => x.id === p.id));
          assert(painel.pagamentos.every((x: any) => x.id_pessoa === aluno));
          assert.equal(painel.indicadores.aprovados, painel.pagamentos.length);
          const prod = await rpc("painel", { administrador: admin, ambiente: "producao" });
          assert.equal(prod.pagamentos.length, 0);
          assert.equal(prod.indicadores.bruto, "0");
          assert.equal(prod.assinaturas.length, 0);
          assert.equal(prod.ativos, 0);
          assert.equal(prod.aprovadosSemWebhook.length, 0);
        },
      );
      await t.test(
        "Reembolso/contestação confirmados suspendem somente período da compra",
        async () => {
          const p = await repo.obterPedido(primeiro.id),
            remote = recursos.get(p.idPagamentoMp!)!;
          remote.status = "refunded";
          remote.status_detail = "refunded";
          remote.transaction_amount_refunded = remote.transaction_amount;
          remote.date_last_updated = new Date(Date.now() + 5000).toISOString();
          await svc.sincronizar(p, true);
          assert.equal((await repo.obterPedido(p.id)).status, "estornado");
          assert.equal(
            (
              await c.admin.query("select status from public.assinaturas where id_pedido=$1", [
                p.id,
              ])
            ).rows[0].status,
            "cancelada",
          );
        },
      );
    } finally {
      await c.stop();
    }
  },
);
