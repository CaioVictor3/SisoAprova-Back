import { cabecalhosSeguranca } from "./src/security/headers.mjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: { agentUpgrade: "security" },
  output: "standalone",
  reactStrictMode: true,
  outputFileTracingIncludes: {
    "/api/docs/*": [
      "./node_modules/swagger-ui-dist/swagger-ui.css",
      "./node_modules/swagger-ui-dist/swagger-ui-bundle.js",
    ],
  },
  async headers() {
    return [
      {
        // /api/docs define CSP própria do Swagger (dev) e aplica cabecalhosSeguranca() diretamente.
        source: "/((?!api/docs(?:/|$)).*)",
        headers: Object.entries(cabecalhosSeguranca()).map(([key, value]) => ({ key, value })),
      },
    ];
  },
  async redirects() {
    return [
      { source: "/swagger", destination: "/api/docs", permanent: false },
      { source: "/swagger/index.html", destination: "/api/docs", permanent: false },
    ];
  },
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
