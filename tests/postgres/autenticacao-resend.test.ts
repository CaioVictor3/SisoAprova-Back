import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cluster } from "./cluster-postgresql-descartavel.js";

test("Postgres: proteção senha, registro Resend idempotente, webhook antecipado e privilégios", async () => {
  const pg = await cluster();
  try {
    const id = randomUUID();
    await pg.admin.query(
      "insert into auth.users(id,email,encrypted_password) values($1,'fixture@example.test','hash-simulado')",
      [id],
    );
    await pg.admin.query("update auth.users set encrypted_password='' where id=$1", [id]);
    assert.equal(
      (await pg.admin.query("select encrypted_password from auth.users where id=$1", [id])).rows[0]
        .encrypted_password,
      "hash-simulado",
    );
    await pg.admin.query("update auth.users set encrypted_password='outro-hash' where id=$1", [id]);
    assert.equal(
      (await pg.admin.query("select encrypted_password from auth.users where id=$1", [id])).rows[0]
        .encrypted_password,
      "outro-hash",
    );
    assert.equal(
      (await pg.admin.query("select public.preservar_senha_usuario_auth_backend() as ok")).rows[0]
        .ok,
      true,
    );
    for (const tipo of ["EMAIL_VERIFICATION", "PASSWORD_RESET"]) {
      const provedor = randomUUID();
      const chave = randomUUID();
      await pg.admin.query("select comunicacao.operar_worker('registrarEventoProvedorEmail',$1)", [
        JSON.stringify({ webhook: randomUUID(), id: provedor, evento: "email.delivered" }),
      ]);
      const dados = {
        id: randomUUID(),
        tipo,
        usuario: id,
        email: "fixture@example.test",
        nome: "Pessoa",
        assunto: "Fixture",
        chave,
        provedor,
      };
      for (let i = 0; i < 2; i++)
        await pg.admin.query(
          "select public.operar_worker_email('registrarEmailAutenticacaoEnviado',$1)",
          [JSON.stringify(dados)],
        );
      const rows = await pg.admin.query(
        "select status,link_protegido,enviado_em,entregue_em from comunicacao.emails_transacionais where chave_idempotencia=$1",
        [chave],
      );
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].status, "entregue");
      assert.equal(rows.rows[0].link_protegido, null);
      assert(rows.rows[0].enviado_em);
      assert(rows.rows[0].entregue_em);
    }
    for (const role of ["anon", "authenticated"]) {
      assert.equal(
        (
          await pg.admin.query(
            "select has_function_privilege($1,'public.preservar_senha_usuario_auth_backend()','execute') as ok",
            [role],
          )
        ).rows[0].ok,
        false,
      );
    }
  } finally {
    await pg.stop();
  }
});
