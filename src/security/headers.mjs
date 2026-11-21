export function cabecalhosSeguranca(producao = process.env.NODE_ENV === "production") {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Content-Security-Policy":
      "default-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
    ...(producao ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  };
}
/** @param {Response} resposta */
export function aplicarCabecalhos(resposta) {
  for (const [nome, valor] of Object.entries(cabecalhosSeguranca()))
    resposta.headers.set(nome, valor);
  return resposta;
}
export const redacaoLogs = {
  paths: [
    "authorization",
    "cookie",
    "password",
    "senha",
    "senhaAtual",
    "token",
    "accessToken",
    "refreshToken",
    "cpf",
    "email",
    "*.authorization",
    "*.cookie",
    "*.password",
    "*.senha",
    "*.senhaAtual",
    "*.token",
    "*.accessToken",
    "*.refreshToken",
    "*.cpf",
    "*.email",
    "req.headers.authorization",
    "req.headers.cookie",
  ],
  censor: "[REDACTED]",
};
