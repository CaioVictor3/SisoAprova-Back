import type { SupabaseClient } from "@supabase/supabase-js";
import { ErroRegraNegocioHttp } from "../domain/erros-validacoes-respostas-api.js";

export function possuiAmrRecuperacao(amr: unknown): boolean {
  return (
    Array.isArray(amr) &&
    amr.some(
      (item) =>
        item === "recovery" ||
        (typeof item === "object" && item !== null && item.method === "recovery"),
    )
  );
}

// getClaims verifica assinatura/expiração; nunca usar user_metadata para autorização.
export async function verificarRecuperacao(cliente: SupabaseClient, token?: string) {
  if (!token) {
    const sessao = await cliente.auth.getSession();
    if (sessao.error) throw new ErroRegraNegocioHttp("Sessão inválida.", 401);
    token = sessao.data.session?.access_token;
  }
  if (!token) return false;
  const resultado = await cliente.auth.getClaims(token);
  if (resultado.error || !resultado.data?.claims)
    throw new ErroRegraNegocioHttp("Sessão inválida.", 401);
  const amr: unknown = resultado.data.claims.amr;
  if (
    amr !== undefined &&
    (!Array.isArray(amr) ||
      amr.some(
        (item) =>
          typeof item !== "string" &&
          (typeof item !== "object" || item === null || typeof item.method !== "string"),
      ))
  )
    throw new ErroRegraNegocioHttp("Sessão inválida.", 401);
  return possuiAmrRecuperacao(amr);
}

export async function restringirRecuperacao(
  cliente: SupabaseClient,
  caminho: string,
  token?: string,
) {
  const recovery = await verificarRecuperacao(cliente, token);
  if (
    recovery &&
    !/^\/api\/(?:Navegador|Autenticacao)\/(?:redefinir-senha|sair-sessao)$/.test(caminho)
  )
    throw new ErroRegraNegocioHttp(
      "Conclua a redefinição de senha para continuar.",
      403,
      "RECOVERY_ONLY",
    );
  return recovery;
}
