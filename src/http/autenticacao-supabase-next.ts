import { validarSenha } from "../security/senhas.js";
import { verificarRecuperacao } from "../security/sessoes.js";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { validarDadosPessoais } from "../domain/validacao-dados-pessoais.js";
import { vincularRequisicaoAoContrato } from "../contracts/validacao-conversao-contratos-api.js";
import { obterConfiguracaoPublicaSupabase } from "../utils/supabase/config.js";
import rotas from "../contracts/rotas-publicas-api.json" with { type: "json" };
import {
  criarRespostaSucesso,
  ErroRegraNegocioHttp,
} from "../domain/erros-validacoes-respostas-api.js";

const credenciaisInvalidas = "E-mail ou senha incorretos. Confira seus dados e tente novamente.";

type Perfil = {
  idUsuario: string;
  idPessoa: string;
  nome_completo: string;
  email: string;
  tipo: string;
  estado_cadastro: string;
  cadastro_completo: boolean;
  criado_em: string;
  ultimo_acesso_em: string | null;
};

async function perfilUsuario(supabase: SupabaseClient, usuario: User) {
  const { data, error } = await supabase
    .from("usuarios")
    .select(
      "idUsuario,idPessoa,nome_completo,email,tipo,estado_cadastro,cadastro_completo,criado_em,ultimo_acesso_em",
    )
    .eq("idUsuario", usuario.id)
    .single<Perfil>();

  if (error?.code === "42501") {
    throw new ErroRegraNegocioHttp(
      "O acesso aos dados da conta está temporariamente indisponível.",
      503,
    );
  }

  if (error || !data) {
    throw new ErroRegraNegocioHttp(
      "Sua conta não está disponível. Entre em contato com o suporte.",
      403,
    );
  }

  return {
    idUsuario: data.idUsuario,
    idPessoa: data.idPessoa,
    nomeCompleto: data.nome_completo,
    email: data.email,
    tipo: data.tipo,
    estadoCadastro: data.estado_cadastro,
    cadastroCompleto: data.cadastro_completo,
    dataHoraCadastro: data.criado_em,
    dataHoraUltimoAcesso: data.ultimo_acesso_em,
  };
}

export function correspondeRotaAutenticacaoSupabase(metodo: string, caminho: string) {
  return (
    (rotas.some((rota) => rota.path === caminho && rota.method === metodo) &&
      (caminho.startsWith("/api/Navegador/") || caminho.startsWith("/api/Autenticacao/"))) ||
    (metodo === "GET" && caminho === "/api/Usuario/obter-meu-usuario")
  );
}

