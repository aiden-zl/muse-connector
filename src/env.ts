import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  BRIDGE_PASSPHRASE: string;
  ADMIN_TOKEN: string;
  KEYCHAIN_TOKEN: string;
  CRED_KEY: string;
  MCP_RESOURCE: string;
  ALLOWED_ORIGIN_HOSTNAMES?: string;
  ALLOWED_REDIRECT_HOSTS?: string;
}

export interface NextAction {
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

export type ToolResult = Record<string, unknown> & { ok: boolean; next_action: NextAction | null };

export function na(tool: string, args: Record<string, unknown>, why: string): NextAction {
  return { tool, args, why };
}

export const END_SESSION: NextAction = { tool: "none", args: {}, why: "Stop calling tools and end this session." };
