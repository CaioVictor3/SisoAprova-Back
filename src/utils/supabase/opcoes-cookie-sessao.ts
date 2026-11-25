import type { CookieOptionsWithName } from "@supabase/ssr";

const nomeSessaoProducao = "__Host-sisoaprova-auth-token";
const nomeSessaoProducaoLegado = "__Host-concursaai-auth-token";

export function opcoesCookieSessaoSupabase(requisicao?: Request): CookieOptionsWithName {
  const httpLocal = (valor?: string | null) => {
    try {
      const url = new URL(valor ?? "");
      return (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(url.hostname.toLowerCase())
      );
    } catch {
      return false;
    }
  };
  const contextoLocal =
    httpLocal(process.env.FRONTEND_APPLICATION_URL) ||
    (httpLocal(requisicao?.url) &&
      (!requisicao?.headers.has("x-forwarded-proto") ||
        requisicao.headers.get("x-forwarded-proto")?.trim().toLowerCase() === "http"));
  const producao = process.env.NODE_ENV === "production" && !contextoLocal;
  return {
    httpOnly: true,
    path: "/",
    secure: producao,
    sameSite: producao ? "none" : "lax",
    // Em HTTPS, a sessão fica vinculada ao site da interface que chamou a API.
    ...(producao ? { name: nomeSessaoProducao, partitioned: true } : {}),
  };
}

export function temCookieSessaoSupabase(cabecalho: string | null): boolean {
  return (cabecalho ?? "").split(";").some((cookie) => {
    const [nome = ""] = cookie.trim().split("=", 1);
    return (
      nome === nomeSessaoProducao ||
      nome.startsWith(`${nomeSessaoProducao}.`) ||
      nome === nomeSessaoProducaoLegado ||
      nome.startsWith(`${nomeSessaoProducaoLegado}.`) ||
      /^sb-[^=]+-auth-token(?:\.\d+)?$/.test(nome)
    );
  });
}
