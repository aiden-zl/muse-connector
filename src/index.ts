import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env as globalEnv } from "cloudflare:workers";
import type { Env } from "./env";
import { buildServer } from "./mcp";
import { handleAuthorize } from "./auth";
import { handleAdmin } from "./admin";

const genv = globalEnv as unknown as Env;
const originHosts = (genv.ALLOWED_ORIGIN_HOSTNAMES ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const defaultHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/authorize") return handleAuthorize(req, env);
    if (path.startsWith("/admin/") || path === "/admin") return handleAdmin(req, env);
    if (path === "/health") return new Response("ok", { headers: { "Cache-Control": "no-store" } });
    if (path === "/") return new Response("Muse bridge. Add <origin>/mcp as a custom connector in Muse.", { headers: { "Content-Type": "text/plain" } });
    return new Response("Not found", { status: 404 });
  },
};

const apiHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const mcp = createMcpHandler(() => buildServer(env), originHosts.length ? { allowedOriginHostnames: originHosts } : {});
    const res = await mcp(req, env, ctx);
    if (res.status === 403) console.warn("mcp request refused; Origin:", req.headers.get("Origin"));
    return res;
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp"],
  requiredScopes: ["mcp"],
  resourceMetadata: { resource: genv.MCP_RESOURCE },
  refreshTokenIdleTTL: 30 * 86400,
});
