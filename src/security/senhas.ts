import { ErroRegraNegocioHttp } from "../domain/erros-validacoes-respostas-api.js";
export function validarSenha(valor: unknown): string {
  if (typeof valor !== "string" || valor.length < 8 || valor.length > 128 || valor !== valor.trim())
    throw new ErroRegraNegocioHttp("Use uma senha de 8 a 128 caracteres, sem espaços nas pontas.");
  return valor;
}
