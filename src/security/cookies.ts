export type CookiePendente = { nome: string; valor: string; opcoes: Record<string, unknown> };
// Uma falha nunca publica credencial recém-emitida. A limpeza segura é preservada
// ou criada para o mesmo nome/path, inclusive se a revogação do provedor falhou.
export function cookiesParaResposta(cookies: CookiePendente[], status: number): CookiePendente[] {
  if (status < 400) return cookies;
  return cookies.map((cookie) => ({
    ...cookie,
    valor: "",
    opcoes: { ...cookie.opcoes, maxAge: 0, expires: new Date(0) },
  }));
}
