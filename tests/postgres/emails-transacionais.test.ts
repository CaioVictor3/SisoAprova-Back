import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { cluster } from "./cluster-postgresql-descartavel.js";
import { carregarConfiguracoesAmbiente } from "../../src/config/configuracoes-ambiente.js";
import { ConexaoTransacoesPostgreSql } from "../../src/infrastructure/conexao-transacoes-postgresql.js";
import { ServicoEnvioEmailsTransacionaisResend } from "../../src/infrastructure/envio-emails-transacionais-resend.js";
import { PersistenciaWorkerEmailsSupabase } from "../../src/infrastructure/persistencia-worker-emails-supabase.js";

const logger = pino({ level: "silent" });

test("PostgreSQL real: servidor de e-mails Resend (WELCOME_EMAIL no Auth, 5 fluxos em operar_api, USER_INACTIVE Siso Aprova, SUBSCRIPTION_EXPIRING com nome e worker Data API)", async () => {
  const pg = await cluster();
  try {
    // 1. Seed dos 5 workflows em comunicacao.workflows
    const workflowsSeed = await pg.admin.query(
      "select tipo_evento, habilitado from comunicacao.workflows order by tipo_evento",
    );
    assert.equal(workflowsSeed.rowCount, 5);
    const mapaSeed = Object.fromEntries(
      workflowsSeed.rows.map((r) => [r.tipo_evento, r.habilitado]),
    );
    assert.deepEqual(mapaSeed, {
      EMAIL_VERIFICATION: true,
      PASSWORD_RESET: true,
      SUBSCRIPTION_EXPIRING: true,
      USER_INACTIVE: false,
      WELCOME_EMAIL: true,
    });

    // 2. Trigger identidade.sincronizar_usuario_supabase_auth() em INSERT e UPDATE
    const idEstudante = randomUUID();
    await pg.admin.query(
      `insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
       values($1,'mariana@example.test',null,$2::jsonb)`,
      [idEstudante, JSON.stringify({ full_name: "Mariana Costa" })],
    );
    const antesConfirmar = await pg.admin.query(
      `select count(*)::int as total from comunicacao.emails_transacionais where "idUsuario"=$1 and tipo_evento='WELCOME_EMAIL'`,
      [idEstudante],
    );
    assert.equal(antesConfirmar.rows[0].total, 0);

    await pg.admin.query(`update auth.users set email_confirmed_at=now() where id=$1`, [
      idEstudante,
    ]);
    // Segundo update não duplica por chave_idempotencia
    await pg.admin.query(
      `update auth.users set email_confirmed_at=now() + interval '1 minute' where id=$1`,
      [idEstudante],
    );

    const welcomeRows = await pg.admin.query(
      `select tipo_evento,email_destinatario,assunto,dados_template,maximo_tentativas,chave_idempotencia,status
       from comunicacao.emails_transacionais where "idUsuario"=$1 and tipo_evento='WELCOME_EMAIL'`,
      [idEstudante],
    );
    assert.equal(welcomeRows.rowCount, 1);
    assert.equal(welcomeRows.rows[0].assunto, "Boas-vindas ao Siso Aprova");
    assert.equal(welcomeRows.rows[0].dados_template.nome, "Mariana Costa");
    assert.equal(welcomeRows.rows[0].maximo_tentativas, 5);
    assert.equal(welcomeRows.rows[0].chave_idempotencia, `WELCOME_EMAIL/${idEstudante}`);
    assert.equal(welcomeRows.rows[0].status, "pendente");

    // 3. comunicacao.operar_api (public.operar_comunicacao): 5 fluxos, salvar_fluxo e reprocessar SUBSCRIPTION_EXPIRING
    const idAdmin = randomUUID();
    await pg.admin.query(
      `insert into public.pessoas("idPessoa",nome_completo) values($1,'Admin')`,
      [idAdmin],
    );
    await pg.admin.query(
      `insert into public.usuarios("idUsuario","idPessoa",nome_completo,email,tipo,estado_cadastro,cadastro_completo)
       values($1,$1,'Admin','admin@example.test','administrador','ativo',true)`,
      [idAdmin],
    );

    const clientAdmin = await pg.admin.connect();
    try {
      await clientAdmin.query("BEGIN");
      await clientAdmin.query(
        "select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",
        [idAdmin, JSON.stringify({ sub: idAdmin, role: "authenticated" })],
      );
      const fluxosRes = await clientAdmin.query(
        "select public.operar_comunicacao('fluxos','{}'::jsonb) as dados",
      );
      const fluxos = fluxosRes.rows[0].dados as Array<{ tipoEvento: string; habilitado: boolean }>;
      assert.deepEqual(
        fluxos.map((f) => f.tipoEvento),
        [
          "EMAIL_VERIFICATION",
          "WELCOME_EMAIL",
          "PASSWORD_RESET",
          "USER_INACTIVE",
          "SUBSCRIPTION_EXPIRING",
        ],
      );

      // Habilitar USER_INACTIVE e salvar SUBSCRIPTION_EXPIRING via operar_comunicacao
      await clientAdmin.query(
        `select public.operar_comunicacao('salvar_fluxo','{"tipo":"USER_INACTIVE","habilitado":true}'::jsonb)`,
      );
      const salvarSub = await clientAdmin.query(
        `select public.operar_comunicacao('salvar_fluxo','{"tipo":"SUBSCRIPTION_EXPIRING","habilitado":true}'::jsonb) as dados`,
      );
      assert.equal(salvarSub.rows[0].dados.tipoEvento, "SUBSCRIPTION_EXPIRING");
      assert.equal(salvarSub.rows[0].dados.habilitado, true);
      await clientAdmin.query("COMMIT");
    } finally {
      clientAdmin.release();
    }

    // 4. Manutenção financeira gera SUBSCRIPTION_EXPIRING com nome_completo (não email)
    const idPlano = (
      await pg.admin.query(
        "select id from public.planos_comerciais where ativo order by ordem limit 1",
      )
    ).rows[0].id as string;
    const idPedido = randomUUID();
    const idAssinatura = randomUUID();
    await pg.admin.query(
      `insert into public.pedidos_pagamento(id,id_pessoa,id_plano,plano_nome,duracao_meses,beneficios,valor,moeda,ambiente,status,chave_idempotencia,referencia_externa,provedor,webhook_confirmado)
       values($1,$2,$3,'Plano Mensal',1,'[]'::jsonb,49.90,'BRL','teste','aprovado',$4,$5,'payments',true)`,
      [idPedido, idEstudante, idPlano, randomUUID(), randomUUID()],
    );
    await pg.admin.query(
      `insert into public.assinaturas(id,id_pessoa,id_pedido,id_plano,plano_nome,valor,duracao_meses,beneficios,status,inicio_em,fim_em)
       values($1,$2,$3,$4,'Plano Mensal',49.90,1,'[]'::jsonb,'ativa',now() - interval '27 days',now() + interval '3 days')`,
      [idAssinatura, idEstudante, idPedido, idPlano],
    );

    await pg.admin.query(`select financeiro.operar_backend('manutencao','{}'::jsonb)`);

    const subEmailRow = await pg.admin.query(
      `select "idEmailTransacional",assunto,dados_template from comunicacao.emails_transacionais
       where "idUsuario"=$1 and tipo_evento='SUBSCRIPTION_EXPIRING'`,
      [idEstudante],
    );
    assert.equal(subEmailRow.rowCount, 1);
    assert.equal(subEmailRow.rows[0].assunto, "Sua assinatura Siso Aprova");
    assert.equal(subEmailRow.rows[0].dados_template.nome, "Mariana Costa");

    // 5. Reprocessar SUBSCRIPTION_EXPIRING falho via operar_api e operar_worker
    const idEmailSub = subEmailRow.rows[0].idEmailTransacional as string;
    await pg.admin.query(
      `update comunicacao.emails_transacionais set status='falha',mensagem_erro='resend_http_422',id_mensagem_provedor=null where "idEmailTransacional"=$1`,
      [idEmailSub],
    );
    const reprocessadoWorker = await pg.admin.query(
      `select public.operar_worker_email('reprocessarEmailFalho',jsonb_build_object('id',$1::text)) as res`,
      [idEmailSub],
    );
    assert.equal(reprocessadoWorker.rows[0].res.rowCount, 1);

    await pg.admin.query(
      `update comunicacao.emails_transacionais set status='falha',mensagem_erro='resend_http_403',id_mensagem_provedor=null where "idEmailTransacional"=$1`,
      [idEmailSub],
    );
    const clientAdmin2 = await pg.admin.connect();
    try {
      await clientAdmin2.query("BEGIN");
      await clientAdmin2.query(
        "select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claims',$2,true)",
        [idAdmin, JSON.stringify({ sub: idAdmin, role: "authenticated" })],
      );
      const repApi = await clientAdmin2.query(
        `select public.operar_comunicacao('reprocessar',jsonb_build_object('id',$1::text)) as ok`,
        [idEmailSub],
      );
      assert.equal(repApi.rows[0].ok, true);
      await clientAdmin2.query("COMMIT");
    } finally {
      clientAdmin2.release();
    }

    // 6. Configurar inatividade para o estudante e executar ciclo completo do worker via PersistenciaWorkerEmailsSupabase
    await pg.admin.query(
      `insert into comunicacao.preferencias("idUsuario",receber_inatividade) values($1,true)`,
      [idEstudante],
    );
    await pg.admin.query(
      `update public.usuarios set ultimo_acesso_em = now() - interval '10 days' where "idUsuario"=$1`,
      [idEstudante],
    );

    const clienteSupabaseRpc = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        if (fn === "operar_worker_email") {
          const r = await pg.admin.query(
            "select public.operar_worker_email($1,$2::jsonb) as data",
            [args.p_operacao, JSON.stringify(args.p_dados ?? {})],
          );
          return { data: r.rows[0].data, error: null };
        }
        if (fn === "registrar_evento_resend_backend") {
          await pg.admin.query("select public.registrar_evento_resend_backend($1,$2,$3)", [
            args.p_webhook,
            args.p_idmensagem,
            args.p_evento,
          ]);
          return { data: null, error: null };
        }
        throw new Error("RPC inesperado: " + fn);
      },
    };

    const persistencia = new PersistenciaWorkerEmailsSupabase(clienteSupabaseRpc as any);
    const ambiente = carregarConfiguracoesAmbiente(
      {
        NODE_ENV: "production",
        FRONTEND_APPLICATION_URL: "https://app.example.test",
        BACKEND_CORS_ALLOWED_ORIGINS: "https://app.example.test",
        RESEND_API_KEY: "re_live_fixture",
        RESEND_SENDER_EMAIL_ADDRESS: "nao-responda@sisoaprova.com.br",
        RESEND_SENDER_DISPLAY_NAME: "Siso Aprova",
        TRANSACTIONAL_EMAIL_WORKER_ENABLED: "true",
      },
      { supabase: true },
    );

    const enviadosResend: Array<{ subject: string; to: string[]; text: string }> = [];
    let contadorMsg = 0;
    const servico = new ServicoEnvioEmailsTransacionaisResend(
      new ConexaoTransacoesPostgreSql(ambiente),
      ambiente,
      async (_url, init) => {
        contadorMsg += 1;
        const body = JSON.parse(String(init?.body));
        enviadosResend.push({ subject: body.subject, to: body.to, text: body.text });
        return Response.json({ id: `re_msg_${contadorMsg}` });
      },
      persistencia,
    );

    const resumo = await servico.executarCicloWorker(logger, new AbortController().signal, true);
    assert.equal(resumo.manutencaoExecutada, true);
    assert.equal(resumo.reservados, 3);
    assert.equal(resumo.aceitos, 3);
    assert.equal(resumo.falhas, 0);

    const assuntosEnviados = enviadosResend.map((e) => e.subject).sort();
    assert.deepEqual(assuntosEnviados, [
      "Boas-vindas ao Siso Aprova",
      "Continue seus estudos — Siso Aprova",
      "Sua assinatura Siso Aprova",
    ]);
    for (const item of enviadosResend) {
      assert(item.text.startsWith("Olá, Mariana Costa!\n\n"));
    }

    // 7. Webhook de entrega atualiza status para 'entregue'
    await servico.registrarEventoWebhook("svix_evt_1", "re_msg_1", "email.delivered");
    const entregueRow = await pg.admin.query(
      `select status, entregue_em is not null as possui_data from comunicacao.emails_transacionais where id_mensagem_provedor='re_msg_1'`,
    );
    assert.equal(entregueRow.rows[0].status, "entregue");
    assert.equal(entregueRow.rows[0].possui_data, true);
  } finally {
    await pg.stop();
  }
});
