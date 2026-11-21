import { ErroRegraNegocioHttp } from "../domain/erros-validacoes-respostas-api.js";
export function validarUrlImagem(valor: string | null | undefined) {
  if (valor == null || valor === "") return;
  let url: URL;
  try {
    url = new URL(valor);
  } catch {
    throw new ErroRegraNegocioHttp("Informe uma URL HTTPS válida para a imagem.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new ErroRegraNegocioHttp("Use uma URL HTTPS sem credenciais para a imagem.");
}