export async function atenderAutenticacaoSupabaseNext(
  metodo: string,
  caminho: string,
  supabase: SupabaseClient,
  lerCorpo: () => Promise<unknown>,
  origemFrontend?: string,
  opcoes: {
    criarAdmin?: () => SupabaseClient;
    enviarEmailAutenticacao?: (dados: {
      tipoEvento: "EMAIL_VERIFICATION" | "PASSWORD_RESET";
      idUsuario: string | null;
      emailDestinatario: string;
      nome?: string;
      link: string;
    }) => Promise<unknown>;
    enviarBoasVindas?: () => Promise<unknown>;
    bearerToken?: string;
    revogarBearer?: (token: string) => Promise<void>;
    reautenticar?: (email: string, senha: string, id: string) => Promise<void>;
  } = {},
) {
  const acao = caminho.split("/").at(-1)!;
  const mensagem = (texto: string) => criarRespostaSucesso({ mensagem: texto }, texto);
  const corpo = async () => {
    const valor = await lerCorpo();
    if (!valor || typeof valor !== "object" || Array.isArray(valor))
      throw new ErroRegraNegocioHttp("Envie um objeto JSON válido.");
    return valor as Record<string, unknown>;
  };
  const senhaValida = validarSenha;
  const emailValido = (valor: unknown) => {
    if (
      typeof valor !== "string" ||
      valor.length > 254 ||
      !/^\S+@[^\s@]+\.[^\s@]+$/.test(valor.trim())
    )
      throw new ErroRegraNegocioHttp("Informe um e-mail válido.");
    return valor.trim().toLowerCase();
  };
  const retorno = (rota: string) => {
    if (!origemFrontend)
      throw new ErroRegraNegocioHttp("Configure a origem do frontend no servidor.", 503);
    return origemFrontend.replace(/\/$/, "") + rota;
  };
  if (acao === "obter-configuracao-acesso") {
    const { url, chave } = obterConfiguracaoPublicaSupabase();
    const r = await fetch(url + "/auth/v1/settings", {
      headers: { apikey: chave },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok)
      throw new ErroRegraNegocioHttp("Não foi possível consultar as opções de acesso.", 503);
    const dados = (await r.json()) as { external?: { google?: boolean; email?: boolean } };
    return criarRespostaSucesso(
      { googleDisponivel: !!dados.external?.google, envioEmailDisponivel: !!dados.external?.email },
      "Opções de acesso consultadas.",
    );
  }
  if (acao === "cadastrar-estudante") {
    const dados = vincularRequisicaoAoContrato(
      "CadastrarEstudanteRequestModel",
      await corpo(),
      false,
    );
    const pessoa = validarDadosPessoais(dados.pessoa);
    const email = emailValido(dados.email);
    const senha = senhaValida(dados.senha);
    if (opcoes.criarAdmin && opcoes.enviarEmailAutenticacao) {
      const resultado = await opcoes.criarAdmin().auth.admin.generateLink({
        type: "signup",
        email,
        password: senha,
        options: { data: { pessoa }, redirectTo: retorno("/autenticacao/confirmar-email") },
      });
      if (resultado.error)
        throw new ErroRegraNegocioHttp(
          ["user_already_exists", "email_exists"].includes(resultado.error.code ?? "")
            ? "Confira seu e-mail para continuar."
            : "Não foi possível concluir o cadastro. Confira seus dados e tente novamente.",
          resultado.error.status === 429 ? 429 : 400,
        );
      const token = resultado.data.properties?.hashed_token;
      if (!token)
        throw new ErroRegraNegocioHttp(
          "O envio de e-mails está temporariamente indisponível.",
          503,
        );
      await opcoes.enviarEmailAutenticacao({
        tipoEvento: "EMAIL_VERIFICATION",
        idUsuario: resultado.data.user?.id ?? null,
        emailDestinatario: email,
        nome: pessoa.nome_completo,
        link: `${retorno("/autenticacao/confirmar-email")}?token_hash=${encodeURIComponent(token)}&type=email`,
      });
      return criarRespostaSucesso(
        { idUsuario: resultado.data.user?.id ?? randomUUID(), confirmacaoEmailNecessaria: true },
        "Cadastro recebido. Confira seu e-mail para continuar.",
      );
    }
    const resultado = await supabase.auth.signUp({
      email: emailValido(dados.email),
      password: senhaValida(dados.senha),
      options: { data: { pessoa }, emailRedirectTo: retorno("/autenticacao/confirmar-email") },
    });
    if (resultado.error)
      throw new ErroRegraNegocioHttp(
        resultado.error.code === "user_already_exists"
          ? "Confira seu e-mail para continuar."
          : "Não foi possível concluir o cadastro. Confira seus dados e tente novamente.",
        resultado.error.status === 429 ? 429 : 400,
      );
    return criarRespostaSucesso(
      {
        idUsuario: resultado.data.user?.id ?? randomUUID(),
        confirmacaoEmailNecessaria: !resultado.data.session,
      },
      "Cadastro recebido. Confira seu e-mail para continuar.",
    );
  }
  if (acao === "solicitar-recuperacao-senha" || acao === "reenviar-confirmacao") {
    const email = emailValido((await corpo()).email);
    const respostaNeutra = () =>
      mensagem("Se houver uma conta para este e-mail, você receberá as instruções para continuar.");
    if (opcoes.criarAdmin && opcoes.enviarEmailAutenticacao) {
      const admin = opcoes.criarAdmin();
      const recuperacao = acao === "solicitar-recuperacao-senha";
      let nome: string | undefined;
      let protegido = recuperacao;
      if (!recuperacao) {
        const perfil = await admin
          .from("usuarios")
          .select("nome_completo,estado_cadastro")
          .eq("email", email)
          .maybeSingle();
        if (perfil.error)
          throw new ErroRegraNegocioHttp(
            "O envio de e-mails está temporariamente indisponível.",
            503,
          );
        if (!perfil.data || perfil.data.estado_cadastro !== "verificacao_pendente")
          return respostaNeutra();
        nome = perfil.data.nome_completo;
        const protecao = await admin.rpc("preservar_senha_usuario_auth_backend");
        protegido = !protecao.error && protecao.data === true;
      }
      if (protegido) {
        const rota = recuperacao
          ? "/autenticacao/redefinir-senha"
          : "/autenticacao/confirmar-email";
        const resultado = await admin.auth.admin.generateLink({
          type: recuperacao ? "recovery" : "magiclink",
          email,
          options: { redirectTo: retorno(rota) },
        });
        if (resultado.error) {
          if (resultado.error.status === 429)
            throw new ErroRegraNegocioHttp(
              "Aguarde um momento antes de solicitar outro e-mail.",
              429,
            );
          if ((resultado.error.status ?? 0) >= 500)
            throw new ErroRegraNegocioHttp(
              "O envio de e-mails está temporariamente indisponível.",
              503,
            );
          return respostaNeutra();
        }
        const token = resultado.data.properties?.hashed_token;
        if (!token)
          throw new ErroRegraNegocioHttp(
            "O envio de e-mails está temporariamente indisponível.",
            503,
          );
        if (recuperacao && resultado.data.user?.id) {
          try {
            const perfil = await admin
              .from("usuarios")
              .select("nome_completo")
              .eq("idUsuario", resultado.data.user.id)
              .maybeSingle();
            nome = perfil.data?.nome_completo;
          } catch {
            /* Nome é opcional. */
          }
        }
        await opcoes.enviarEmailAutenticacao({
          tipoEvento: recuperacao ? "PASSWORD_RESET" : "EMAIL_VERIFICATION",
          idUsuario: resultado.data.user?.id ?? null,
          emailDestinatario: email,
          nome,
          link: `${retorno(rota)}?token_hash=${encodeURIComponent(token)}&type=${recuperacao ? "recovery" : "email"}`,
        });
        return respostaNeutra();
      }
      // Sem a migration de proteção, reenvio permanece no Auth e não gera magiclink.
    }
    const r =
      acao === "solicitar-recuperacao-senha"
        ? await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: retorno("/autenticacao/redefinir-senha"),
          })
        : await supabase.auth.resend({
            type: "signup",
            email,
            options: { emailRedirectTo: retorno("/autenticacao/confirmar-email") },
          });
    if (r.error && r.error.status === 429)
      throw new ErroRegraNegocioHttp("Aguarde um momento antes de solicitar outro e-mail.", 429);
    if (r.error && (r.error.status ?? 0) >= 500)
      throw new ErroRegraNegocioHttp("O envio de e-mails está temporariamente indisponível.", 503);
    return mensagem(
      "Se houver uma conta para este e-mail, você receberá as instruções para continuar.",
    );
  }
  if (acao === "confirmar-email") {
    const token = (await corpo()).token;
    if (typeof token !== "string" || token.length > 2000)
      throw new ErroRegraNegocioHttp("Link inválido ou expirado.");
    const [tipo, ...partes] = token.split(":");
    const valor = partes.join(":");
    let resultado =
      tipo === "codigo"
        ? await supabase.auth.exchangeCodeForSession(valor)
        : await supabase.auth.verifyOtp({
            token_hash: valor || token,
            type: tipo === "recovery" ? "recovery" : "email",
          });
    if (resultado.error && tipo !== "codigo" && tipo !== "recovery") {
      for (const subtipo of ["signup", "magiclink"] as const) {
        resultado = await supabase.auth.verifyOtp({ token_hash: valor || token, type: subtipo });
        if (!resultado.error) break;
      }
    }
    if (resultado.error)
      throw new ErroRegraNegocioHttp(
        "O link expirou ou já foi utilizado. Solicite um novo e-mail.",
      );
    if (tipo !== "recovery" && opcoes.enviarBoasVindas) {
      try {
        await opcoes.enviarBoasVindas();
      } catch {
        /* A fila preserva a retentativa. */
      }
    }
    return mensagem("E-mail validado. Continue para acessar sua conta.");
  }
  if (acao === "iniciar-google" || acao === "iniciar-vinculo-google") {
    const options = { redirectTo: retorno("/autenticacao/google"), skipBrowserRedirect: true };
    const resultado =
      acao === "iniciar-google"
        ? await supabase.auth.signInWithOAuth({ provider: "google", options })
        : await supabase.auth.linkIdentity({ provider: "google", options });
    if (resultado.error || !resultado.data.url)
      throw new ErroRegraNegocioHttp("O acesso com Google está temporariamente indisponível.", 503);
    return criarRespostaSucesso({ url: resultado.data.url }, "Continue no Google.");
  }
  if (acao === "concluir-google") {
    const codigo = (await corpo()).codigo;
    if (typeof codigo !== "string" || !codigo || codigo.length > 2000)
      throw new ErroRegraNegocioHttp("A confirmação do Google expirou. Inicie novamente.");
    const r = await supabase.auth.exchangeCodeForSession(codigo);
    if (r.error || !r.data.user || !r.data.session)
      throw new ErroRegraNegocioHttp("Não foi possível confirmar o acesso com Google.", 401);
    return criarRespostaSucesso(
      { usuario: await perfilUsuario(supabase, r.data.user), expiresIn: r.data.session.expires_in },
      "Acesso realizado.",
    );
  }
  if (acao === "entrar-estudante" || acao === "entrar-administrador") {
    if (opcoes.bearerToken)
      throw new ErroRegraNegocioHttp("O login usa cookies HttpOnly, sem Bearer.", 400);
    const dados = await lerCorpo();
    if (!dados || typeof dados !== "object" || Array.isArray(dados)) {
      throw new ErroRegraNegocioHttp(credenciaisInvalidas, 401);
    }
    const { email, senha } = dados as Record<string, unknown>;
    if (typeof email !== "string" || typeof senha !== "string" || !email.trim() || !senha) {
      throw new ErroRegraNegocioHttp(credenciaisInvalidas, 401);
    }

    const resultado = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password: senha,
    });
    if (resultado.error || !resultado.data.user || !resultado.data.session) {
      throw new ErroRegraNegocioHttp(credenciaisInvalidas, 401);
    }
    let usuario: Awaited<ReturnType<typeof perfilUsuario>>;
    try {
      usuario = await perfilUsuario(supabase, resultado.data.user);
    } catch (erro) {
      await supabase.auth.signOut();
      if (erro instanceof ErroRegraNegocioHttp && erro.status === 503) throw erro;
      throw new ErroRegraNegocioHttp(credenciaisInvalidas, 401);
    }
    const tipoExigido = caminho.endsWith("entrar-administrador") ? "administrador" : "estudante";
    if (
      usuario.tipo !== tipoExigido ||
      usuario.estadoCadastro !== "ativo" ||
      !usuario.cadastroCompleto
    ) {
      await supabase.auth.signOut();
      throw new ErroRegraNegocioHttp(credenciaisInvalidas, 401);
    }
    return criarRespostaSucesso(
      {
        usuario,
        expiresIn: resultado.data.session.expires_in,
      },
      "Acesso realizado.",
    );
  }

  if (metodo === "POST" && acao === "sair-sessao") {
    const user = await supabase.auth.getUser();
    if (user.error || !user.data.user) throw new ErroRegraNegocioHttp("Sessão inválida.", 401);
    if (opcoes.bearerToken) {
      if (!opcoes.revogarBearer) throw new ErroRegraNegocioHttp("Revogação indisponível.", 503);
      await opcoes.revogarBearer(opcoes.bearerToken);
    } else {
      const resultado = await supabase.auth.signOut({ scope: "global" });
      if (resultado.error)
        throw new ErroRegraNegocioHttp("Não foi possível encerrar a sessão.", 503);
    }
    return mensagem("Sessão encerrada.");
  }

  if (acao === "renovar-sessao") {
    if (opcoes.bearerToken)
      throw new ErroRegraNegocioHttp("Renove a sessão usando cookies HttpOnly.", 400);
    const atual = await supabase.auth.getUser();
    if (atual.error || !atual.data.user)
      throw new ErroRegraNegocioHttp("Sua sessão expirou. Entre novamente.", 401);
    const r = await supabase.auth.refreshSession();
    if (r.error || !r.data.user || !r.data.session)
      throw new ErroRegraNegocioHttp("Sua sessão expirou. Entre novamente.", 401);
    let usuario;
    try {
      usuario = await perfilUsuario(supabase, r.data.user);
    } catch {
      const encerrada = await supabase.auth.signOut({ scope: "global" });
      if (encerrada.error)
        throw new ErroRegraNegocioHttp("Não foi possível revogar a sessão.", 503);
      throw new ErroRegraNegocioHttp("Conta indisponível.", 403);
    }
    if (usuario.estadoCadastro !== "ativo") {
      const encerrada = await supabase.auth.signOut({ scope: "global" });
      if (encerrada.error)
        throw new ErroRegraNegocioHttp("Não foi possível revogar a sessão.", 503);
      throw new ErroRegraNegocioHttp("Conta indisponível.", 403);
    }
    return criarRespostaSucesso(
      { usuario, expiresIn: r.data.session.expires_in },
      "Sessão renovada.",
    );
  }

  const autenticado = await supabase.auth.getUser();
  if (autenticado.error || !autenticado.data.user) {
    throw new ErroRegraNegocioHttp("Entre na sua conta para continuar.", 401);
  }
  const usuario = await perfilUsuario(supabase, autenticado.data.user);

  if (acao === "obter-vinculo-google")
    return criarRespostaSucesso(
      {
        vinculado: autenticado.data.user.identities?.some((x) => x.provider === "google") ?? false,
      },
      "Vínculo consultado.",
    );
  if (acao === "redefinir-senha" || acao === "atualizar-senha") {
    if (opcoes.bearerToken)
      throw new ErroRegraNegocioHttp("Use uma sessão por cookies para alterar a senha.", 400);
    const dados = await corpo();
    const recovery = await verificarRecuperacao(supabase);
    if (acao === "redefinir-senha" && !recovery)
      throw new ErroRegraNegocioHttp("Use um link de recuperação válido.", 403);
    if (acao === "atualizar-senha") {
      if (recovery) throw new ErroRegraNegocioHttp("Use a redefinição de senha.", 403);
      if (typeof dados.senhaAtual !== "string" || !dados.senhaAtual || !autenticado.data.user.email)
        throw new ErroRegraNegocioHttp("Informe sua senha atual ou use a recuperação.");
      if (!opcoes.reautenticar) throw new ErroRegraNegocioHttp("Reautenticação indisponível.", 503);
      await opcoes.reautenticar(
        autenticado.data.user.email,
        dados.senhaAtual,
        autenticado.data.user.id,
      );
    }
    const r = await supabase.auth.updateUser({ password: senhaValida(dados.senha) });
    if (r.error) throw new ErroRegraNegocioHttp("Não foi possível alterar a senha.", 400);
    const encerrada = await supabase.auth.signOut({ scope: "global" });
    if (encerrada.error)
      throw new ErroRegraNegocioHttp(
        "Senha alterada, mas a revogação falhou. Entre em contato com o suporte.",
        503,
      );
    return mensagem("Senha alterada. Entre com sua nova senha.");
  }

  if (metodo === "GET") {
    return criarRespostaSucesso(usuario, "Perfil consultado.");
  }

  const sessao = await supabase.auth.getSession();
  return criarRespostaSucesso(
    {
      usuario,
      expiresIn: Math.max(
        0,
        (sessao.data.session?.expires_at ?? 0) - Math.floor(Date.now() / 1000),
      ),
    },
    "Sessão renovada.",
  );
}
