import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { ctEqual } from "./crypto";
import { logEvent } from "./queue";

const MIN = 60_000;

/** Fixed-window counter in D1. Returns the count after incrementing. */
export async function bump(db: D1Database, key: string, windowMs: number): Promise<number> {
  const t = Date.now();
  const r = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END
       RETURNING count`,
    )
    .bind(key, t, t - windowMs, t - windowMs, t)
    .first<{ count: number }>();
  return r?.count ?? 1;
}

export async function peek(db: D1Database, key: string, windowMs: number): Promise<number> {
  const r = await db.prepare("SELECT count, window_start FROM rate_limits WHERE key = ?").bind(key).first<{ count: number; window_start: number }>();
  if (!r || r.window_start < Date.now() - windowMs) return 0;
  return r.count;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(d: { clientName: string; redirectHost?: string; clientDomain?: string }, handle: string, error?: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Muse Bridge Access</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e3de;--accent:#2754c5;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ececea;--muted:#9a9a94;--card:#1e1e1c;--line:#33332f;--accent:#7ea2ff;--err:#ff8a80}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;max-width:420px;width:100%}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 12px;color:var(--muted)}b{color:var(--fg)}
input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg);font:inherit}
button{margin-top:12px;width:100%;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
.err{color:var(--err)}
</style></head><body><main>
<h1>Allow access to the job bridge?</h1>
<p><b>${esc(d.clientName)}</b>${d.clientDomain ? ` (${esc(d.clientDomain)})` : ""} wants to use your Muse bridge.</p>
<p>After approval you will be sent to <b>${esc(d.redirectHost ?? "unknown")}</b>. Only continue if that is Muse.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(handle)}">
<label for="p">Bridge passphrase</label>
<input id="p" name="passphrase" type="password" autocomplete="current-password" required>
<button type="submit" name="decision" value="approve">Approve</button>
</form></main></body></html>`;
}

function text(body: string, status: number) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

const consentCache = new Map<string, { clientName: string; redirectHost?: string; clientDomain?: string }>();

export async function handleAuthorize(req: Request, env: Env): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  try {
    if (req.method === "GET") {
      const ar = await oauth.parseAuthRequest(req);
      const d = await oauth.describeConsent(ar);
      const allowed = (env.ALLOWED_REDIRECT_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const redirectHost = d.redirectIsLoopback ? `${d.redirectHost} (a program on this computer)` : d.redirectHost;
      if (allowed.length && !allowed.includes(d.redirectHost.toLowerCase())) {
        await logEvent(env.DB, "oauth", "redirect_host_rejected", null, { redirectHost: d.redirectHost });
        return text("This client is not allowed.", 403);
      }
      const c = await oauth.beginConsent(ar);
      const info = { clientName: d.clientName, redirectHost, clientDomain: d.clientDomain };
      consentCache.set(c.handle, info);
      c.headers.set("Content-Type", "text/html; charset=utf-8");
      c.headers.set("Referrer-Policy", "no-referrer");
      c.headers.set("Cache-Control", "no-store");
      return new Response(page(info, c.handle), { headers: c.headers });
    }
    if (req.method !== "POST") return text("Method not allowed", 405);

    if ((await peek(env.DB, "auth_fail_global", 24 * 60 * MIN)) >= 20) return text("Locked. The guardian must unlock the bridge.", 429);
    if ((await peek(env.DB, `auth_fail_ip:${ip}`, 10 * MIN)) >= 5) return text("Too many attempts. Wait 10 minutes.", 429);

    const f = await req.formData();
    const handle = String(f.get("handle") ?? "");
    const pass = String(f.get("passphrase") ?? "");
    if (!env.BRIDGE_PASSPHRASE || !(await ctEqual(pass, env.BRIDGE_PASSPHRASE))) {
      await bump(env.DB, `auth_fail_ip:${ip}`, 10 * MIN);
      await bump(env.DB, "auth_fail_global", 24 * 60 * MIN);
      await logEvent(env.DB, "oauth", "passphrase_failed", null, { ip });
      const info = consentCache.get(handle) ?? { clientName: "Unknown client" };
      // handle is single-use only once approved; re-render with the same handle
      const h = new Headers({ "Content-Type": "text/html; charset=utf-8", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", "Cache-Control": "no-store" });
      return new Response(page(info, handle, "Wrong passphrase."), { status: 401, headers: h });
    }
    const ok = await oauth.approveConsent(req, handle, { scope: ["mcp"] });
    consentCache.delete(handle);
    const { redirectTo } = await oauth.completeAuthorization({
      request: ok.request,
      userId: "applicant",
      metadata: { approved_at: Date.now() },
      scope: ok.request.scope,
      props: { userId: "applicant" },
    });
    await logEvent(env.DB, "oauth", "authorized", null, { client: ok.request.clientId });
    ok.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: ok.headers });
  } catch (e) {
    if (e instanceof AuthorizationError) {
      if (e.redirectTo) return Response.redirect(e.redirectTo, 302);
      return text(e.description || "Invalid authorization request", 400);
    }
    throw e;
  }
}
